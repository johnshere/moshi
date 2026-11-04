# P2-19A-18 图交互补强：2D 框选多选 + `/api/graph/neighbors/:id` + 批量影响预览

- 任务卡：task-21（P2-19A-18），revision 2
- 分支/工作区：J:\Workspace\Codes\moshi（未提交，交由 Lead 统一 commit）
- 依据：概设 §8.1「框选 → 批量影响预览」、§8.9 键盘可达；详设 §4.7（trace 只读消费）、D-89（不扩 /api/graph 既有契约）、D-97（可见集口径）；任务卡 task-21 全文。

## 目标

1. 后端新增 `GET /api/graph/neighbors/:id`：默认 depth=1（上限 2），每层 ≤200，超限 `truncated:true`；只含 active/disputed 可见集与未失效边；id 缺失/不可见 404，depth 非法 400。
2. 2D 视图拖框多选：空白处左键拖拽 → 半透明选框 → 松开写入 `selectedIds`；默认替换、Shift 合并、Esc 清空；画布坐标→世界坐标复用现有相机变换；选中集发布到 `window.__moshiGraph.selected`（只加字段）。
3. 选中 ≥2 节点时 HUD 出现「预览影响」，调 `POST /api/facts/batch/preview`（`action:'invalidate'`）显示 facts/edges/topics/invalidated_by_cascade 计数，不执行。

## 开工前事实核查

- `src/app/http/routes/graph.ts`：Fastify 插件 `graphRoutes(app, opts)`，`/` 用 `listGraph(...)`；同前缀 `/api/graph` 已在 `server.ts` 注册，新的 `neighbors/:id` 直接挂同一插件内即可，**无需 Lead 接线**。
- `src/infra/sqlite/graphRepo.ts`：已有 `VISIBLE = "epistemic_status IN ('active','disputed')"` 常量与 `listGraph`；新增查询沿用同一口径；`valid_to IS NULL` 过滤失效边。
- `src/ui/state/selection.ts`：只有 `selectedIds: Set` 预留注释，本次补 `setSelected(ids,{additive})`，保留 `select/clear` 语义。
- `src/ui/graph/Graph2D.tsx`：sigma 4.0.4 + `useSelection`，已有 `screenPos`/`viewportToGraph`/`graphToViewport`；点击节点经 `clickNode`，空白 `clickStage`。
- `src/ui/graph/Graph3D.tsx` 的 `publish()` 已写 `__moshiGraph`（P2-25/P2-26 字段：fps/renderCalls/…/mode/query_id/trace/edges），本卡只追加 `selected`，用 cast 写入（`src/ui/api.ts` 的 Window 类型不在本卡允许改动范围）。
- `/api/facts/batch/preview` 已存在（`src/app/http/routes/batch.ts`，body `{action, ids}`），前端未接触过；临时验收服务器需注册 `batchRoutes`。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `src/infra/sqlite/graphRepo.ts` | 只增：`NEIGHBOR_LAYER_CAP=200`、`NEIGHBOR_MAX_DEPTH=2`、`loadGraphNeighborhood(db,{id,depth,perLayerCap})`、`loadVisibleNodes`/`loadIncidentEdges`/`loadEdgesWithin`；BFS 每层按 max weight 降序、同权重 id 升序；超 cap 只置 truncated 不报错 |
| `src/app/http/routes/graph.ts` | 只增：`parseDepth`、`neighborNodeJson`（`etype`=ftype 兼容既有字段名）、`neighborEdgeJson`；`app.get('/neighbors/:id')` 返回 `{schema:'moshi-graph/1',id,depth,nodes,edges,truncated}`，`cache-control: no-store` |
| `src/ui/graph/pure/select.ts`（新） | 纯函数：`boxFromPoints`、`boxContainsPoint`、`screenBoxToWorld(view,a,b)`、`selectIdsInBox`、`beginDrag/updateDrag/dragScreenBox`、`mergeSelection`、`focusAfterBox`、`DRAG_THRESHOLD_PX=4` |
| `src/ui/state/selection.ts` | 增 `setSelected(ids,{additive})`（替换/合并、焦点取最后一个命中；相同集合返回原 state）；`select/clear` 不变 |
| `src/ui/graph/selectBridge.ts`（新） | `publishSelectedIds(ids)` 写入 `window.__moshiGraph.selected`（对象缺失时建最小对象，兼容 ?view=2d 深链） |
| `src/ui/graph/Graph2D.tsx` | 拖框：`downStage` → `beginBoxDrag`（window pointermove/up）→ `screenBoxToWorld` + `selectIdsInBox` → `setSelected`；选框 DOM（z-index 4）；Shift 合并；Esc 清空（跳过输入控件）；拖拽后抑制一次 click；`applyVisuals` 高亮多选；`publishSelected` |
| `src/ui/graph/Graph3D.tsx` | 只改 `publish()`：追加 `selected:[...useSelection.getState().selectedIds]`（cast 写入）；3D 不做框选 |
| `src/ui/main.tsx` | 仅 HUD：`ImpactPreview({ids})` 按钮 + 计数（`POST /api/facts/batch/preview`，body `{action:'invalidate',ids}`）；`selectedIds.size>=2` 时显示；2D 底部提示补「空白处拖框 = 框选（Shift 合并、Esc 清空）」 |
| `tests/unit/graph-select.test.ts`（新） | 12 例：box 归一化/含点、screenBoxToWorld 逆变换、selectIdsInBox 顺序、阈值/合并/Esc 等价 clear、setSelected 替换与合并、focusAfterBox |
| `tests/unit/graph-api.test.ts` | 只增 neighbors describe 10 例：默认 depth/字段、depth=2、非法 depth 400、404（不存在/归档）、205 邻居截断 200、可见集（archived/invalid 边剔除、disputed 保留）、无 layout、同权重稳定排序、无 token 401；文件共 22 例 |
| `temp/ui-accept/server.ts`（临时，非交付） | 验收 harness 补注册 `factRoutes`/`batchRoutes`（prefix `/api/facts`），使检查器与 preview 可用 |

## 规则映射

- D-89：`/api/graph` 既有字段未动，只加 `neighbors/:id` 新路由；`__moshiGraph` 只加 `selected`。
- D-97：邻域节点严格用 `VISIBLE`（active/disputed），边 `valid_to IS NULL`。
- 不新增 draw call：2D 选框是普通 DOM div，不参与 WebGL；3D 仅 publish 追加字段（calls 仍 ≤ 12）。
- 无视觉美化：选框仅半透明边框/底色；不改既有配色与样式。
- 失败两次即上报：本卡只出现一次 404（harness 未注册 batchRoutes）与一次 sigma 事件目标错误（canvas vs .sigma-mouse），均一次修复，无第三次尝试。

## 踩坑

1. **sigma 4.0.4 的鼠标监听挂在 `div.sigma-mouse` 上，不是 canvas**：合成事件打 canvas 时 `downStage` 不触发；必须 `pointerdown` 在 `.sigma-mouse`，`pointermove/up` 在 window。
2. **拖框与相机平移冲突**：`downStage` 里 `payload.event.preventSigmaDefault()` 后 sigma 不再平移，否则拖框会同时拖动相机。
3. **拖框后误触 click**：松手时 sigma 仍会派发 clickStage/clickNode，用 `suppressClick` 标记吞掉下一次点击（`consumeSuppressedClick()`）。
4. **Esc 双重语义**：window keydown Esc 清空选中，但检查器也监听 Esc 关闭；本卡只在 target 不是 INPUT/TEXTAREA/SELECT/contentEditable 时清空。二者同时发生（清空 + 关面板）可接受，概设 §8.9 的 Esc = 清空。
5. **节点 id 即 fact id**：`/api/graph` 的节点来自 fact 视图（P2-03），没有额外 `factId` 字段；preview 直接传节点 id，无需 neighbors 反查（卡内给了兜底口径，这里按「节点 id = fact_id」实现并记录）。
6. **验收时截图空白**：3 节点 layout 纵向跨度大，sigma 自动 fit 后贴上下边被 HUD/提示栏遮住；用临时 `temp/ui-accept/place2.ts` 把 layout 摆成横向一条线（x=-15/0/15，z=0/2/0）后可见。属验收夹具问题，不是产品缺陷。
7. **`window.__moshiGraph.selected` 与 `__moshiGraph2d`**：既有 2D 深链页面可能没有 `__moshiGraph`（3D 才建），`selectBridge` 缺对象时建最小对象避免抛错。
8. **`typecheck:ui` 一度被 `src/ui/shell/Shell.tsx(12,1)` 的未使用 `FirstRun` 挡住**（archive 队友 task-12 WIP，本卡禁改 shell）；交付时复跑已绿。

## 验收

```powershell
pnpm typecheck
# 本卡文件零错误；全仓仅剩他人 WIP 的 tests/unit/diag.test.ts(27,34)/(28,1) TS6133
# （'makeEntity'/'addAlias' 未使用，diag 队友 task-14 文件，不在本卡 scope）。

pnpm --filter moshi-ui typecheck
# ✔ 通过（Shell.tsx 的 FirstRun 已由 task-12 修复后复跑）

pnpm vitest run tests/unit/graph-api.test.ts tests/unit/graph-select.test.ts
# Test Files  2 passed (2)
# Tests       34 passed (34)   # graph-select 12 + graph-api 22
```

真实 neighbors 输出（临时 harness 53001，页面内 fetch，token=accept-token）：

```json
GET /api/graph/neighbors/f_01m6kdak0mrwae97f3924pf3wz?depth=2
{"schema":"moshi-graph/1","id":"f_01m6kdak0mrwae97f3924pf3wz","depth":2,
 "nodes":["f_01m6kdak0mrwae97f3924pf3wz","f_01m6kdak0qtyb4pz51jqssv82a","f_01m6kdak0qtyb4pz51jqssv82b"],
 "edges":["f_01m6kdak0mrwae97f3924pf3wz->f_01m6kdak0qtyb4pz51jqssv82a:depends_on",
          "f_01m6kdak0qtyb4pz51jqssv82a->f_01m6kdak0qtyb4pz51jqssv82b:logic"],
 "truncated":false}
GET /api/graph/neighbors/f_01m6kdak0mrwae97f3924pf3wz?depth=3  -> 400 {"error":"E_INPUT"}
GET /api/graph/neighbors/f_nope                                  -> 404
```

浏览器验收（1280x800，`http://127.0.0.1:53080/ui/graph/?token=accept-token&view=2d&limit=100`）：

- 拖框 (180,330)→(800,500)：`window.__moshiGraph.selected = ["f_01m6kdak0mrwae97f3924pf3wz","f_01m6kdak0qtyb4pz51jqssv82a"]`（长度 2）。
- Shift 合并再拖 (1150,400)→(1275,520)：selected 长度 3（含 `f_01m6kdak0qtyb4pz51jqssv82b`）。
- 按 Esc：`selected = []`。
- 选中 2 个时点「预览影响」：HUD 文本 `预览影响事实 2 · 边 2 · 主题 0 · 级联失效 0`（DOM 全文；窄视口下按钮行会被检查器宽度视觉截断）。
- 截图（证据已落盘 `temp/ui-accept/`）：
  - `p2-19a-select-3nodes.png`：3 节点可见、选中 3 个后（`selected` 长度 3）。
  - `p2-19a-select-preview.png`：选中 2 个 + 「预览影响」计数（事实 2 · 边 2 · 主题 0 · 级联失效 0）。

## 接线

无需 Lead 接线：`neighbors` 路由挂在既有 `graphRoutes` 插件内（prefix `/api/graph` 已注册）；`__moshiGraph.selected` 由 Graph3D/Graph2D 的 publish 自动追加。

## 留给后面的 / 遗留

1. 3D 视图未做框选（卡允许「保留既有行为」）；`__moshiGraph.selected` 在 3D 已发布，可供 P2-19-B 视觉改造复用。
2. `src/ui/api.ts` 的 `Window['__moshiGraph']` 类型未加 `selected`（不在本卡允许改动范围），Graph3D 用 `as unknown as` 写入；建议后续统一补类型。
3. 选中集在刷新/关闭检查器时会被清空（`clickStage`/`selection.clear`），未提升为 URL 状态；卡未要求。
4. 选框坐标换算依赖 `renderer.viewportToGraph`，若 P2-19-B 改相机（如 3D 化 2D），需复用 `screenBoxToWorld` 并补回归。
5. `temp/ui-accept/place2.ts` 与 harness 改动是验收夹具，随 temp 目录保留，不属交付源码。
6. HUD 按钮行在窄视口（<1400px）+ 检查器打开时会被遮挡/截断，DOM 全文可读；后续 P2-19-B 调整 HUD 布局时一并处理。
7. 最终提交前需等 diag 队友修掉 `tests/unit/diag.test.ts` 的 TS6133（`makeEntity`/`addAlias` 未使用）并修 `src/ui/shell/` 相关 WIP，`pnpm typecheck` 才能全绿；本卡自身文件无错误。
