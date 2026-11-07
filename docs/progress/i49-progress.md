# I-49（P3-A9）进度

状态：DONE（独立复验 PASS，AC-1..AC-7 全过；2026-11-07 16:23）
实施：impl-i49
验收：verify-i49

## 已完成

- 设计 `docs/progress/m2-p3-20261107/i49-design.md`
- 验收 `docs/progress/m2-p3-20261107/i49-acceptance.md`
- 实施：`adjudication.outcome` 的真实写入方（写入侧新观测回填，读取侧仍只开裁决）
- 返工 R1：legacy `mutex_win`（排序 JSON、顺序已丢）不再被误判 favored

## 改动文件（diff 范围）

- `src/infra/sqlite/adjudicationRepo.ts`
  - `openAdjudicationOnce`：去重仍用排序集合键，**落库保留传入顺序**（mutex 的 winner/loser 顺序是判 favored 的唯一依据）。
  - `findMutexWin`：原序 + 反向两个 `LIKE`，兼容 I-49 前后两种 `fact_ids` 存储口径；`LIKE` 元字符统一 `ESCAPE '\'`。
  - 新增 `listOpenAdjudicationsForFact(db, factId)`：`outcome IS NULL` + `fact_ids` 按字面量包含该 fact（`_` 已转义），返回 `{id, kind, factIds, decidedBy}`。
  - 新增 `favoredFactId(row)`：
    - `mutex_win`：仅当 `decidedBy === MUTEX_FAVORED_DECIDED_BY`（`mutex_by_confidence@2`，落库保序版本）才取 `factIds[0]`；`@1`/legacy 行顺序已丢 → `null`（保持 open，不猜）；`decidedBy` 未提供（旧单测直调）保持原行为。
    - `temporal_invalidate → factIds[1]`；`dependency_hold → null`。
- `src/core/read/adjudicate.ts`（仅规则名版本，不改裁决逻辑/flags）
  - 新写入的 `mutex_win` `decidedBy` 改为 `MUTEX_FAVORED_DECIDED_BY`（`mutex_by_confidence@2`），与 legacy `@1` 区分；代码注释说明原因。
- `src/core/write/conflict.ts`
  - 新增 `resolveOutcomesForRefresh(db, fact, ts)`：open 裁决的 favored 被再次观测 → `upheld`，evidence=favored fact，outcome_at=本次观测 ts。
  - 新增 `resolveOutcomesForInvalidation(db, target, invalidatedIds, ts)`：被失效 fact 是 favored → `overturned`，evidence=`target.id`，outcome_at=`target.validAt`（空串兜底 ts）。
  - 只对 `outcome IS NULL` 写，`resolveAdjudication` 本身幂等。
- `src/core/write/harvest.ts`
  - case B（refresh）后调 `resolveOutcomesForRefresh`。
  - case D（single-valued 新值）`applyConflictPolicy` 后用 `conflict.invalidated` 调 `resolveOutcomesForInvalidation`。
  - case C（复活）**未改**（design 允许），行为由单测固定。
- `tests/unit/adjudicationOutcome.test.ts`（新增，11 个用例）
  - AC-2：真实 `adjudicate` 开 `mutex_win`（断言 `decidedBy=@2`）→ refresh winner `upheld`（evidence/outcome_at 正确，重复刷新不覆盖、不新增裁决行）；single-valued 第三值 → `overturned`（evidence=新 fact、outcome_at=新值 validAt）；loser 刷新不写。
  - **返工 R1**：手工落 legacy `@1` 排序行（stored[0] 放入会被刷新的 fact）→ refresh 不写 `upheld`，随后被 single-valued 新值失效也不写 `overturned`，始终保持 open；`listOpen` 返回 `decidedBy=@1`。
  - AC-3：`temporal_invalidate` `favored=[1]`，refresh 新值 `upheld`、旧值刷新保持 open、第三值失效新值 → `overturned`。
  - AC-4：`openAdjudicationOnce` 保序 + 集合去重（`@2`）；`findMutexWin` 原序/历史排序（含手工落的历史排序行）都命中、temporal 不误判。
  - 边界：`listOpenAdjudicationsForFact` 只取 open 且 `_` 按字面量匹配；`favoredFactId` 各 kind + `@2/@1/legacy/缺省` 版本门控；`dependency_hold` 刷新不写；case C 复活不写 outcome（固定既有行为）。
- `docs/progress/i49-progress.md`（本文件）

## 未改动（按约束）

- 无 schema/migration；`adjudicate.ts` 的互斥判定/排序/flags、EVAL 门禁、sidecar 均未动。
- 未碰并行 P3-00 区域：`docs/详设.md`、`src/domain/edgeFeatures.ts`、`sidecar/tests/`。
- 未 commit / push。

## 测试命令与结果（本机，2026-11-07）

1. 目标单测：`pnpm vitest run tests/unit/adjudicationOutcome.test.ts` → **11/11 通过**。
2. 相关回归：`pnpm vitest run tests/unit/adjudicate.test.ts tests/unit/upsert.test.ts tests/unit/schemaInferRunner.test.ts tests/unit/search.test.ts` → **45/45 通过**。
3. `pnpm verify`（返工后重跑，`pnpm test` 单独跑一遍汇总）：
   - `typecheck` / `typecheck:ui` / `lint:deps` / `lint:lifecycle` / `lint:writes` / `lint:archive` 全绿；
   - 完整 `pnpm test` → **119 文件 / 1456 用例全通过**（含 integration，首轮的 sidecar 超时未复现）；
   - 单跑 `pnpm vitest run tests/unit` → 114 文件 / 1439 用例全通过。
4. 首轮完整 `pnpm verify`（返工前）：1453/1454，唯一失败 `tests/integration/sidecar.test.ts > kill 掉进程后自动重启（重启计数 +1）` 20s 超时；该文件单独重跑 2/2 通过（环境性超时，与 I-49 改动面无关，属并行 P3-00 区域）。返工后完整重跑已全绿。
5. `pnpm build` → 退出码 0（仅 Vite chunk >1200kB 的既有告警）。
6. `git diff --check` → 退出码 0，无空白错误。

## 已知边界

- legacy `mutex_win`（`decided_by='mutex_by_confidence@1'`，I-49 前按排序 JSON 落库）：顺序已丢，写入侧显式不猜 favored → 永久保持 open（不会回填 upheld/overturned）。带顺序的 `@2` 行正常回填。
- `findMutexWin` 用"原序 + 反向"两个 LIKE 覆盖一对事实的两种排列；只服务 pair，不适用于 >2 元裁决（当前 `mutex_win` 恒为 pair）。
- `src/core/read/search.ts:177` 的 evidence `rule` 标签仍写死 `mutex_by_confidence@1`（读取期输出展示字段，非 DB 分组键）；本次按"最小返工、不改读取期"未动，是否同步为 `@2` 待 Lead 决定。
- case C（复活）不写 `upheld`：design 明确允许不改，单测固定该行为；日后若要支持，只需在 case C 加 favored 复活回填并改该用例。
- outcome 只由写入侧 refresh / single-valued invalidation 回填；读取路径不产生/不覆盖 outcome，`dependency_hold` 无 favored 概念、不处理。

## 待办

- 独立复验（verify-i49）
- 台账 §1/§3/§6 更新 + commit（由 Lead 统一处理，子代理不提交）
