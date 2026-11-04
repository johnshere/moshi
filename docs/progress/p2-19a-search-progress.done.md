# P2-19A-02 `GET /api/search`：实体 + FTS5 事实统一搜索

- 任务卡：task-15（P2-19A-02）
- 依据：概设 §8.1「顶部搜索输入即查 alias + FTS5」；台账 §4 P2-19-A；`docs/progress/p2-19a-reconciliation.md` A2/F16
- 状态：代码/测试完成，等待 Lead 在 `src/app/http/server.ts` 注册 `/api/search`

## 目标

新增 `GET /api/search?q=<kw>&limit=<n>`，一次返回实体与事实两类命中（`moshi-search/1`），只读、无新表、不改既有 `/api/*` 契约（D-89）。

## 开工前的事实核查

- 现有 `GET /api/facts?q=` 只搜事实单表，跨实体/事实的统一入口确实缺失（task-12 顶部搜索先是拿它兜底）。
- `fact_fts`（FTS5）的查询入口在 `src/infra/sqlite/ftsRepo.ts`：`bm25Search` 只回 `fact_id/score`，顶部搜索还要 `content/canonical_key/importance/confidence` → 需**只增**一个带元数据的查询函数。
- 实体与事实的关联键不在 `fact` 表列上：`fact.attrs.frozen.subject.entity_id`（`migrations/001_init.sql` 的 fact 表没有 subject 外键，`entity` 表也没有反向列）→ 活跃事实数用 `json_extract` 统计。
- `entity.canonical_name` 无索引且不区分大小写（LIKE 对 ASCII 天然不区分）；`alias` 有 `idx_alias_alias`。
- 无全局 errorHandler，参数错误必须在路由层就地转 400（同 `routes/facts.ts`）。

## 落盘

| 文件 | 改动 |
|---|---|
| `src/app/http/routes/search.ts` | 新：`searchRoutes(app,{db})`，`GET /` 返回 `{schema,q,limit,entities,facts,took_ms}`；`parseQ`/`parseLimit`（空 q、数组、非法 limit → 400 `E_INPUT`；limit 默认 10、上限 50 夹住）；事实正文按码点截断 200 |
| `src/infra/sqlite/ftsRepo.ts` | 增 `FtsFactHit` + `searchFactsWithMeta(db,matchQuery,k)`（JOIN fact 取元数据，`ORDER BY bm25 ASC, f.id ASC`；失败照旧上抛 E_DB，不吞成空结果） |
| `src/infra/sqlite/entityRepo.ts` | 增 `EntitySearchHit` + `searchEntitiesByName(db,q,limit)`（canonical_name 或 alias 子串，LIKE 转义 `%`/`_`/`\` + `ESCAPE '\'`；排除 merged loser；`COUNT(active fact)` 排序 `fact_count DESC, e.id ASC`） |
| `tests/unit/search-api.test.ts` | 新：11 例（实体命中/活跃事实数/别名/合并 loser/LIKE 转义/稳定排序/事实字段/200 码点截断/事实 limit/参数校验/空结果） |
| `docs/progress/p2-19a-search-progress.md` | 本文档 |

## 契约实际输出（种子库真实 inject，非模拟）

种子：`alpha-service`（别名 `alpha`，2 条活跃事实）、`gamma-process`（1 条含 8080 的事实）；`syncMissingFts` 后：

```json
GET /api/search?q=alpha&limit=5 → 200
{"schema":"moshi-search/1","q":"alpha","limit":5,"entities":[{"entity_id":"en_01m6ket93m64p5b98vg46z6nx8","canonical_name":"alpha-service","etype":"service","fact_count":2,"score":2}],"facts":[{"fact_id":"f_01m6ket93qn15jzq67dda11f9s","content":"alpha service owner = ops","canonical_key":"ck1:59e96a6f0cbeabfd81445d9868b01755","importance":0.5,"confidence":0.9,"score":0.000001},{"fact_id":"f_01m6ket93nj9dndg189vsgyr0f","content":"alpha service version = 22.0.0","canonical_key":"ck1:02d3fc7e0be35a6ce98ceb70811a318c","importance":0.5,"confidence":0.9,"score":0.000001}],"took_ms":0.714}

GET /api/search?q=8080 → 200
{"schema":"moshi-search/1","q":"8080","limit":10,"entities":[],"facts":[{"fact_id":"f_01m6ket93qn15jzq67dda11f9v","content":"gamma process listens on 8080","canonical_key":"ck1:d0324dca72945289bd1126b667884281","importance":0.5,"confidence":0.9,"score":0.496323}],"took_ms":0.275}

GET /api/search?q= → 400
{"error":"E_INPUT","message":"q 不能为空","detail":{"reason":"q_empty"}}
```

字段口径补充（契约未细化，本实现约定，Lead 可 adjudicate）：
- `entities[].score` = `fact_count`（排序主键原样暴露，越大越靠前）。
- `facts[].score` = `-bm25`（保留 6 位小数，越大越相关）；原始 bm25 为负数，直接暴露会让前端误判方向。
- `facts` 命中**不按** `epistemic_status` 过滤：契约写「复用 ftsRepo 的 search」，与现有 BM25 召回同口径；若顶部搜索要排除归档事实，后续加过滤参数即可（见遗留）。

## 验收

```
pnpm typecheck        ✔（无输出即通过）
pnpm vitest run tests/unit/search-api.test.ts   ✔ 11 passed
pnpm lint:lifecycle   ✔ 生命周期写路径检查通过（103 个文件）
pnpm lint:deps        ✔ 依赖方向检查通过（151 个模块，652 条内部依赖）
```

## 需要 Lead 的接线（`src/app/http/server.ts`）

1. `import { searchRoutes } from './routes/search.js';`
2. 与其它只读路由同一批注册（token 校验的 onRequest hook 已覆盖 `/api/*`）：
   `await app.register(searchRoutes, { prefix: '/api/search', db: deps.db });`
   （`db` 用与 `factRoutes` 相同的 `deps.db`；无需新 deps 字段。）

## 遗留

1. **`facts` 不过滤生命周期**：归档/失效事实仍可能出现在事实命中里（与现有 BM25 召回路一致）。顶部搜索若要「只看活跃」，建议在 P2-19A-03 加 `status` 过滤（默认 active），需同步扩展契约。
2. **实体活跃事实数是关联子查询式统计**：`json_extract(fact.attrs,'$.frozen.subject.entity_id')` 无法走索引，实体表大时搜索会全表扫 `fact`。当前规模可接受；若 QPS/数据量上来，可考虑物化 `fact.subject_entity_id` 列 + 索引（改表，须单开卡）。
3. 实体匹配目前是**子串**（canonical_name/alias 均 `%q%`），前缀命中没有额外加权；排序只看活跃事实数。若顶部搜索要「前缀优先」，需在契约里明确优先级。
4. 未做分页：`limit` 上限 50 且一次查两类命中，够顶部搜索用；更深的「查看全部」应走 `/api/facts` 与后续实体列表接口。
