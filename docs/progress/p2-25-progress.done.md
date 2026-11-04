# P2-25 证据链前端渲染（moshi-trace/1 → aFlow / aMass / aHop + 直击态图例）

- 起止：2026-11-04 21:44 – 21:58（Asia/Shanghai）
- 依据：docs/任务台账.md §4 P2-25（L1039-1045）；详设 §4.7、§10.3 / §10.3.1 / §10.3.2；P2-24 的 trace 形状与 `GET /api/trace`
- 任务卡：task-9（writeScopes：src/ui/graph、src/ui/main.tsx、src/ui/api.ts、src/ui/state、tests/unit/graph-trace.test.ts、docs/progress/p2-25-progress.md）

## 目标

把 trace 画成「为什么返回这些事实」：边属性 `aFlow` / `aMass` / `aHop`，流动方向由 hop 递进决定；
直击态（hop0）单独可辨并有图例；`access_count` 驱动的既有流动退出流动通道（D-116/D-89）；
不新增 draw call、禁 bloom、不改 /api/graph 与主排序（D-119）。

## 开工前的事实核查

- `src/ui/graph/Graph3D.tsx`：边是单个 `LineSegments` + `ShaderMaterial`（EDGE_VERT/EDGE_FRAG），
  已有 attribute `aType/aConf/aVis/aFlow`；draw call = 节点 1 + 边 1 + 光晕 1 + 包络 1 + 网格 4 = 8。
- `src/ui/graph/pure/encoding.ts`：`flowSpeedForActivity(activity)=0.6*clamp01(activity)`（0.6 即满速系数），
  `VisualState = dormant | secondary | active`，`nodeVisual/edgeVisual` 是双态参数表的唯一实现。
- `src/ui/graph/pure/activity.ts`：`edgeKey` 是**无向**键，只服务"点选活跃集"，不能拿来当证据路径的键。
- `src/ui/api.ts`：`window.__moshiGraph` 是既有验收钩子（fps/renderCalls/nodeCount/...），扩展它。
- 后端 trace：`results[].hop` 0/1/2、`edge_mass[]` 0–1、`path[].{src,dst,etype,mass}`；
  `GET /api/trace?limit=1` 拿最近 query_id，再 `GET /api/trace/:query_id` 取整条。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `src/ui/graph/pure/trace.ts`（新，284 行） | 前端 trace 结构类型（不 import 后端模块）；`hopBand`/`flowForHop`（0→0、1→0.6、2+→0.3，NaN/负数→0）；`edgeRefKey`（**有向** `src\0dst\0etype`）；`traceEdgeAttrsFor`（path 逐边 hop=hopBand(i+1)、mass 优先 `path.mass` 再 `edge_mass`、同边取最小 hop + 累加 mass 夹 0–1、反向边 `dir=1`、无 trace/脏数据全 null）；`traceEdgeReadout`；`traceNodeHops`/`traceNodeState`（hop0=active，>0=secondary）；`brighterState`；`traceSummary`；`collectTraceEdges`/`pathEdgeMass` 对 null / 非数组字段全部防御 |
| `src/ui/graph/Graph3D.tsx` | EDGE_VERT 增 `aMass/aHop/aDir`，`u = mix(uv.x, 1-uv.x, aDir)`、`vPhase = uTime*aFlow*uFlowScale + aHop*0.33`；EDGE_FRAG `flowing=step(1e-4, vFlow)`，亮度/alpha 加 flow 与 mass；GraphScene 增 trace/attrs/readout 字段与 `useTrace` 订阅、`writeTraceAttrs`/`recaptureTrace`/`applyTrace`/`pulseTrace`；`stateOf` = 活跃集与证据链取较亮者；光晕/标签的 `activeIndices` 改为「视觉 active（含 hop0 直击）」，`haloOpacity` 无 activity 但有直击时给 `HALO_OPACITY`；`restyleAll` 里 `uFlowScale` 恒 1（边流动只由 aFlow 决定，D-116）；`publish` 增 `calls`（=renderCalls 别名）/`trace`/`edges`；draw call 不变（仍 1 条边 geometry，多 4 个 attribute） |
| `src/ui/graph/Graph2D.tsx` | 同一份 trace 属性接到 sigma 通道：`stateOfNode` 取较亮者、`stateOfEdge` 合活跃边 + 证据跳数、`applyVisuals` 边 `opacity+0.35*mass`、`size+0.6*mass`（2D 与 3D 共用映射层，不另写一套） |
| `src/ui/api.ts` | `window.__moshiGraph` 增 `calls: number`、`trace: TraceSummary \| null`、`edges: TraceEdgeReadout`；新增 `TraceListEntry`/`TraceListPayload`、`fetchTraceList`、`fetchTrace`（404 → null）、`errorMessage` |
| `src/ui/state/trace.ts`（新） | zustand `useTrace{trace,error,setTrace,clear}`；`refreshLatestTrace()`：拉 `limit=1` 列表取 `queries[0]`，同 query_id 直接返回（不重建对象），`fetchTrace` 后 setTrace，异常只写 error 不抛 |
| `src/ui/main.tsx` | 每 3s 轮询一次 `refreshLatestTrace`（`document.hidden` 跳过；D-118 无 SSE/WebSocket）；HUD 增 `TraceNote`：「● 直击 N（亮节点 + 光晕，不画入射流）」「→ 1 跳 N（快流）」「→ 2+ 跳 N（慢流）」「证据边 N」；无 trace 显示「证据链：无（接口不可用）· 查询一次后自动显示 → 可读三态」 |
| `tests/unit/graph-trace.test.ts`（新，17 例） | hop 分档边界（0/1/2/3/负/NaN/Infinity）、逐边 hop/flow/dir、同边多次 = 最小 hop + 累加 mass 夹 1、反向边 dir=1、etype 不匹配不命中、`path.mass` 缺失回落 `edge_mass`、节点跳数与较亮态、summary/readout 读数、无 trace 全沉默、脏 trace 不抛错、`edgeRefKey` 有向 |

## 规则映射

- D-116 / D-89：不加任何后端接口、不改 /api/graph；`access_count` 的活跃度只保留「节点背景热度」通道，
  边流动唯一驱动 = `aFlow`（hop 分档）。`uFlowScale` 固定 1，不再乘活跃衰减。
- D-119：不改主排序语义——trace 只改视觉属性，不改 `/api/graph` 返回、不改融合/裁决/打包顺序。
- 详设 §10.3.2：`aFlow` hop0=0 / hop1=0.6 / hop2=0.3；`aMass` = 0–1 边质量；`aHop` = 原始跳数
  （渲染侧不归一化，也没混用模型侧 1 跳→0.5 的约定）；方向由 hop 递进决定（`aDir` 只翻转 UV 方向），
  不看 etype 语义方向；直击 hop0 只亮节点、不画入射边。
- 预算：draw call 实测 7（3 节点 / 2 边，含网格 4），上限 12；无 bloom、无新增几何体。

## 踩到的坑

1. **`edgeKey` 是无向的**：直接复用会把 A→B 与 B→A 当成一条边，方向信息丢失。新增有向 `edgeRefKey`，
   并在 `traceEdgeAttrsFor` 里支持"几何方向与 path 相反则 `dir=1` 翻转 UV"。
2. **同一条边可能在 hop1 与 hop2 的 path 里各出现一次**：若后写覆盖，f1→f2 的 mass 会从 0.6 变 0.6（巧合）
   或变 0.211；按「最小 hop + mass 累加 + 夹 0–1」聚合，实测 0.6+0.6 → 1。
3. **直击态一开始不出光晕/标签**：`activeIndices` 只统计点选活跃集，trace hop0 永远进不去。改为按
   `state === 'active'` 填充（点选命中与证据直击同一条通道），halos 1 / labelCount 1 才出现。
4. **缓存命中/重启后的 trace 缺失**：前端必须静默降级——`fetchTrace` 404→null、`useTrace.error` 只提示
   不抛、HUD 写「证据链：无」。否则一次 daemon 重启就把整个 UI 打成错误页。
5. **验收环境的 MCP 口**：真 daemon 的 `POST /mcp` 经 Fastify 时 body 已被 Fastify 解析，`createMcpHttpHandler`
   读 `req.raw` 得到空流 → `Parse error: Invalid JSON`（既有问题，不在本任务 scope）。浏览器验收改用
   `temp/ui-accept/` 里的临时 harness（同一份 graphRoutes/traceRoutes/TraceStore + 真实 `runMemoryQuery`），
   见下方「留给后面的」。

## 验收

```
pnpm --filter moshi-ui typecheck      → 通过（无输出）
pnpm typecheck                        → 通过（root，含 tests）
pnpm vitest run tests/unit/graph-trace.test.ts → 17 passed
pnpm vitest run graph-activity/graph-2d/graph-api/graph-encoding/graph-geometry/main/graph-trace
                                       → 7 files / 106 passed
```

浏览器验收（vite dev + chrome-devtools，3 节点 2 边：alpha 直击 → beta 1 跳 → gamma 2 跳）：

- 页面：`http://127.0.0.1:53080/ui/graph/?token=accept-token`（vite dev，proxy 到临时的 53001 harness）
- 截图：`temp/ui-accept/three-states.png`（HUD 三态 + 图上三节点，直击节点带标签/光晕，hop1 边亮、hop2 边暗）
- `window.__moshiGraph`（原样抄回）：

```json
{"fps":60,"renderCalls":7,"nodeCount":3,"edgeCount":2,"labelCount":1,"halos":1,
 "activeNodes":0,"activeEdges":0,"focusId":null,"calls":7,
 "trace":{"query_id":"q_01m6kde11hs4efbskn5mm3r0sr","ts":1793800471595,"route":"local",
          "source":"symbolic","model_mode":"off","model_version":null,
          "seeds":1,"direct":1,"hop1":1,"hop2":1,"edges":2},
 "edges":{"aFlow":[0.6,0.3],"aMass":[1,0.211281],"aHop":[1,2],"count":2}}
```

- 同一查询的 `GET /api/trace/q_01m6kde11hs4efbskn5mm3r0sr`：

```
hop=0 fused_rank=1 rank=1/1 edge_mass=[]        path=0
hop=1 fused_rank=2 rank=2/2 edge_mass=[0.6]     path=1
hop=2 fused_rank=3 rank=3/3 edge_mass=[0.6,0.211281] path=2
```

读数自证：`aHop [1,2]` + `aFlow [0.6,0.3]` = 1 跳快流 / 2 跳慢流同图；`halos=1`、`labelCount=1`、
`trace.direct=1` = hop0 直击态走"亮节点 + 光晕 + 标签"独立通道；`calls=7 ≤ 12`；`trace=null` 的原路径
（无 trace）在单测里覆盖「全沉默」。

## 留给后面的

- **P2-26 直接接上**：`useTrace` + `fetchTraceList` + `TraceSummary` 已是回放所需的最小面；`traceEdgeAttrsFor`
  接受任意 `TraceRecord`，历史回放不需要改渲染层。`__moshiGraph` 目前没有 `mode/query_id`，P2-26 加
  `mode:'live'|'replay'` 时放在 `trace` 同级。
- **真 daemon 的 /mcp 解析问题**（坑 5）：`POST /mcp` 在 Fastify 下拿不到原始 body。这影响所有 HTTP MCP
  客户端，不是 P2-25 引入；建议 Lead 决定是否单开一张卡（例如用 `contentTypeParser` 或让 MCP handler 走
  `app.all('/mcp')` 原始流）。UI 验收本身不依赖它。
- `activeNodes` 仍只统计"点选活跃集"（P2-03 口径），证据直击节点计入 `halos`/`labelCount` 但不改这个读数；
  如果后端接口要求统一口径，改 `publish` 一行即可。
- 标签距离仍受 `LABEL_MAX_DISTANCE=120` 限制（小图默认取景可能没有标签）；这是 P2-03 既有行为，未在本卡改。
