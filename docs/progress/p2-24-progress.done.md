# P2-24 `moshi-trace/1` 契约与后端采集

- 起止：2026-11-04 21:36 → 2026-11-04 21:44（Asia/Shanghai）
- 依据：详设 §4.7（L1508-1542 schema）、§12.2（验收口径）、§6.11/§6.12；台账 P2-24
- 边界：不加 SSE/WebSocket（D-118）；不建表/不改库表；不改 `/api/graph` 契约；trace 不落库；缺 trace 不报错

## 目标

一次 `memory_query` 除了证据包，还要能回放「怎么走到答案」：检索种子、每条入包事实的跳数
（hop）、沿哪些边（path）、边上带多少 PPR 扩散质量（edge_mass）。后端只提供内存 ring
buffer + 两个只读接口，动画由 P2-25 前端消费。

## 开工前的事实核查（避免主旨偏）

- 详设 §4.7 字段名逐字核对：`schema/query_id/ts/model_mode/model_version/source/seeds/
  results[{fact_id,hop,path[{src,dst,etype,mass}],edge_mass,fused_rank,rank_symbolic,rank_final}]`。
- `searchWithPipeline` 有三条 return 出口（global / 缓存命中 / local），三处都要产 trace，
  否则前端按 query_id 轮询时会看到「有时 404」。
- `ppr.ts` 的 `PprResult` 只导出 top-20 的 `ids/scores` 与子图节点数 `nodes`，**没有逐边流量**；
  ppr.ts 不在本任务 write scope，因此在 trace.ts 里用 `EDGE_WEIGHT` + `neighbors()` 重建
  邻接与 rowSum（与 ppr.ts 同口径），种子概率按 `3/(3S+(N-S))` 精确复算。
- 注入点全部可选：`SearchRuntime.trace?` / `McpDeps.traceStore?` / `HttpDeps.traceStore?`
  （后者由 Lead 接线），不传时读取链行为与 P2-24 之前完全一致。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `src/core/read/trace.ts`（新，444 行） | `TRACE_SCHEMA`/`TRACE_CAPACITY`、`TraceRecord`/`TraceResult`/`TraceEdge`、`TraceSink`、`TraceStore`（ring buffer 64，get/put/list/recent/reset）、`buildTrace`（纯函数，强制「模型未生效 ⇒ source=symbolic 且 rank_final=rank_symbolic」、hop=0 清 path、mass 夹 0–1）、`collectTrace`（从子图边 + PPR 种子邻边 BFS 重建 hop/path/edge_mass，路径不可重建时 hop=2 且 path 空，不伪造边） |
| `src/core/read/search.ts` | `SearchRuntime` 增 `trace?: TraceSink`、`modelVersion?: string | null`；新增 `emitTrace`（sink 抛错只丢回放，不中断查询）与 `traceMeta`；global / 缓存命中 / local 三处出口各采一条 trace；缓存命中的 results 记 hop=0、seeds 留空（没跑召回就不伪造扩散） |
| `src/app/mcp/deps.ts` | `McpDeps.traceStore?: TraceStore`（`onEnqueued` 同款可选注入口径） |
| `src/app/mcp/query.ts` | runtime 构造时 `...(deps.traceStore === undefined ? {} : { trace: deps.traceStore })` |
| `src/app/http/routes/trace.ts`（新） | `traceRoutes` 插件：`GET /api/trace/:query_id`（命中 200 原样返回，缺失 404 `E_NOT_FOUND`）、`GET /api/trace?limit=20`（缺省 20、1..64 夹住、非法 400 `E_INPUT`；`{schema,queries[],total,limit}` 新→旧）。统一 `cache-control: no-store`，鉴权沿用 `/api/*` 的 `x-moshi-token` hook，不重复实现 |
| `tests/unit/trace.test.ts`（新，11 例） | buildTrace 契约、TraceStore 满 64 淘汰、本地 trace（hop 0/1/2 + edge_mass=0.6/0.211281）、全局空 trace、缓存命中不伪造 seeds、不注入 trace 的既有行为、HTTP 200/404/400/limit 夹住、runMemoryQuery 注入链路 |
| `docs/progress/p2-24-progress.md`（新） | 本文件 |

## 规则映射

- **D-118（无 SSE/WebSocket）**：回放靠前端按 query_id 轮询 `GET /api/trace/:query_id`，后端只读、无长连接。
- **trace 不落库**：`TraceStore` 纯内存（无 db 句柄），容量 64 FIFO；重启即空，缺失返回 404 而不是 500。
- **`/api/graph` 契约不动**：trace 是独立命名空间 `/api/trace`，`graphRoutes` 零改动。
- **模型未生效的硬约束**：`buildTrace` 无条件把 `rank_final` 覆写为 `rank_symbolic`、`source` 记 `symbolic`；`model_mode` 取 `SearchRuntime.gatMode`（默认 `off`）。
- **不伪造边**：入包节点若不在召回并集（只经裁决/邻居兜底进来），hop 记 2、path/edge_mass 空——宁可缺，不可编。

## 踩到的坑

1. **trace 需要 ppr 的边流量，但 ppr.ts 不在 write scope**：`PprResult` 只有节点分数，没有 `p_i*w/rowSum` 的逐边值。解法：trace.ts 内用 `sub.edges` + `neighbors(pprSeed)` 重建邻接（行和口径与 ppr.ts 一致：同节点对取最大 `EDGE_WEIGHT`），种子 p 按 `3/(3S+(N-S))` 精确复算；中间节点优先用 PPR 返回的精确分数，取不到时用沿路径流入份额近似（模块头已声明，是本模块唯一近似）。
2. **三处出口都要产 trace**：只补 local 会让缓存命中/全局查询按 query_id 查不到，前端表现为「时有时无」。缓存命中没有召回现场，故 results 全记 hop=0、seeds 空，不复制历史 trace（避免撒谎）。
3. **`rank_final` 不能透传调用方的值**：模型 off/shadow 时必须等于 `rank_symbolic`，否则前端排序与证据包不一致；在 `buildTrace` 里统一收口，collectTrace 不各自判断。
4. **工厂插入不碰 FTS**：trace 的本地用例要走 BM25 命中，插入后必须 `syncMissingFts(db)`（与 search.test.ts 同约定）；否则 seeds 为空、用例假失败。

## 验收

```text
$ pnpm vitest run tests/unit/trace.test.ts
 ✓ tests/unit/trace.test.ts (11 tests) 317ms
 Test Files  1 passed (1)      Tests  11 passed (11)

$ pnpm vitest run tests/unit/trace.test.ts tests/unit/search.test.ts tests/unit/mcp.test.ts
 ✓ tests/unit/search.test.ts (16 tests)
 ✓ tests/unit/mcp.test.ts (20 tests)
 ✓ tests/unit/trace.test.ts (11 tests)
 Test Files  3 passed (3)      Tests  47 passed (47)

$ pnpm lint:lifecycle
 ✔ 生命周期写路径检查通过（92 个文件）

$ pnpm lint:deps
 ✔ 依赖方向检查通过（139 个模块，580 条内部依赖，5 条规则）

$ pnpm typecheck
 # 本任务 6 个文件均无错误；全仓仍有他人 WIP 的既有错误（非本任务引入）：
 # src/core/write/harvest.ts 未使用导入；tests/unit/archive-guard.test.ts 缺 humanEdited/未使用 freshDb
```

真实查询 trace JSON（`temp/p2-24-demo.ts`，f1-bm25 直击、f1→f2 `depends_on`、f2→f3 `logic`）：

```json
{
  "schema": "moshi-trace/1", "route": "local", "model_mode": "off",
  "model_version": null, "source": "symbolic",
  "seeds": ["f_…gve"],
  "results": [
    { "fact_id": "f_…gve", "hop": 0, "path": [], "edge_mass": [], "fused_rank": 1, "rank_symbolic": 1, "rank_final": 1 },
    { "fact_id": "f_…xgt", "hop": 1, "edge_mass": [0.6],
      "path": [{ "src": "f_…gve", "dst": "f_…xgt", "etype": "depends_on", "mass": 0.6 }],
      "fused_rank": 2, "rank_symbolic": 2, "rank_final": 2 },
    { "fact_id": "f_…v8a", "hop": 2, "edge_mass": [0.6, 0.211281],
      "path": [
        { "src": "f_…gve", "dst": "f_…xgt", "etype": "depends_on", "mass": 0.6 },
        { "src": "f_…xgt", "dst": "f_…v8a", "etype": "logic", "mass": 0.211281 }],
      "fused_rank": 3, "rank_symbolic": 3, "rank_final": 3 }
  ]
}
```

全局查询同口径留空 trace：`{"route":"global","seeds":[],"results":[]}`（前端不 404）。

## 留给后面的（Lead 接线，`src/app/http/server.ts` 由 Lead 统一改）

1. 第 27 行附近加两个 import：`import type { TraceStore } from '../../core/read/trace.js';`
   与 `import { traceRoutes } from './routes/trace.js';`
2. `HttpDeps`（第 44 行 `batchOpTtlMs` 后）加 `traceStore?: TraceStore;`
3. 第 82 行 `graphRoutes` 注册后加：

   ```ts
   // 证据链回放（P2-24）：进程内 ring buffer 一份，MCP 采集 / HTTP 只读
   const traceStore = deps.traceStore ?? new TraceStore();
   await app.register(traceRoutes, { prefix: '/api/trace', store: traceStore });
   ```

4. `mcpDeps`（第 112-118 行）加 `traceStore,` 一行（与 `cache` 同处）。

之后 `pnpm build` + `pnpm verify` 由 Lead 统一跑；UI 端 P2-25 用 `aFlow hop0=0/hop1=0.6/hop2=0.3`、
`aMass 0–1`、`aHop 0/1/2` 消费本 trace。

## 遗留 / 已知近似

- `edge_mass` 的中间节点若不在 PPR top-20（极小概率：hop=2 路径中继节点分数低），用沿路径
  流入份额近似；路径本身与跳数仍精确。
- `model_version` 恒 `null`、`source` 恒 `symbolic`，等 P3 GAT 接入后由 `SearchRuntime.modelVersion`
  注入，`buildTrace` 已支持 `model_mode:'on'` 分支。
- 缓存命中 trace 的 hop 全 0（无召回现场），P2-25 渲染时按「直击」处理即可。
