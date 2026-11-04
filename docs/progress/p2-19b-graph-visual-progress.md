# P2-19-B 图谱视觉：背景雾、边流光与箭头、节点环与扫描环（task-30）

起止：2026-11-04 22:57 → 2026-11-04 23:14（Asia/Shanghai）
依据：docs/任务台账.md §4 P2-19-B（task-30 卡）、详设 §10.3.1/§10.3.2、用户 D-133、编码 D-116/D-119
分支状态：本卡只改 `src/ui/graph/**` 与其测试；未提交（不跑 git）

## 目标

把 `/ui/graph` 的视觉从「功能可见」提到「深空蓝紫底 + 青蓝霓虹」的科技感，四项手段都必须**不新增 WebGL draw call、不引入 bloom**：

1. 背景渐变 + 网格雾（3D DOM 层 / 2D canvas 叠加）
2. 边流光的方向感 + 2D 小方向箭头（按密度裁剪，禁止每边一个 mesh）
3. 节点圆环内芯（现有 1 个节点 mesh 里用 shader 圆环遮罩）
4. 选中扫描环（角度随时间旋转；无选中不渲染）

同时新建 `palette.ts` 收编颜色：graph 目录内除 `palette.ts` 外不得出现 hex/rgba 字面量，token 未上线时 fallback 可跑。

## 开工前的事实核查

- 渲染管线现状：节点 1 + 边 1 + 光晕 1 + 层包络 1 + 参考平面 4 = 7 次 draw call（`renderer.info.render.calls` 读数 6–7，随包络数量浮动）。
- 颜色分散在 `Graph3D.tsx`（`BG_COLOR`、`PLANES`、`etypeUniforms`、光晕贴图、标签内联样式）、`Graph2D.tsx`（`BG_COLOR`、SIGMA_STYLES、选框 rgba）、`pure/encoding.ts` 三处。
- 节点主 mesh 是 `SphereGeometry(1,8,6)` 的 InstancedMesh + `installNodeAlpha(onBeforeCompile)`；已有注入点可复用（P2-25 用同机制做过 trace 节点透明度）。
- 选中集合有两条来路：`useSelection.selectedIds`（2D 框选/点选）与 `focusId`（URL `?focus=`），发布在 `window.__moshiGraph.selected`。
- 2D 用 sigma v4.0.4：节点/边各 1 次 draw；不能为箭头新增 sigma 图层，因此箭头放在 host 上的独立 2D canvas（DOM 层，不进 WebGL 计数）。
- 5k 种子库已有（`temp/p2-19b-5k/data`，fact 5000 / edge 15000 / layout 5000），独立 harness 53002 可复用。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `src/ui/graph/pure/palette.ts`（新，232 行） | 10 个 token 名 + `TOKEN_FALLBACK`（旧色板值）+ `readToken`（CSS 变量优先、空/异常回落、结果缓存）+ `ftypeHex/etypeHex` + `withAlpha/mixWithTransparent/mixWith` + 用途函数：`bgBaseHex/accentHex/glowHex/dangerHex`、`sceneBackdropCss`（两团 radial + 竖向 linear）、`sceneVignetteCss`、`gridCss`（44px 双轴网格）、`stageGlowCss`、`labelCss`、`haloStops`、`boxBorderCss/boxFillCss`、`arrowCss(mass)`、`selectionRingRgb`、`layerPlaneHexes` |
| `src/ui/graph/pure/fx.ts`（新，141 行） | `ARROW_MAX_2D=140`、`ARROW_MIN_LENGTH_PX=18`、`ARROW_SPEED=0.35`、`arrowStride/arrowPhase/placeArrow/screenLength`；`SCAN_SPEED=1.75`、`SCAN_WIDTH=0.85`、`scanAngle/angularDistance/scanBand`；`sphereRim/ringBand/coreGlow`；`gridOpacity` |
| `src/ui/graph/pure/encoding.ts` | `FTYPE_HEX/ETYPE_HEX` 改为调 `palette.ftypeHex/etypeHex`（键名、数学不变），删除重复字面量 |
| `src/ui/graph/Graph3D.tsx` | 背景改为 DOM 渐变 + vignette 层（canvas 透明，`setClearAlpha(0)`，renderer `alpha:true`）；平面颜色改 `layerPlaneHexes()`；边 shader 的 dot 改彗星头（`head` 进 intensity/alpha）；节点 material 加 `installNodeFx`：rim 环带 + 内芯 + `aNodeSel` 选中扫描（uniforms `uTimeSel/uScanSpeed/uScanWidth`），仍 1 个节点 draw call；选中集合 = `selectedIds ∪ focusId`（订阅 selection 变化写 InstancedBufferAttribute）；`loop` 推进 `uTimeSel`；标签样式走 `labelCss()`；光晕贴图三 stop 走 `haloStops()`；`etypeUniforms` 走 `etypeHex` |
| `src/ui/graph/Graph2D.tsx` | 删除 `BG_COLOR`；SIGMA_STYLES `stage.background` 走 `bgBaseHex()`；host 叠加 gridEl（z1，`gridCss()`，透明度按 camera.ratio 经 `gridOpacity` 调）、glowEl（z2，`stageGlowCss()`，screen 混合）、arrowCanvas（z3）；`drawArrows(now)` 只画证据边（`traceAttr.flow>0`），`arrowStride` 跳采样、`screenLength` 过短的边跳过、`placeArrow` 放三角形、`arrowCss(mass)` 上色；选框 rgba 走 `boxBorderCss/boxFillCss`；dispose 移除三层 |
| `tests/unit/graph-visual.test.ts`（新） | 23 例：node 环境 fallback 取色、ftype/etype 语义色、withAlpha/mixWith 边界、haloStops/layerPlaneHexes/selectionRingRgb、CSS 片段来源、arrowStride 密度、arrowPhase 相位、placeArrow 方向/留白/夹取、screenLength、scanAngle/scanBand、sphereRim/ringBand/coreGlow、gridOpacity |
| `tests/unit/graph-2d.test.ts` | 2 处断言随语义色 token 化更新：`derived`/未知 etype → `--color-border-subtle`（`#1e293b`），不再是旧 fallback `#475569` |
| `docs/progress/p2-19b-graph-visual-progress.md`（本文件） | — |

## 规则映射

- **D-133**：深空蓝紫底 + 青蓝霓虹；允许背景渐变/网格雾、边流光+箭头、节点环、选中扫描环；预算不放宽。
- **D-116 / D-119**：不动流动语义（aFlow/aMass/aHop 的取值、hop 相位、排序），只增强视觉表达；`trace.ts` 数据源未改。
- **§10.3.1 双态**：沉默态仍低不透明/不流动；本卡只加「可辨」的背景与环，未抬高沉默态亮度（见截图 silent）。
- **§10.3.2 预算**：节点仍 1 个 mesh/1 次 draw；背景、网格、箭头、扫描环都不新增 WebGL draw call；未引入 postprocessing/bloom。
- **契约**：`/api/graph` 未改；`__moshiGraph` 只加字段（本卡未加新字段）；Graph3D/Graph2D 对外 props 未改。

## 踩到的坑

1. **根 tsconfig 没有 DOM lib**：`palette.ts` 直接写 `document` 会让 `pnpm typecheck`（含 tests）报 TS2584。改成 `globalThis` 的结构化声明（`PaletteGlobal`，`document?` + `getComputedStyle?`），浏览器命中、node 为 undefined，两边都不需要 lib DOM。
2. **etype 语义色 token 化会改既有断言**：`derived_from`/未知 etype 现在映射到 `--color-border-subtle`（旧 fallback `#475569` → 新 `#1e293b`），`graph-2d.test.ts` 两处断言同步更新；这是有意收敛到 token，不是回归。
3. **2D 箭头不能进 sigma**：sigma 的边是单层 WebGL 线，画箭头要么加 draw call 要么加几何；改为 host 上独立 2D canvas（z3，pointer-events none）。成本只与「证据边数量」有关，与总边数无关；无 trace 时是空画布。
4. **ringBand 在 0.8 只有 0.5 亮度**：`smoothstep(0.74,0.86)` 的中点是 0.8，测试取 0.86 才是满环带；shader 与测试共用 fx 常量，避免"测一条、跑一条"。
5. **后台标签页 fps=1**：chrome-devtools 多标签下页面不前台时 rAF 被节流，读数前必须 `select_page(bringToFront:true)`，否则会误判"5k 退化"。
6. **before 截图后我又挪过节点**：`place3.ts` 第一次只摆了六边形（strength 未统一），节点 3D 层高差大、取景远；统一 strength=0.85/importance=0.7 并重摆后才得到稳定取景。改前截图 `p2-19b-graph-before.png` 用的是最终摆位，可逐点对比。

## 验收

```text
$ pnpm --filter moshi-ui typecheck
> tsc -p tsconfig.json --noEmit        # 通过

$ pnpm typecheck
> tsc -p tsconfig.json --noEmit        # 通过（含 tests，palette/fx 无 DOM 依赖）

$ pnpm vitest run tests/unit/graph-2d.test.ts tests/unit/graph-activity.test.ts \
    tests/unit/graph-encoding.test.ts tests/unit/graph-geometry.test.ts \
    tests/unit/graph-trace.test.ts tests/unit/graph-select.test.ts \
    tests/unit/graph-api.test.ts tests/unit/graph-visual.test.ts
Test Files  8 passed (8)
     Tests  145 passed (145)
```

浏览器读数（1280×800，vite dev 53080 + harness 53001，真实 Fastify + 真实查询）：

- 改前（`p2-19b-graph-before.png`）：`{fps:60, calls:6, nodeCount:6, edgeCount:2}`，无背景雾。
- 沉默态（`p2-19b-graph-silent.png` / `-after.png`）：`{fps:60, calls:6, nodeCount:6, edgeCount:2, labelCount:0, halos:0}`，无 trace 时无大面积流光。
- 活跃态（`p2-19b-graph-active.png`，POST `{"query":"alpha"}` 产生真实 trace）：`{fps:60, calls:7, nodeCount:6, edgeCount:2, labelCount:1, halos:1}`；trace `{seeds:1, direct:1, hop1:1, hop2:1, edges:2}`，边 `{aFlow:[0.6,0.3], aMass:[1,0.211281], aHop:[1,2]}`（沿用 P2-25 采集）。
- 选中态（`p2-19b-graph-selected.png`，`?focus=f_01m6kdak0mrwae97f3924pf3wz`）：`{calls:7, halos:1, labelCount:1, selected:["f_01m6kdak0mrwae97f3924pf3wz"]}`。
- 2D 箭头（`p2-19b-graph-2d-arrows.png`，view=2d + 同一 trace）：`__moshiGraph2d = {fps:60, nodeCount:6, edgeCount:2}`；独立箭头 canvas `1108×754`，`getImageData` 非透明像素 `103`（2 条证据边各 1 支箭头），证明箭头层在画且不影响 sigma 图层。

5k 节点（`tools/seed-graph.ts --facts 5000 --edges 15000`，harness 53002，vite 53181）：
`temp/ui-accept/p2-19b-graph-5k.json` + `p2-19b-graph-5k.png`

```json
{"fps":60,"renderCalls":7,"nodeCount":5000,"edgeCount":15000,"labelCount":0,"halos":0}
```

截图清单：

- `temp/ui-accept/p2-19b-graph-before.png`
- `temp/ui-accept/p2-19b-graph-after.png`
- `temp/ui-accept/p2-19b-graph-silent.png`
- `temp/ui-accept/p2-19b-graph-active.png`
- `temp/ui-accept/p2-19b-graph-selected.png`
- `temp/ui-accept/p2-19b-graph-2d-arrows.png`
- `temp/ui-accept/p2-19b-graph-5k.png`

## 留给后面的

1. `palette.ts` 的 token 目前读 `document.documentElement` 的 CSS 变量；task-29 的 `styles/app.css` 上线后颜色会自动切换，无需改本卡代码。若 token 名有出入，只改 `PaletteToken`/`readToken` 一处。
2. `selectionRingRgb()` 已导出但当前 shader 用的是白色扫描高光 + accent 环带（避免与直击光晕抢色）；后续若要染色扫描环，把 `vec3(1.0)` 换成该 uniform 即可，无需改结构。
3. 3D 背景/vignette 是 host 上的 DOM 层（z-index 0/2），标签渲染器在 z3；若后续 HUD 玻璃面板要压在图上，注意 z-index 顺序（HUD 在 graph host 之外，不受影响）。
4. 2D 箭头当前只服务 trace 证据边；若以后要表达「边类型方向」，建议扩展 `traceEdgeAttrsFor` 而不是在 Graph2D 里造第二套方向语义。
5. 5k 下节点密集处 rim/ring 会叠成一片亮斑（见 5k 截图）；这是密度限制不是 shader bug。若要压，可把 `ringBand` 的强度乘一个全局 `uRingGain`，但会改变单节点观感，需视觉验收后再调。
