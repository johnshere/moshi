# P2-19-C 进度：控制台视觉改版（科技感 + 明暗主题）

- 任务：9836 控制台（`src/ui`）视觉改造，**不动任何既有功能**：只换令牌、外壳尺寸、圆角/胶囊、画布舞台色与主题切换。
- 起点：用户否决「只交设计稿」，要求直接改真实仓库界面（原话「按照这个 GUI 和这个文档去改」）。
- 工程：`J:\Workspace\Codes\moshi\src\ui`（独立 Vite 工程，产物 `src/app/ui/dist`，由 `src/app/http/static.ts` 托管 `/ui/graph`）。

## 已完成

| 项 | 落点 | 说明 |
| --- | --- | --- |
| 夜/日两套令牌 | `styles/app.css` | 暗 `#0b0c0e`/`#121316`/`#0a84ff`；亮 `#f1f2f4`/`#fcfcfd`/`#0071e3`；`html[data-theme='light']` 覆盖同名 `--color-*`，组件零改动即生效 |
| 圆角三档 | `--radius-panel 20` / `--radius-control 8` / `--radius-pill 999` | 组件内联 `borderRadius` 字面量批量收拢 3/4/5→6、6→8、10/12→14 |
| 主题三档 | `theme.ts` + `shell/ThemeSwitch.tsx` | `moshi-theme = system|light|dark`；`<html data-theme/data-theme-mode/color-scheme>`；顶栏右侧分段按钮（自动/亮/暗，`data-testid=theme-*`） |
| 首屏防闪 | `index.html` | 内联脚本先定 `data-theme`；保留 token 注入锚点整句（`window.__MOSHI_TOKEN__ = window.__MOSHI_TOKEN__ || ''`） |
| 外壳 | `shell/Shell.tsx` | 侧栏 172→208、顶栏 46→56、品牌标记、导航项 8px 圆角、`SF Pro Text` 字栈 |
| 顶栏控件 | `SearchBox` / `ScopeSwitcher` / `ThemeSwitch` | 一律胶囊 + 轻量聚焦环（去掉霓虹 glow） |
| 图谱页 | `main.tsx` / `FilterBar` / `FactsTable` | 标题 17px；视图切换改胶囊分段；筛选条胶囊（选中态 accent 14% 底 + accent-soft 字）；表头 11px、去斑马纹、分隔线改 border-subtle |
| 画布舞台 | `graph/pure/palette.ts` + `app.css` | 新增 `--color-stage-base/-raised/-text/-grid`：**外壳可亮、画布恒深场**（加法混合的点线在浅底会发白）；`Graph3D` 分层网格改按场景现取色 |
| 主题切换联动 | `main.tsx` | 订阅主题变化 → `resetPaletteCache()` + 画布 `key` 重建（不动数据/筛选） |
| 首开提示条 | `shell/FirstRun.tsx` | 移到右下角，不再压 HUD 与表头 |

## 验收证据（2026-11-15，本机 9836）

- `node node_modules/vite/bin/vite.js build`：125 模块，`dist/assets/index-*.css` 16.1KB / `index-*.js` 1355KB，✓ built。
- `tsc -p tsconfig.json --noEmit`：exit 0。
- vitest `tests/unit/graph-visual.test.ts` + `tests/unit/table-rows.test.ts`：41 passed。
- Playwright（1440×900，真实 daemon）：
  - 点 `[data-testid=theme-light]` → `data-theme=light`，**不刷新**即换肤且画布变浅观感正常；`localStorage=light`。
  - 刷新后仍 `light`。
  - `theme-system` + `emulateMedia(colorScheme=dark/light)` → `data-theme` 跟随 `dark`/`light`。
- 截图：`temp/ui-shots/{graph-dark,graph-light,memories-dark,memories-light,inbox-dark,settings-light,table-dark}.png`、`toggle-*.png`。

## 未做 / 待定

- 设置页未加「外观」说明块（目前只在顶栏给三档开关）。
- 亮色主题下 3D 画布沿用深场（设计取舍）；若用户希望画布也随主题变亮，需要改 shader 混合模式，属另一档改动。
- `docs/任务台账.md` §1/§3 已加 P2-19-C 行、§6 由月度日志承接；commit 未做（等用户验收）。
