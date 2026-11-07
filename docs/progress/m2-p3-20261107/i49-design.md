# I-49（P3-A9）adjudication.outcome 写入方 — 设计

状态：设计已定，待实施
归属：新增前置小节点 P3-A9；解决 I-49，解除 P3-05/P3-09 的 outcome 依赖。

## 问题

`adjudicationRepo.resolveAdjudication()` 在 src/tools 里零调用；`openAdjudicationOnce()` 只开裁决、从不回填 `upheld/overturned`。详设 §2.9/§7.4 把 `outcome` 当作 GAT 唯一非循环标签，但没有生产者。I-51 还指出：当前 dev/合成库只有 `temporal_invalidate`，没有 `mutex_win`。

## 语义

`outcome` 表示“规则在 t 时刻的裁决，在 t' 时刻是否被新观测推翻”。只由**写入侧的新观测**回填，读取侧仍只开裁决，不写 outcome。

- `mutex_win`：`fact_ids[0]=winner`、`[1]=loser`，winner 由读取时 `confidence×strength` 选出。
- `temporal_invalidate`：`fact_ids[0]=旧值`、`[1]=新值`；规则“保留新值”的 favored = `[1]`。
- `dependency_hold`：当前无生产者，不处理。

“favored fact” 被**再次观测**（case B refresh）→ `upheld`；“favored fact” 被**后续新值失效**（case D invalidation）→ `overturned`。非 favored 的刷新/失效不写 outcome（证据不足，保持 open）。

## 改动

1. `src/infra/sqlite/adjudicationRepo.ts`
   - `openAdjudicationOnce`：去重仍用排序后的 `fact_ids`；**插入时保留传入顺序**（mutex 的 winner/loser 顺序不能丢）。更新注释。
   - `findMutexWin`：兼容原序与排序两种存储（查两个 LIKE 模式），保证归档/测试不回归。
   - 新增 `listOpenAdjudicationsForFact(db, factId)`：`outcome IS NULL` 且 `fact_ids LIKE '%"<id>"%'`，解析 `factIds` 返回 `{id, kind, factIds}`；调用方按 favored 下标过滤。
   - 新增 `favoredFactId(row)`（或等价 helper）：`mutex_win → factIds[0]`，`temporal_invalidate → factIds[1]`，其他 null。
2. `src/core/write/conflict.ts`
   - 新增 `resolveOutcomesForRefresh(db, fact, ts)`：遍历该 fact 的 open 裁决，若 fact 是 favored → `resolveAdjudication(..., 'upheld', fact.id, ts)`。
   - 新增 `resolveOutcomesForInvalidation(db, target, invalidatedIds, ts)`：对每个被失效 fact，若它是 favored → `resolveAdjudication(..., 'overturned', target.id, target.validAt)`。
   - 只对 `outcome IS NULL` 调用；`resolveAdjudication` 本身幂等。
3. `src/core/write/harvest.ts`
   - case B（完全重复 refresh）：在 refresh/touch 后调用 `resolveOutcomesForRefresh`。
   - case D（新值 single-valued）：`applyConflictPolicy` 返回后，用 `conflict.invalidated` 调 `resolveOutcomesForInvalidation`。
   - case C（复活）：新 fact 建 supersedes 后，可按“favored 复活”写 `upheld`，evidence=新 fact.id；若不改也允许，但测试需固定。
4. `src/core/read/adjudicate.ts`：不改。读取侧仍只开 `mutex_win`；若后续需要，可在 `openAdjudicationOnce` 调用处保持原序。
5. 测试
   - 构造两条同 canonicalKey、single-valued 的 active facts（`f_hi` 高置信、`f_lo` 低置信），调 `adjudicate` 开 mutex_win；再 upsert 与 `f_hi` 同值的观测 → 断言 `upheld`。
   - 再 upsert 第三个不同值（single-valued）→ `f_hi`/`f_lo` 被失效，断言 `overturned`、evidence=新 fact.id、只写一次（再跑不变）。
   - `temporal_invalidate`：直接 `openAdjudication({kind:'temporal_invalidate',factIds:[old,new]})`；refresh new → upheld；upsert 第三值使 new 失效 → overturned。
   - 非 favored refresh 不写；已 resolved 不重复；`outcome_at/evidence` 正确。
   - `openAdjudicationOnce` 顺序保留 + `findMutexWin` 两种顺序兼容。

## 边界

- 不做 schema migration；不改 `adjudication` 列。
- 不改读取期裁决/flags/EVAL 门禁。
- 不伪造 `mutex_win`；测试用 `adjudicate` 真实产生。
- 旧库中已存在的排序 `mutex_win`（若有）因顺序丢失无法判定 favored，保持 open，不猜。
