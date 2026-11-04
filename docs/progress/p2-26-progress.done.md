# P2-26 查询回放入口（历史查询列表 + 实时/回放切换）

- 起止：2026-11-04 21:58 – 22:05（Asia/Shanghai）
- 依据：docs/任务台账.md §4 P2-26（L1046-1051）；详设 §4.7（trace 契约 / 最近 64 次不落库）；P2-24 `GET /api/trace`、P2-25 `window.__moshiGraph` 与 hop 分档图例
- 任务卡：task-10（writeScopes：src/ui/history、src/ui/main.tsx、src/ui/api.ts、src/ui/graph、tests/unit/history-replay.test.ts、docs/progress/p2-26-progress.md）

## 目标

补「实时 TTL 一过就没了」的缺口（D-118）：UI 提供历史 query 列表（`GET /api/trace?limit=20`），
点选后加载 `GET /api/trace/:query_id` 并在图上回放同一份 trace；`window.__moshiGraph` 发布
`{mode:'replay', query_id, trace, edges}`，实时 `{mode:'live', ...}`；无 trace 降级「无证据链」不报错；
不加 SSE/WebSocket、不新增后端接口。

## 开工前的事实核查

- `/api/trace` 列表项字段：`{query_id, ts, route, source}`（`src/app/http/routes/trace.ts` 实现）——
  **没有查询文本、没有 model_mode**（trace 契约本身不含查询文本），列表只能显示时间/短 id/route·source。
- `fetchTrace(queryId)` 已把 404 映射成 `null`（P2-25 落地）；`fetchTraceList(limit)` 已存在。
- `useTrace` 目前只有 `{trace,error,setTrace,clear}`；3s 轮询直接 `setTrace(latest)`——回放会被顶掉，需加模式。
- `vitest.config.ts`：`environment: 'node'`；`src/ui/package.json` 没有 jsdom / @testing-library，
  React 组件无法在单测里渲染 → 历史列表的渲染规则必须落在纯函数上。
- 根 `tsconfig.json` `lib: ["ES2023"]` 且 exclude `src/ui`，但 `tests/**` 被 include：
  测试若 import 到 `src/ui/api.ts`（依赖 `window`）会 typecheck 失败 → 纯逻辑层不能 import api.ts。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `src/ui/history/pure.ts`（新） | 回放状态机与列表渲染模型的唯一实现：`HISTORY_LIMIT=20`、`REPLAY_MISS_MESSAGE`、`clockOf`（本地 HH:MM:SS，坏 ts→「—」）、`historyRows`（过滤 null/空 id，`shortId` 尾 8 位、meta=`route · source`）、`historyEmptyText`（接口失败 / 暂无历史两套空态文案）、`liveState`/`replayState`/`missState`/`backToLiveState`、`shouldPollLatest`（只有 live 允许轮询覆盖）、`selectedIdOf`（回放态=回放 id；回放项被淘汰仍高亮） |
| `src/ui/history/HistoryPanel.tsx`（新） | 历史面板：列表（时间 + 短 id + route·source，选中项高亮）、点选 `replayTrace(id)`、回放态显示「回放中 · <id> · <淘汰原因>」+「回到实时」按钮、空态「无证据链 · 暂无历史查询…」、10s 轮询列表 + 实时 trace 变化时补拉；只有模式/选中/空态来自 pure，组件只做取数与 JSX |
| `src/ui/state/trace.ts` | `useTrace` 扩为 `{trace,error,mode,queryId,setTrace,replay,miss,backToLive,clear}`（状态迁移全走 `history/pure.ts`）；`refreshLatestTrace` 开头 `shouldPollLatest` 守卫（回放期间静默）；新增 `replayTrace`（404→`miss` 降级、异常只写 error 不抛）与 `backToLiveTrace`（清空回放态后立刻补拉最新一条） |
| `src/ui/api.ts` | `window.__moshiGraph` 增 `mode: 'live' \| 'replay'`、`query_id: string \| null`（脚本据此区分回放/实时） |
| `src/ui/graph/Graph3D.tsx` | `publish` 发布 `mode`/`query_id`（回放时=回放 id，实时=图上 trace id）；`applyTrace` 在回放态重播入场脉冲（点回放要重新看到流动走一遍；实时同 id 不重播） |
| `src/ui/main.tsx` | HUD `TraceNote` 增「实时 / 回放 <id>」状态标识（回放时橙色）；无 trace 时把 `error` 原因带出（「证据链：无（该查询的 trace 已不在…）」）；渲染 `<HistoryPanel />`（非表格视图） |
| `tests/unit/history-replay.test.ts`（新，16 例） | 列表模型/空态/脏项、时间格式与坏 ts、live/replay/miss/backToLive 迁移、`shouldPollLatest`（回放期间不覆盖）、`selectedIdOf`（淘汰后仍高亮）、完整 live→replay→live 不串数据序列、`HISTORY_LIMIT=20` |

## 规则映射

- D-118：不加 SSE/WebSocket；列表与回放各走一次普通 `GET /api/trace*`，渲染共用同一个 `useTrace` →
  Graph3D/Graph2D 通道（回放不是第二条渲染管线）。
- D-89：不新增后端接口、不改 `/api/graph`；前端回放只替换 `useTrace` 的 trace 快照。
- 「回放与实时不串数据」：轮询入口有 `shouldPollLatest` 守卫；`backToLiveState` 先清 trace 再拉最新；
  `missState` 不保留旧 trace（只保留 query_id 用于高亮与提示）。浏览器里实测回放 >4.2s（超过 3s 轮询）
  仍是 replay，未被实时查询顶掉。
- 无 trace 降级：列表空 →「无证据链 · 暂无历史查询」；回放 404 → 「无证据链 · 该查询的 trace 已不在
  （仅保留最近 64 次）」；两种都不抛错。

## 踩到的坑

1. **轮询会把回放顶掉**：P2-25 的 `refreshLatestTrace` 每 3s 无条件 `setTrace(latest)`。必须把模式判断放在
   取数入口（`shouldPollLatest`），而不是放在组件里——否则任何新增订阅方都会绕过。
2. **列表接口没有查询文本 / model_mode**：任务卡写的是「query 文本若 trace 含之则显示」，实际 trace 不含
   查询文本，故面板显示 `时间 · 短 id · route · source`；不伪造字段。
3. **React 组件不可单测**：环境是 node、无 DOM 库。把列表行模型、空态、选中态、模式迁移全部抽到
   `history/pure.ts`；并且该文件**不能 import api.ts**（`window` 在根 tsconfig 的 ES2023 lib 下无类型）。
4. **回放同一条 query 不重播脉冲**：`applyTrace` 原本按 `query_id !== pulsedQueryId` 去重，回放同一条
   （或刚在实时看过的那条）不会重新走流动。改为「回放态总是重播」，实时态仍去重。
5. **验收环境仍复用 P2-25 的临时 harness**（真 daemon 的 `/mcp` body 被 Fastify 消费，既有问题）：
   `temp/ui-accept/server.ts` 暴露 `POST /api/__accept_query`，两次查询后 `/api/trace?limit=20` 有两条，
   足够验证列表与回放。

## 验收

```
pnpm --filter moshi-ui typecheck                          → 通过（无输出）
pnpm typecheck                                            → 通过（root，含 tests）
pnpm vitest run tests/unit/history-replay.test.ts         → 16 passed
pnpm vitest run graph-trace + graph-2d + graph-activity   → 55 passed（无回归）
```

浏览器验收（`http://127.0.0.1:53080/ui/graph/?token=accept-token`，vite dev → 53001 harness，
3 节点 2 边：alpha 直击/1 跳/2 跳，beta 直击）：

**① 回放成功**（点历史列表里的 alpha 条目 `q_01m6kdtcb56036na7hc0gnrb97`，最新一条是 beta）

- 截图：`temp/ui-accept/p2-26-replay.png`（HUD 橙色「回放 c0gnrb97」+ 三态图例；面板两行、alpha 高亮）
- `window.__moshiGraph`（原样抄回）：

```json
{"mode":"replay","query_id":"q_01m6kdtcb56036na7hc0gnrb97",
 "trace":{"query_id":"q_01m6kdtcb56036na7hc0gnrb97","ts":1793800876382,"route":"local",
          "source":"symbolic","model_mode":"off","model_version":null,
          "seeds":1,"direct":1,"hop1":1,"hop2":1,"edges":2},
 "edges":{"aFlow":[0.6,0.3],"aMass":[1,0.211281],"aHop":[1,2],"count":2},
 "calls":7,"halos":1,"labelCount":1}
```

- 4.2s 后复读（>3s 轮询周期）：`mode=replay`、`query_id` 与 `trace.query_id` 仍是 alpha → 实时轮询没有覆盖回放。

**② 无 trace 降级**（重启 harness 清空 ring buffer 后，点过期列表项）

- 截图：`temp/ui-accept/p2-26-degrade.png`
- readout：`{"mode":"replay","query_id":"q_01m6kdtcb56036na7hc0gnrb97","trace":null,"calls":6,"labelCount":0}`
- HUD 文案：「证据链：无（该查询的 trace 已不在（仅保留最近 64 次））· 查询一次后自动显示…」
- 面板文案：「回放中 · c0gnrb97 · 该查询的 trace 已不在（仅保留最近 64 次）」；列表轮询后变
  「无证据链 · 暂无历史查询（查询一次后出现；daemon 重启即清空）」
- 点「回到实时」：`{"mode":"live","query_id":null,"trace":null}`，面板回到「实时：跟随最近一次查询」——
  回放的 trace 未被当成实时数据继续用。

**③ 回到实时后新查询自动跟上**（清空后重新 `POST /api/__accept_query`）

- `{"mode":"live","query_id":"q_01m6kdx23zkdcf71phqd0pym0q", ... "edges":{"aFlow":[0.6,0.3],"aMass":[1,0.211281],"aHop":[1,2],"count":2},"calls":7}`
- 面板重新出现 22:02:44 / qd0pym0q / local · symbolic 一行。

## 留给后面的

- 真 daemon 的 `/mcp` body 被 Fastify 消费的问题仍在（P2-25 坑 5），浏览器验收依赖 `temp/ui-accept` harness；
  建议 Lead 单开卡修（不影响 P2-26 验收路径：`/api/trace` 不经过 MCP）。
- 列表接口只有 `{query_id,ts,route,source}`，没有查询文本 / model_mode；若后面要显示查询语句，
  需要 P2-24 契约加字段（改 trace 记录 + 内存 ring buffer），不是前端能补的。
- `fetchTraceList` 目前仍是 10s 轮询 + 实时 trace 变化时补拉；D-118 不加推送，暂无更快通道。
