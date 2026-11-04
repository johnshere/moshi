# P2-19-B 外壳与 HUD 动效（task-32）进度

- 状态：**DONE（自测通过，待 Lead 统一 verify/build 与 commit）**
- 任务：task-32（P2-19-B：左侧导航/搜索/三灯/FirstRun 卡片化 + HUD 玻璃化/数值高亮/spinner/TraceNote 徽章 + reduced-motion）
- 日期：2026-11-04

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/ui/styles/app.css` | 追加玻璃面板、导航指示条、呼吸灯、首开卡片、HUD 数值、TraceNote 徽章、spinner 的 utilities/keyframes 与 `prefers-reduced-motion` 停用规则（不改既有 token 值） |
| `src/ui/shell/Shell.tsx` | 导航 `aside` 加 `moshi-nav`；导航项加 `moshi-nav-item` + `data-active`（左侧 2px accent 指示条/微光、hover 120ms）；三灯圆点加 `moshi-light-dot` + `data-state`（warn 2.4s 呼吸）；待办角标加 `moshi-inbox-badge` + `data-count`（N>0 warning 色调+微光，N=0 中性灰） |
| `src/ui/shell/SearchBox.tsx` | 输入框聚焦时 accent 边框 + `--color-glow` 外发光（复用既有 `focusWithin` state，无 DOM/事件变化） |
| `src/ui/shell/FirstRun.tsx` | 卡片化（`.moshi-firstrun` 玻璃 + 顶部细引导线），位置移到 HUD 下方右侧（top 196/right 14），不遮挡 HUD |
| `src/ui/main.tsx` | HUD 容器加 `moshi-hud` 玻璃；`Badge` 数值等宽 + `tabular-nums`，变化时 160ms 高亮淡出；HUD 右上 `loading` spinner；TraceNote 直击/1 跳/2+ 跳加 `moshi-trace-badge` 徽章 |

未改：`src/ui/graph/**`、路由、请求、DOM 结构、既有 `data-testid`、既有 token 值、server.ts/cli/index.ts/main.ts/package.json/migrations。

## 关键决策

1. **只做 DOM 层**：所有动效在 CSS 与 React 文本层完成，不进入 3D 画布；`window.__moshiGraph.calls` 改前/改后一致（实测 7 沉默 / 8 选中，完全不变）。
2. **颜色只用 token/`color-mix`**：新增 CSS 无裸 hex/rgba；`tools/check-visual.ts` 0 违规。
3. **reduced-motion**：动画/过渡在 `prefers-reduced-motion: reduce` 下停用；注意呼吸灯规则用了属性选择器（更高 specificity），媒体查询里必须写同 specificity 的 `.moshi-light-dot[data-state='warn']` 才能覆盖（首版漏了，已修）。
4. **FirstRun 不抢 HUD**：改到 HUD 之下右侧（top 196、right 14），卡片 + 顶部细引导线；`ready` 时仍零占位。
5. **待办只调视觉不改结构**：N=0 中性灰静默、N>0 warning 色调 + 微光；角标 `data-testid` 与文本保留（避免破坏既有验收脚本）。
6. **数值高亮**：`Badge` 内比较上一值，变化后 160ms 淡出；不动数据流与轮询。

## 验收命令与输出

```
pnpm typecheck:ui
→ 无输出（exit 0）

pnpm vitest run tests/unit/shell.test.ts tests/unit/first-run.test.ts
→ 2 files / 32 tests passed

pnpm exec tsx tools/check-visual.ts --json
→ {"schema":"moshi-check-visual/1","files_scanned":55,"violations":[],"count":0}
```

UI 构建（仅用于浏览器验收，非根 build）：

```
cd src/ui
pnpm exec vite build --outDir ../../temp/ui-accept/p2-19b/before-dist --emptyOutDir
pnpm exec vite build --outDir ../../temp/ui-accept/p2-19b/after-dist  --emptyOutDir
→ 两次均成功（after css 13.58 kB / js 1,302.35 kB）
```

## 浏览器验收（真实 buildHttpApp + 临时数据目录 + seedGraph 5000 facts / 15000 edges）

- harness：`temp/ui-accept/p2-19b/harness.ts`；CDP 抓取脚本：`temp/ui-accept/p2-19b/capture.mjs`；报告：`temp/ui-accept/p2-19b/readings-before.json` / `readings-after.json`。
- 页面：`http://127.0.0.1:53120/ui/graph?token=accept-token`（临时 home 为 `temp/ui-accept/p2-19b/home`，未触真实 `~/.moshi`）。

### `window.__moshiGraph.calls`（改前 → 改后）

| 状态 | before | after |
| --- | --- | --- |
| 沉默（未选中） | `calls=7`, `renderCalls=7`, nodes 1000 / edges 632 | `calls=7`, `renderCalls=7`, nodes 1000 / edges 632 |
| 活跃（选中节点） | `calls=8`, `renderCalls=8` | `calls=8`, `renderCalls=8` |

> 卡面写「calls 应保持 6」，但当前 HEAD 实测基线就是 **7（沉默）/ 8（选中浮层）**；本卡未使任一数值变化（before=after），结论是「未新增 draw call」。若卡面的 6 指别的基础口径，请 Lead 以实测基线为准。

### 动效读数（after）

- 三灯：`light-daemon: ok/none`、`light-sidecar: off/none`、`light-vector: warn/moshi-pulse/2.4s`；两帧间隔 1.2s 截图 `p2-19b-hud-lights-a.png` / `-b.png`。
- reduced-motion（CDP `Emulation.setEmulatedMedia` 模拟）：三灯 `animationName` 全部为 `none`。
- 搜索聚焦：`borderColor: rgb(34, 211, 238)`、`boxShadow` 含 1px accent ring + 16px `--color-glow`。
- HUD 数值：`fontFamily: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`，`font-variant-numeric: tabular-nums`。
- 加载 spinner：网络延迟 800ms 下点「刷新」，`.moshi-spinner` 计数 = 1。
- HUD innerText 片段：`节点 1000 / 5000 边 632 / 15000 draw calls 7 fps 48.7 标签 0 刷新 加载全量（5000）`。
- FirstRun：`data-state=sidecar_off`，文案「语义检索未启用（可选）/ 不影响使用…」；卡片位于 HUD 下方右侧。

### 截图（`temp/ui-accept/`）

- `p2-19b-hud-graph-silent.png`（沉默态，含导航指示条/玻璃/HUD）
- `p2-19b-hud-graph-active.png`（点选节点、检查器打开、活跃调用）
- `p2-19b-hud-inbox.png`
- `p2-19b-hud-settings.png`
- `p2-19b-hud-lights-a.png`、`p2-19b-hud-lights-b.png`（warn 呼吸两帧）
- `p2-19b-hud-search-focus.png`（搜索聚焦发光）
- `p2-19b-hud-firstrun.png`（首开卡片 + 引导线）

## Lead 接线

无：本卡只改 `src/ui/**` 展示层，不需要 server.ts / cli/index.ts 改动；`pnpm typecheck:ui` 与 `check-visual` 已覆盖。

## 遗留

- TraceNote 徽章已实现并通过 typecheck，但验收时无查询 trace，未截图（需一次真实查询才显示）。
- FirstRun 位置常量（top 196）按「HUD 高度」估算；若后续 HUD 行数增加需同步调整。
