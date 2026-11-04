# P2-19A-09 实体合并（task-20）进度

状态：**实现 + 自测完成，待 Lead 接线 server.ts / verify / build / commit**

## 目标

- 后端：实体合并预览与执行（事务、`canonical_key` 重算、别名改指、`merged_into` 标记、审计）。
- 接口：`GET /api/entities`、`POST /api/entities/merge/preview`、`POST /api/entities/merge`。
- UI：记忆页最小入口（搜索实体 → 选源/目标 → 预览冲突 → 确认合并）。

## 关键决策

- **D1 不改 `attrs.frozen`**：I2 触发器保护事实归属；合并只写 `entity.merged_into` + 重算
  `fact.canonical_key`（独立列，不受 frozen 触发器约束）+ 别名改指。`frozen.entity_id`
  保留为写入期来源，后续消解经 `followMerge` 归一到 winner。
- **D2 完全重复不物理删**：重算后 winner 侧已有同 `(canonical_key, scope, value_hash)` 的活跃事实时，
  loser 行按生命周期收口（`valid_to` + `superseded_by`），计 `deduped_facts`。
- **D3 冲突只列不裁**：同 predicate、不同 `value_hash` 的活跃事实进 `conflicts`，
  `conflicts_resolved` 恒为 0，留给人工后续处理。
- **D4 edge 不移动**：`edge.src/dst` 是 `fact.id`，没有实体列；事实改判不需要搬边，
  `moved_edges=0` 是正确口径（预览里的 `will_move.edges` 仅作参考计数）。
- **D5 不做撤销**：实体改判未纳入 `/api/facts/ops/:op_id/undo` 的 30s 快照；接口明确返回
  `undoable:false, undo_reason:'entity_merge_not_snapshotted'`，不签发伪 op_id。
- **D6 列表按归并根汇总**：`GET /api/entities` 用递归 CTE 沿 `merged_into` 把 loser 的事实算到
  winner 头上，loser 不再作为独立实体出现。
- **D7 审计口径**：audit 表没有 action 列，用 `tbl='entity'`、`field='merge'`、
  `reason='entity.merge'`、`source='human'`；before/after 记录实体与移动计数。
- **D8 社区重算**：事务内 `community_rev += 1`，让 communityRunner 感知归并变化。

## 改动文件

| 文件 | 说明 |
| --- | --- |
| `src/core/write/entity-merge.ts`（新） | `previewEntityMerge` / `mergeEntities`，事务编排与冲突判定 |
| `src/app/http/routes/entities.ts`（新） | 三路由 + 错误映射（400/404/409） |
| `src/infra/sqlite/entityRepo.ts`（只增） | 合并所需查询/写回：事实列举、计数、别名搬迁、`canonical_key` 更新、重复收口、递归 CTE 列表 |
| `src/ui/memories/EntityMergePanel.tsx`（新） | 最小合并面板（inline 样式） |
| `src/ui/memories/MemoriesPage.tsx` | 挂载合并入口 |
| `tests/unit/entity-merge.test.ts`（新） | 6 例核心契约 |
| `tests/unit/entities-api.test.ts`（新） | 5 例路由契约 |
| `docs/progress/p2-19a-entities-progress.md` | 本文件 |

## 验收命令与结果

```
pnpm typecheck        → clean（无输出）
pnpm typecheck:ui     → clean（无输出）
pnpm vitest run tests/unit/entity-merge.test.ts tests/unit/entities-api.test.ts
  → Test Files 2 passed (2)，Tests 11 passed (11)
pnpm lint:deps        → ✔ 依赖方向检查通过（155 个模块，702 条内部依赖，5 条规则）
pnpm lint:writes      → ✔ 107 个文件，无白名单外写调用
pnpm lint:lifecycle   → ✔ 生命周期写路径检查通过（107 个文件）
pnpm exec eslint <改动 TS 文件> → 0 errors（src/ui 被既有 ignore）
```

核心用例覆盖：

- 预览：冲突列表 / `will_move` 计数 / `can_merge`；同 id、etype 不符、实体不存在。
- 合并：`canonical_key` 按 winner 重算且不撞唯一索引；完全重复收口（`valid_to` + `superseded_by`）；
  `attrs.frozen` 字节不变；别名改指；audit 记录；`community_rev` bump。
- 幂等：重复合并 `moved_* = 0` 且不重复审计；已合并到别处报 409。
- 列表：合并后按根实体汇总 `fact_count`，loser 不再出现。
- API：GET/POST 全链路、非法 limit/q/body、404 的 `detail.which`。

## 真实 inject 输出（临时 SQLite + 真实 Fastify，跑完已删脚本）

`GET /api/entities?q=node` → 200：

```json
{"items":[
  {"entity_id":"en_…sne6n","canonical_name":"node","etype":"pkg","fact_count":2,"alias_count":1},
  {"entity_id":"en_…wte","canonical_name":"nodejs","etype":"pkg","fact_count":2,"alias_count":0}
]}
```

`POST /api/entities/merge/preview` → 200：`will_move {facts:2,edges:0,aliases:1}`、
`conflicts:[]`、`can_merge:true`。

`POST /api/entities/merge` → 200：

```json
{"ok":true,"moved_facts":1,"moved_edges":0,"merged_aliases":1,
 "deduped_facts":1,"conflicts_resolved":0,
 "undoable":false,"undo_reason":"entity_merge_not_snapshotted"}
```

重复合并 → 200，`moved_facts:0`。合并后 `GET /api/entities?q=node`：

```json
{"items":[{"entity_id":"en_…wte","canonical_name":"nodejs","etype":"pkg","fact_count":3,"alias_count":1}]}
```

audit：`{tbl:"entity", field:"merge", source:"human", reason:"entity.merge"}`。

## Lead 接线

```ts
import { entitiesRoutes } from './routes/entities.js';
await app.register(entitiesRoutes, { prefix: '/api/entities', db: deps.db });
```

## 遗留 / 口径说明

- 实体合并不可撤销（D5）；如需撤销需为实体改判引入快照机制（另开任务）。
- `frozen.entity_id` 保留原归属是 I2 约束下的有意选择；按实体 id 直查 frozen 的旧路径
  （如 `searchEntitiesByName`）在合并后仍可能命中 loser，列表接口已按 `merged_into` 归并。
- 冲突不自动裁决（D3），需要后续人工处理入口。
- UI 为最小入口，未做视觉打磨（按任务要求不混美化）。
- 合并 etype 不同直接 400（任务卡要求）；未提供 `allow_etype_mismatch` 开关。
