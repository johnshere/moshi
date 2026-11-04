# P2-13 淘汰候选与队列施工记录

- 状态：DONE（代码/单测/typecheck/lint 通过；浏览器实测取到 UI 读数，见 §验收）
- 任务：task-2（owner: lifecycle）
- 开工：2026-11-04 21:42
- 完成：2026-11-04 21:56
- 依据：任务台账 §4 P2-13（L949-955）；详设 §8.3.4（L2658-2668，60 天口径）、§10.6（L3057-3090，批量与撤销）；概设 §8.3、§4.5、§5.5.1 第 3 条（自动删是红线）
- 上一节点：P2-07（待办三队列与批量失效，已 DONE）

## 开工核查

- `epistemic_status` 的 CHECK 已含 `pruned`（migrations/001_init.sql L88-90，无需迁移）；`src/core/lifecycle/strength.ts:12` 既有注释即定调「淘汰是软删（pruned），物理删除只走用户显式隐私 purge」。
- 既有 `listPruneQueue` 只有 `strength < 0.15`，**缺 60 天未访问条件**（详设 §8.3.4 要求 `last_access_at IS NULL OR < date('now','-60 day')`）；`/api/queues/prune` 返回 `{items}`。
- 既有批量接口(`src/app/http/routes/batch.ts`)只支持 `action='invalidate'`：`previewInvalidate` / `invalidateMany` / `restoreMany` 均为追加式收口（写 `valid_to` + `invalidated`），不能直接复用作剪枝（剪枝要求行与有效区间保留）。
- UI `/ui/inbox` 的 prune tab 复用失效按钮，文案是「可勾选失效」——与本任务的软删语义不符。
- 读侧已就绪：`graphRepo` VISIBLE 只认 `active/disputed`；`adjudicate`/`evidence` 已把依赖上游 `pruned` 的边标 stale。剪枝不需要（也不应该）在写路径连锁改别的行。

## 实现

### 仓储（`src/infra/sqlite/inboxRepo.ts`）

- `listPruneQueue` SQL 增：`AND (last_access_at IS NULL OR last_access_at < date('now', ?))`（绑定 `'-60 day'`，由 `PRUNE_IDLE_DAYS=60` 生成，避免 60 写两处）；同时显式加 `valid_to IS NULL`（已收口的行不该再进候选）；排序仍 `strength ASC`。
- 新常量 `PRUNE_IDLE_DAYS = 60`；复用既有 `PRUNE_STRENGTH_THRESHOLD = 0.15`。
- 新增 `previewPrune(db, ids): InvalidatePreview`：
  - `facts` 只数 `valid_to IS NULL AND active/disputed`；`edges` 用「任一端命中可剪枝行」口径（与 `previewInvalidate` 一致）；`topics` 按 `community_id` 去重；
  - `invalidatedByCascade` **恒 0**：剪枝是软删，不改 dependents 状态、不跑 reconcile；依赖方由读侧按 `pruned` 收口。若照抄 invalidate 的 cascade 数字会误导用户（其实没有行会被连带改写）；
  - `preview_sample` 最多 5 条、`importance DESC, id ASC`。
- 新增 `PruneSnapshot { id, epistemicStatus, prunedAt }` 与：
  - `pruneMany(db, ids, {opId})`：单事务；只处理 `valid_to IS NULL AND active/disputed`；`UPDATE fact SET epistemic_status='pruned', updated_at=?`，**不动 `valid_to`、不动 `strength`**；`changes=0` 跳过；逐条 audit（`source='ui_batch_prune'`，`reason=op_id`，`before` 记原状态）；返回快照（含原状态与本次 `updated_at`）。
  - `restorePruned(db, snapshots, {opId})`：单事务；`UPDATE ... SET epistemic_status=?, updated_at=? WHERE id=? AND epistemic_status='pruned' AND updated_at=?`（CAS 到本次剪枝写入的 `updated_at`），二次撤销/被别处改写则跳过；逐条 audit（`source='ui_batch_undo'`）；返回实际还原条数。
- 原有 invalidate/restore/preview 路径未改签名与语义。

### HTTP（`src/app/http/routes/queues.ts`、`batch.ts`）

- `/api/queues/prune` 返回增字段 `thresholds: { strength: 0.15, idle_days: 60 }`（判据随包下发，UI 不再抄常量）；`items[].*` 字段不变。
- `batch.ts`：`BatchAction = 'invalidate' | 'prune'`；`OpRecord` 改为按动作的判别联合（撤销不能串动作）；`parseBatchBody` 校验动作，未支持动作（如 `archive`）仍 400 `E_INPUT` + `detail.reason='unsupported_action'`；`/batch/preview` 与 `/batch` 按动作选择 preview/persist；`/batch/undo` 按 `rec.action` 调 `restorePruned` / `restoreMany`。
- 响应字段两动作同形（`op_id/facts/edges/topics/invalidated_by_cascade/undo_deadline`；prune 的 cascade 恒 0），30s 撤销窗口、410 `E_OP_EXPIRED`、二次撤销 404 语义不变。
- prune 分支**不调** `reconcileDerivedForFacts`：派生点一旦被收口（写 `valid_to`）30 秒撤销救不回来，会永久失真；这是与 invalidate 的关键差异。

### UI（`src/ui/inbox/api.ts`、`BatchPanel.tsx`、`InboxPage.tsx`）

- `api.ts`：`BatchAction`、`PruneThresholds`、`PruneQueueResult`；`fetchPruneQueue` 返回 `{items, thresholds}`；`previewInvalidate/submitInvalidate` 合并为 `previewBatch(action, ids)` / `submitBatch(action, ids)`。
- `InboxPage`：prune tab hint 改「strength < 0.15 且 60 天未访问 · 可勾选剪枝」；页面展示服务端下发的实际判据；**动作按选中集判定**——全是淘汰候选才 prune，混入其它来源（跨 tab 勾选）自动退化为 invalidate；`ActiveOp` 记录动作，撤销条文案取自 op 而非当前 tab。
- `BatchPanel`：按 `action` 切换文案与按钮（「确认剪枝（N 条）」/「确认失效（N 条）」）；prune 预览显示「软删：行与有效区间保留」且隐藏 cascade 行（恒 0，显示会误导）；选中态提示剪枝不连锁；撤销条区分「批量剪枝已执行（撤销 = 还原 epistemic_status）」。

### 测试

- `tests/unit/inbox.test.ts`：补 60 天口径用例（从未访问/61 天前入队，最近访问与正好 60 天不入队）。
- `tests/unit/prune.test.ts`（新建，17 例）：60 天与 strength 边界、排序/limit、archived/invalidated/已收口不收；previewPrune 四数与 cascade=0、sample 排序、空/超 200 拒；pruneMany 只改状态（valid_to/strength 原样）、跳过非活跃、audit、不动 edge、剪枝后两个队列消失；restorePruned 还原 active/disputed、CAS 二次=0、撤销后重回队列。
- `tests/unit/batch-http.test.ts`：补 thresholds、preview prune（四计数同形+不写库）、执行 prune 软删+队列消失+撤销还原+二次 404、prune 不跑派生对账、prune 整批拒绝未知 id。

## 验收

实际命令与输出（本机 2026-11-04 21:52–21:55）：

```
$ pnpm vitest run tests/unit/inbox.test.ts tests/unit/batch-http.test.ts tests/unit/prune.test.ts
 ✓ tests/unit/batch-http.test.ts (23 tests) 892ms
 ✓ tests/unit/prune.test.ts (17 tests) 384ms
 ✓ tests/unit/inbox.test.ts (19 tests) 571ms
 Test Files  3 passed (3)
      Tests  59 passed (59)

$ pnpm typecheck
（无输出 = 通过）

$ pnpm typecheck:ui
（无输出 = 通过）

$ pnpm lint:lifecycle
✔ 生命周期写路径检查通过（94 个文件）
$ pnpm lint:writes
lint:writes OK — 94 个文件，无白名单外写调用
```

UI 浏览器验收（`pnpm build:ui` 后用临时 Fastify app 托管 `src/app/ui/dist`，种子库：4 条 strength 0.05–0.12、`last_access_at=NULL` 的淘汰候选 + 2 条低置信 + 1 条健康事实；URL `http://127.0.0.1:53091/ui/inbox`，验完已删除临时脚本与库）：

| 步骤 | 读数（a11y snapshot 原文） |
| --- | --- |
| 打开页面 | `button "淘汰候选（4）"`，低置信（2） |
| 切到淘汰候选 | 4 行，每行 `str 0.05/0.07/0.10/0.12` + `从未访问`；提示「判据来自服务端：strength < 0.15 且 60 天未访问」 |
| 勾选 2 条 | 底栏「已选 2 条事实 将执行「剪枝（软删）」…」 |
| 预览影响 | 「将剪枝 2 条事实、0 条边、0 个主题」「软删：事实行与有效区间都保留，仅标注为 pruned（可撤销）」，按钮「确认剪枝（2 条）」 |
| 确认剪枝 | 通知「已剪枝 2 条事实（软删，可撤销）」；`button "淘汰候选（2）"`；撤销条「批量剪枝已执行 撤销窗口剩余 30 秒 超时后本次剪枝不可再撤销（撤销 = 还原 epistemic_status）」 |
| 撤销 | 通知「已撤销，恢复 2 条事实」；`button "淘汰候选（4）"`，4 行原样回来 |

（剪枝后队列 4→2 直接证明读侧不再返回 `pruned` 行；撤销后 2→4 证明原 `epistemic_status` 被还原而非硬删重建。）

## 决策与遗留

- **D-P2-13-1（剪枝 = 只改状态）**：`pruneMany` 只写 `epistemic_status='pruned'` 与 `updated_at`，保留 `valid_to` 与 `strength`。理由：软删的语义是「不认这条」，有效区间是证据链的一部分；改动它会让撤销无法完整复原。
- **D-P2-13-2（prune 不连锁）**：不跑 `reconcileDerivedForFacts`，`previewPrune.invalidatedByCascade=0`。理由：派生点收口写 `valid_to` 后 30 秒撤销无法恢复；依赖方由读侧 `adjudicate` 按 `pruned` 收口（与 P2-08/P2-09 既有方向一致）。
- **D-P2-13-3（动作判定在 UI）**：剪枝动作由「选中集是否全部来自 prune 队列」决定，跨 tab 夹选退化为失效。理由：宁可少剪（保守），不能把低置信事实误剪枝；动作记在 op 上，撤销条不随切 tab 变文案。
- **遗留 1**：`/api/queues/prune` 的 `thresholds` 为新增字段；Lead 若在台账 §5.2 记录 API 契约变更，请注明「只增字段，既有 `items` 不变」。
- **遗留 2**：批量 prune 的 `undo_deadline` 由 `/batch` 统一返回，UI 未额外展示「30 秒后不可撤销」以外的服务端时间源；与既有 invalidate 行为一致，无新增。
- 未新增 TODO/FIXME；未改台账、未改 `src/app/cli/index.ts`、`src/app/http/server.ts`、`src/app/main.ts`、未改库表；未自动删除任何事实（红线）。
