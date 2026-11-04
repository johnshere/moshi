# P2-19A-04 队列单条决策 + batch archive + 三队列游标分页 + inbox 逐行处理 UI

状态：DONE
开工：2026-11-04 22:29
完成：2026-11-04 22:39
依据：台账 §4 P2-19-A（P2-19A-04）、概设 §8.3「三队列单条决策」与 §8.1 深链、详设 §4.3 REST 清单（`POST /api/queues/:kind/decide`、batch `action: invalidate|archive|prune`）、§10.6 队列语义。
上一节点：task-13（P2-19A 非 UI 缺口包 A）已 DONE。

## 开工核查

- `src/infra/sqlite/` 无 `aliasRepo.ts`（29 个文件）；alias 相关 SQL 原本只在 `inboxRepo.ts` 的队列读取里 → 单条决策与撤销都落在 `inboxRepo.ts`，不新建 repo 文件。
- audit 表 `tbl` 枚举（`appendAudit` 的入参类型）不含 `alias` → alias 行变更记在 `tbl:'entity'`、`field:'alias'`，`row_id=entity_id`。
- `src/app/http/server.ts` 已注册 `batchRoutes`（prefix `/api/facts`）与 `queueRoutes`（prefix `/api/queues`）→ 新增 `POST /ops/:op_id/undo` 落在 `/api/facts/ops/:op_id/undo`，**无需 Lead 接线**。
- 撤销 op 存储不能改成 `WeakMap<db, …>`：`tests/unit/batch-http.test.ts` 断言同一 db 的两个 app 实例 op 不互通（app1 的 op 在 app2 undo 必须 404）。

## 实现

### 1. 仓储层 `src/infra/sqlite/inboxRepo.ts`

- 三队列游标（keyset）：
  - `ResolveCursor {confidence, alias, entityId}` / `LowConfCursor {importance, id}` / `PruneCursor {strength, id}`（均为导出类型）。
  - `ResolveQueueRow` 增 `id`：`resolveRowId(alias, entityId)` = base64url(JSON `[alias, entity_id]`)，`parseResolveRowId` 非法/空 → `null`。
  - `listResolveQueue`：`ORDER BY confidence DESC, alias ASC, entity_id ASC`，keyset 条件 `confidence < ? OR (confidence = ? AND (alias > ? OR (alias = ? AND entity_id > ?)))`。
  - `listLowConfQueue`：`ORDER BY importance DESC, id ASC`，keyset `importance < ? OR (importance = ? AND id > ?)`。
  - `listPruneQueue`：`ORDER BY strength ASC, id ASC`，keyset `strength > ? OR (strength = ? AND id > ?)`，保留 strength<0.15、60 天未访问、`valid_to IS NULL`。
- 批量归档（与失效/剪枝并列，走同一 op 快照）：`ArchiveSnapshot {id, epistemicStatus, archivedAt}`、`previewArchive`（facts/edges/topics 计数 + `invalidated_by_cascade` 恒 0 + sample 5 条）、`archiveMany`（只改 `epistemic_status='archived'` + `updated_at`，不删行、不删边、不动 valid_to/strength，逐条 audit `ui_batch_archive`）、`restoreArchived`（CAS `epistemic_status='archived' AND updated_at=archivedAt`，audit `ui_batch_undo`）。
- 单条裁决：`getAliasRow`、`decideAliasMerge/Keep/Reject`、`restoreAliases`；`requireActiveFact`（不存在 404 `fact_not_found`；非 active/disputed 或已收口 400 `fact_not_active`）、`decideLowConfPromote`（`setConfidence` 抬到 max(conf, 0.6)、source=human）、`decideLowConfInvalidate`（复用 `invalidateMany`）。
- 决策记录：merge/keep/reject 都写 audit（source `ui_alias_merge|ui_alias_keep|ui_alias_reject`）。

### 2. 路由 `src/app/http/routes/batch.ts`

- `BatchAction = 'invalidate' | 'prune' | 'archive'`；`BatchOpRecord` 判别联合扩为四种 action（含 `alias_merge`）。
- op 存储抽成 `opStoreFor(host: {server})`：模块级 `WeakMap<app.server, Map<opId, record>>` —— 同一 app 实例的 batch 与 queues 插件共享，不同实例天然隔离（保持原测试语义）。
- 新增 `POST /ops/:op_id/undo`（完整路径 `/api/facts/ops/:op_id/undo`），撤销分派 restorePruned/restoreArchived/restoreAliases/restoreMany；batch 自带 `/batch/undo` 行为不变。
- `previewFor` 三路分发；`/batch` 的 archive 与 prune 一样不跑 `reconcileDerivedForFacts`（30s 撤销窗口内不让派生点被永久收口），invalidate 保持原对账逻辑。

### 3. 路由 `src/app/http/routes/queues.ts`

- `POST /:kind/decide`（kind ∈ resolve|lowconf）：body `{id, action}`；成功返回 `{ok, kind, action, before, after, op_id?, undo_deadline?}`；merge/invalidate 带 op（30s 可撤销），keep/reject/promote 无 op。
- 三队列 GET 支持 `?cursor=`，响应统一 `{items, next_cursor}`（prune 另带 `thresholds`）；`limit+1` 探测，末页 `next_cursor=null`；非法 cursor（非串、base64/JSON 坏、字段类型不对）→ 400 `E_INPUT` reason `cursor_invalid`。
- 错误口径：非法 kind → 400 `queue_kind_invalid`；缺失/非法 action → 400 `action_invalid`；row id 非法 → 400 `id_invalid`；行不存在 → 404 `alias_not_found` / `fact_not_found`。
- 注：`newId('decide')` 不合法（`IdKind` 无 decide），op_id 用 `newId('batch')`（前缀 `b_`）。

### 4. UI `src/ui/inbox/**`

- `api.ts`：`QueuePage<T>`、`DecideResult`、`decideQueue(kind, id, action)`、`UndoAction = BatchAction | 'alias_merge'`、`PruneQueueResult`。
- `InboxPage.tsx`：resolve 行「并入 / 保留 / 拒绝」，lowconf 行「抬升 / 失效」；行内按钮 busy 态；成功后刷新对应队列并把 op 挂到撤销条（复用 `/api/facts/batch/undo`）；通知文案按动作区分；TABS hint 同步。
- `BatchPanel.tsx`：`undoAction` 扩为 `UndoAction`，`COPY` 增 `alias_merge`（并入的撤销说明 = 还原 alias 的 source/confidence）。
- 未做视觉重构（P2-19-B 统一），只沿用现有 inline 样式与 BatchPanel。

## 验收

命令与真实输出：

```
pnpm vitest run tests/unit/queue-decide.test.ts tests/unit/queues.test.ts tests/unit/batch-http.test.ts tests/unit/inbox.test.ts
 ✓ tests/unit/inbox.test.ts (19 tests) 465ms
 ✓ tests/unit/batch-http.test.ts (27 tests) 947ms
 ✓ tests/unit/queue-decide.test.ts (9 tests) 388ms
 ✓ tests/unit/queues.test.ts (7 tests) 301ms
 Test Files  4 passed (4)
      Tests  62 passed (62)

pnpm typecheck      # 通过（无输出）
pnpm typecheck:ui   # 通过（无输出）
pnpm lint:lifecycle # ✔ 生命周期写路径检查通过（107 个文件）
pnpm lint:writes    # lint:writes OK — 107 个文件，无白名单外写调用
```

真实 `app.inject` 证据（临时脚本已删）：

```
GET /api/queues/resolve → 200 {"items":[{"id":"WyJsZWZ0LXBhZCIs...","alias":"left-pad","entity_id":"en_01m6kfzn6j890gasjqaqjqqhnp","canonical_name":"pkg-canonical","confidence":0.8},{"id":"...","alias":"left-pad","entity_id":"en_01m6kfzn6mnwsr7knb3ep5b7na","canonical_name":"pkg-other","confidence":0.7}],"next_cursor":null}
POST /api/queues/resolve/decide merge → 200 {"ok":true,"kind":"resolve","action":"merge","before":{"alias":"left-pad","entity_id":"en_...","source":"vector","confidence":0.8},"after":{"alias":"left-pad","entity_id":"en_...","source":"human","confidence":1},"op_id":"b_01m6kfzn9jt53agjcgj01mc29m","undo_deadline":"2026-11-04T14:39:36.547Z"}
GET /api/queues/resolve after merge → 200 {"items":[],"next_cursor":null}
POST /api/queues/lowconf/decide promote → 200 {"ok":true,"kind":"lowconf","action":"promote","before":{"confidence":0.3,"epistemic_status":"active","valid_to":null},"after":{"confidence":0.6,"epistemic_status":"active","valid_to":null}}
POST /api/queues/lowconf/decide invalidate → 200 {"ok":true,"kind":"lowconf","action":"invalidate","before":{"confidence":0.9,"epistemic_status":"active","valid_to":null},"after":{"confidence":0.9,"epistemic_status":"invalidated","valid_to":"2026-11-04T14:39:06.552Z"},"op_id":"b_01m6kfzn9qha9sfd1zsbvxy9vf","undo_deadline":"2026-11-04T14:39:36.553Z"}
POST /api/facts/batch archive → 200 {"op_id":"b_01m6kfzn9tznvc5dbnp15yx1rw","facts":1,"edges":0,"topics":0,"invalidated_by_cascade":0,"undo_deadline":"2026-11-04T14:39:36.555Z"}
GET /api/queues/lowconf after decide → 200 {"items":[],"next_cursor":null}
```

关键分支单测：

- `queue-decide.test.ts`（9 例）：merge 收口 + `/api/facts/ops/:opId/undo` restored=2 还原；keep 0.95 / reject 0；promote 0.3→0.6 且 confidence_source=human；invalidate 软删 + 撤销回 active；非法 id/未知行/非法动作/非法 kind/缺 action；archived 再裁决 400；二次撤销 404。
- `queues.test.ts`（7 例）：repo 三队列 keyset 翻页不重不漏（按各自排序键）；HTTP next_cursor 串联三页、末页 null；prune thresholds；无 cursor 兼容；非法/数组/形状错 cursor 400。
- `batch-http.test.ts`（27 例，新增 archive 4 例）：preview 四计数 + 不写库；执行 archive 后 valid_to/strength 原样、边不动；不跑派生点对账；unknown_ids 整批拒；二次撤销 404。
- `inbox.test.ts`（19 例）：既有用例适配 resolve 行新增的 `id` 字段。

## 决策与遗留

- D-P2-19A-04-1：队列行 `id` 用不透明编码（base64url(JSON `[alias,entity_id]`)），不把 alias 原文直接塞进 URL/body；非法编码一律 400 `id_invalid`。
- D-P2-19A-04-2：op 存储用 `WeakMap<app.server, Map>` 而非插件闭包变量——batch 与 queues 两个独立插件需要共享同一份 op；按 server 隔离保持「同 db 不同 app 实例不互通」的既有测试断言。
- D-P2-19A-04-3：alias 变更的 audit 记 `tbl:'entity'` + `field:'alias'`（audit 表 tbl 枚举无 alias，改枚举需迁移，本卡禁改 migrations）。
- D-P2-19A-04-4：archive 与 prune 都不跑 `reconcileDerivedForFacts`——否则 30s 撤销窗口内派生点被永久收口，撤销无法救回；读侧 adjudicate 已在消费端收口。
- I-1：resolve 的「并入」语义为「实体合并候选确认」——把 alias 收口到目标实体并把 competing vector 行置为 human/0；真正合并实体（`merged_into`）仍未实现，归 P2-19A-09（反向对账清单已列）。
- I-2：`/api/queues/:kind/decide` 的 keep/reject/promote 单条动作不写 op（无 30s 撤销），只有 merge/invalidate 可撤销——与概设 §8.3「单条决策 + 批量硬规矩（30s 撤销）」对齐为「破坏性动作才需撤销」。
- I-3：UI 撤销条对 `alias_merge` 复用 batch undo 文案表；P2-19-B 视觉统一时再调。
