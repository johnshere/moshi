# P2-12 社区摘要施工记录

- 状态：DONE（代码/单测/lint 通过；`pnpm typecheck` 被其它并发任务 WIP 文件阻塞，见 §验收）
- 任务：task-1（owner: lifecycle）
- 开工：2026-11-04 21:37
- 完成：2026-11-04 21:46
- 依据：任务台账 §4 P2-12（L941-947）；详设 §8.3.3（L2645-2656）；概设 §4.5（摘要只做入口不做答案）
- 上一节点：P2-11（社区划分与稳定性，已 DONE）

## 开工核查

- `community_summary` 表（001_init.sql L152-161，PK `(community_id, scope)`）与读取方法 `listTopicCandidates`/`listTopSummaries` 已存在，但**全仓无任何写入方**——P2-12 补写侧。
- `migrations/002_schema_rev.sql` 的 `trg_rev_community_ins/upd/del` 会在 `community_summary` 每次 INSERT/UPDATE/DELETE 后把 `meta.schema_rev` +1；而 `src/core/read/search.ts` 的 `buildGlobalPack` 新鲜度判据是 `source_rev >= schemaRev(db)`。→ **若 source_rev 写"写前 rev"，写完 rev 反而变大，摘要会全部被判陈旧、`summary_missing` 恒真**（Lead m00094 已提前指出）。
- `fact` 的 `community_id` 回写不在 002 的 fact UPDATE 白名单内，不推 rev；故一次 runCommunityOnce 的 rev 增量恰为摘要写入行数。
- `lint:lifecycle` 禁 `src/core`、`src/app` 持 `db` 句柄或拼 SQL → 摘要拼接必须是纯函数，SQL 留在 `infra/sqlite`。
- 摘要只进 `topic_hint`/全局主题清单（概设 §4.5）：不给 fact/graph/子图/GAT 增加字段。

## 实现

### 纯函数（`src/core/lifecycle/community-summary.ts`，新建）

- 导出 `SummaryFact`、`CommunitySummaryDraft`、`BuildSummaryOptions`、`fallbackSummaryLabel()`、`rankSummaryFacts()`、`buildCommunitySummaries()`，常量 `SUMMARY_DEFAULT_SCOPE='global'`、`SUMMARY_TOP_FACTS=10`、`SUMMARY_BULLETS=3`、`SUMMARY_CONTENT_MAX=80`。
- 分组口径：`(communityId, scope)`；跳过 `communityId=null` 的事实；默认只生成 `global`，`options.scopes` 可显式扩展（按 scope 分组生成，同一社区多 scope 多行）。
- 排序：`importance × confidence` 降序，平局 `fact.id` 升序（确定性）。
- **label**：组内出现次数最多的实体（有 `entityId` 时以 entityId 作身份键，否则用 `entityName`）；频次平局按名称升序、再按身份键升序；无实体则 `主题 #<community_id>`（`fallbackSummaryLabel`）。
- **summary** 严格按详设 §8.3.3：`{label}：{n} 条事实，覆盖 {m} 个实体。要点：①{content1} ②{content2} ③{content3}`；`n` = 组内全部事实数，`m` = 去重实体数，要点取排好序的 top-10 前 3 条；content 先折叠空白（`\s+` → 空格 + trim）再按 code point 截断到 `SUMMARY_CONTENT_MAX`（超出取 79 字符 + `…`），避免超长。
- 输出按 `(communityId, scope)` 升序，逐字节确定。

### infra（`src/infra/sqlite/communityRepo.ts`，追加，不改已有签名）

- `loadSummaryFacts(db): SummaryFact[]`：一次 SQL 取 `active/disputed` 事实（`community_id, scope, content, importance, confidence`），实体 id/名用 `json_extract(attrs,'$.frozen.subject.entity_id')`；名称 `COALESCE(NULLIF(entity.canonical_name,''), NULLIF(json_extract(attrs,'$.frozen.subject.name'),''))`，`LEFT JOIN entity`；`ORDER BY f.community_id, f.id`。
- `writeCommunitySummaries(db, rows, now): number`：
  - 空数组直接返回 0（不开事务、不推 rev）；
  - 单事务内 `const revAfter = schemaRev(db) + rows.length;`，所有行 `source_rev=revAfter`、`derived_at=now`；
  - `INSERT ... ON CONFLICT(community_id, scope) DO UPDATE SET label/summary/fact_count/derived_at/source_rev`（重跑幂等，不产生孤儿行）。

### runner（`src/app/communityRunner.ts`，修改）

- `runCommunityOnce` 在划分写回后：`loadSummaryFacts(db)` → 用本次 `assignment.get(fact.id)` 覆盖 `communityId`（未归属事实保持 null，dryRun 也能统计）→ `buildCommunitySummaries` → `dryRun ? drafts.length : writeCommunitySummaries(db, drafts, nowIso())`。
- `CommunityRunResult` 新增 `summaries: number`（向后兼容，原有字段不变）。
- daemon 脏检查改为**跑完后**记录 `state.lastRev = schemaRev(db)`：否则摘要写入推高的 rev 会让下一轮被判脏、空转重算（每次运行都重写摘要并再推 rev）。
- 日志新增 `summaries` 字段；通知文案在有摘要更新时也发「社区划分与摘要已更新」。
- 生产接线：**无需 Lead 加任何一行**——摘要生成嵌在既有 `runCommunityOnce` 内，`startCommunityRunner`/`db community` CLI 自动带上。

### 测试（`tests/unit/community-summary.test.ts`，新建，11 例）

- 纯函数 6 例：top-10 截断与 `importance×confidence` 排序 + 平局 id 升序；label 最高频/频次平局/无实体回退；scope 分组（默认只 global、显式 scopes 才多行）；输入乱序逐字节一致；`communityId=null` 不生成；content 空白折叠 + 截断加 `…`。
- 写库 5 例：`source_rev = 写完后的 schema_rev` + 重跑 UPSERT 仍新鲜（`source_rev >= schemaRev` 逐行断言）；5 个社区 → 全局查询 5 条主题 + `moshi://topic/<label>` 下钻指针；dryRun 只算不落库、空库不写不推 rev；`loadSummaryFacts` 只取 active/disputed 且 canonical_name 优先；空数组不写库不推 rev。

## 验收

实际命令与输出（本机 2026-11-04 21:42–21:46）：

```
$ pnpm vitest run tests/unit/community-summary.test.ts
 ✓ tests/unit/community-summary.test.ts (11 tests) 204ms
 Test Files  1 passed (1)
      Tests  11 passed (11)

$ pnpm vitest run tests/unit/community.test.ts
 ✓ tests/unit/community.test.ts (13 tests) 6448ms
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

（重点：P2-11 的 daemon 判脏用例仍通过——无变化第二次 `runOnce() === null`，摘要写入不会自触发空转。）

```
$ pnpm lint:lifecycle
✔ 生命周期写路径检查通过（93 个文件）
$ pnpm lint:writes
lint:writes OK — 93 个文件，无白名单外写调用
```

全局查询 5 条主题 + 下钻指针（可复现测试即上文件「5 个社区」用例；以下为同一数据形态的脚本实跑输出）：

```
runCommunityOnce: {"nodes":20,"edges":30,"communities":5,"wrote":20,"summaries":5,"rev":1}
community_summary rows: [
 {"community_id":1,"scope":"global","label":"pkg-f-a0","fact_count":4,"derived_at":"2026-11-04T13:43:59.590Z","source_rev":55},
 {"community_id":2,"scope":"global","label":"pkg-f-b0","fact_count":4,...},
 {"community_id":3,"scope":"global","label":"pkg-f-c0","fact_count":4,...},
 {"community_id":4,"scope":"global","label":"pkg-f-d0","fact_count":4,...},
 {"community_id":5,"scope":"global","label":"pkg-f-e0","fact_count":4,...}]
route: global | degraded: [] | coverage: full
numbered_list:
  [T1] (4 条事实，2026-11-04 起) pkg-f-a0：4 条事实，覆盖 4 个实体。要点：①node-f-a0 version = f-a0 ②node-f-a1 version = f-a1 ③node-f-a2 version = f-a2
  [T2] ... pkg-f-b0：... ③node-f-b2 version = f-b2
  [T3] ... pkg-f-c0：...
  [T4] ... pkg-f-d0：...
  [T5] ... pkg-f-e0：...
topic_hint: {"community_id":1,"label":"pkg-f-a0","fact_count":4,"derived_at":"2026-11-04T13:43:59.590Z","uri":"moshi://topic/pkg-f-a0"}
```

`pnpm typecheck` 当前**不通过，但错误全部在其它并发任务的 WIP 文件**，与 P2-12 无关：

```
src/core/write/harvest.ts(309,3): error TS2322: Type '{ outcome: string; factId: string; entityId: string; identity: IdentityState; conflict: ConflictResult; }' is not assignable to type 'UpsertResult'.
  Types of property 'outcome' are incompatible.
    Type 'string' is not assignable to type 'UpsertOutcome'.
```

（开工时同一命令报的是 `src/core/read/search.ts` 5 条 TS6133 未用导入，随并发任务推进已变化；我的三个改动文件均无 tsc 报错。需 Lead 等 P2-14/P2-15 落定后统一复跑 `pnpm typecheck` / `verify` / `build`。）

## 决策与遗留

- **D-P2-12-1（source_rev 预估）**：摘要写入会触发 002 触发器把 `schema_rev` 每行 +1，且 `buildGlobalPack` 判据是 `source_rev >= schemaRev`。故在写事务内按 `revAfter = schemaRev(db) + rows.length` 给全部行填 `source_rev`；空数组不写不推。已写单测锁定「写完 `source_rev == schemaRev`」。请 Lead 归并台账 §5.2 编号。
- **D-P2-12-2（摘要口径）**：n = 社区内全部 active/disputed 事实数（非 top-10），m = 去重实体数；要点只取排序后前 3 条且 content 折叠空白、截断 80 code points（避免超长/换行破坏 numbered_list 单行）。label 频次平局按实体名升序，保证确定性。
- **D-P2-12-3（daemon 判脏时点）**：`lastRev` 改为本轮跑完后记录（覆盖摘要写入推高的 rev），否则摘要自触发导致每 5 分钟空转全量重算。已由 P2-11 判脏用例覆盖。
- **遗留 1**：社区 id 变更后，旧 `community_summary` 行不会被删除；因 `source_rev` 落后于当前 rev，`buildGlobalPack` 的新鲜度过滤会把它们剔出 numbered_list，但表内会留陈旧行。是否在 `writeCommunitySummaries` 或重建流程里清理不在本次 drafts 中的 `(community_id, scope)`，建议 Lead 记 §5.3 由后续节点决定（本次不改，避免误删其它 scope 摘要）。
- **遗留 2**：`scope` 分组能力已在纯函数与写库层就绪，但当前 runner 只生成 `global`（事实表默认 scope 即 global）；会话/项目 scope 的摘要触发入口待后续节点。
- 未新增 TODO/FIXME；未改台账、未改 `src/app/cli/index.ts`、`src/app/http/server.ts`、`src/app/main.ts`。
