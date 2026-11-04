# P2-19-B 样式地基（task-29）进度

> 状态：实现 + 自测 + 浏览器验收完成，待 Lead 验收/提交。
> 范围：Tailwind v4 地基 + 语义 token + `src/ui/**`（`graph/**` 除外）裸颜色字面量清零。

## 目标与依据

- D-133：引入 Tailwind + 语义 token；深空蓝紫底 + 青蓝霓虹强调。
- 验收口径：界面无裸 hex（`tools/check-visual.ts`）；`renderer.info.render.calls ≤ 12`；禁 bloom；5k 节点 30fps 不放宽。
- 本卡只做地基与颜色 token 化；`src/ui/graph/**` 按 Lead 指示留给 trace 的视觉卡（task-30）。

## 决策

- D1：Tailwind v4 走 `@tailwindcss/vite` 插件，不引入 PostCSS 配置；`vite.config.ts` 的 base/outDir/server 原样保留。
- D2：token 用固定语义名（见下），另补少量派生 token（`*-soft`/`*-dim`/`*-bg`/`info` 系、`bg-hover`/`bg-active`、`shadow-*`），避免组件里拼接 hex/rgba。
- D3：组件内颜色一律 `var(--color-*)`；透明叠加用 `color-mix(in srgb, var(--color-x) N%, transparent)`；阴影收敛到 `var(--shadow-panel|float|menu)`。
- D4：`src/ui/graph/**` 未改（trace 正在该目录做视觉卡）；`check-visual` 仅剩 graph 的 24 条，见“遗留”。
- D5：不做 DOM/data-testid/事件/API/路由改动；本轮没有做大规模 className 收敛，避免与并行视觉卡冲突——token 已可被 Tailwind utility（如 `bg-bg-base`、`text-text-primary`）直接消费，后续卡再收敛重复面板样式。
- D6：`@theme` 里的 token 同时生成 CSS 变量与 Tailwind 主题，组件 inline style 与 utility 共用同一份值。

## 改动文件

- `src/ui/package.json`：devDependencies +`tailwindcss@^4.3.4`、`@tailwindcss/vite@^4.3.4`（`pnpm --filter moshi-ui add -D` 真跑；`pnpm-lock.yaml` 随之更新）。
- `src/ui/vite.config.ts`：`plugins: [react(), tailwindcss()]`，其余配置不动。
- `src/ui/styles/app.css`（新）：
  - `@import "tailwindcss";` + `@theme` token：
    `--color-bg-base`、`--color-bg-raised`、`--color-bg-overlay`、`--color-bg-hover`、`--color-bg-active`、
    `--color-border-subtle`、`--color-border-strong`、
    `--color-text-primary`、`--color-text-secondary`、`--color-text-muted`、`--color-text-faint`、
    `--color-accent`、`--color-accent-soft`、`--color-accent-dim`、`--color-accent-alt`、`--color-glow`、
    `--color-success` / `-soft` / `-dim` / `-bg`，warning 同，danger 同，
    `--color-info` / `-strong` / `-soft` / `-dim` / `-bg` / `-text`；
    `--radius-panel: 12px`、`--radius-control: 4px`、`--shadow-panel`、`--shadow-float`、`--shadow-menu`。
  - `body { background: var(--color-bg-base); color: var(--color-text-primary); }`。
- `src/ui/main.tsx`：顶部 `import './styles/app.css';`。
- `src/ui/{main.tsx,shell,table,inspector,inbox,memories,archive,settings,filter,history}/**`：21 个文件，裸 hex/rgba → `var(--color-*)` / `color-mix(...)` / `var(--shadow-*)`；无 DOM/testid/事件改动。

## 验收记录

### 安装 / 构建 / 类型

```
pnpm --filter moshi-ui add -D "tailwindcss@^4" "@tailwindcss/vite@^4"
Done in 3.6s using pnpm v10.15.1

pnpm --filter moshi-ui run build
✓ 112 modules transformed.
../app/ui/dist/index.html                     0.90 kB │ gzip:   0.60 kB
../app/ui/dist/assets/index-Dm0Txp87.css     10.16 kB │ gzip:   2.80 kB
../app/ui/dist/assets/index-CW5c0qbQ.js   1,293.66 kB │ gzip: 348.02 kB
✓ built in 3.26s

pnpm typecheck        # clean
pnpm --filter moshi-ui run typecheck   # clean
```

### 裸颜色清零（`npx tsx tools/check-visual.ts --json`）

- 迁移前：**490** violations / 54 files（含 graph）。
- 迁移后：**24** violations，全部在 `src/ui/graph/**`：
  - `src/ui/graph/Graph2D.tsx` 3
  - `src/ui/graph/Graph3D.tsx` 12
  - `src/ui/graph/pure/encoding.ts` 9
- 排除 graph 后：**0 violations**（`src/ui` 其余目录全部清零）。
- 产物 CSS 含 token：`grep --color-bg-base` 命中，10,184 bytes。

### 测试

- 定向 UI 相关：`pnpm vitest run tests/unit/shell.test.ts tests/unit/table-view.test.ts tests/unit/table-rows.test.ts tests/unit/inbox.test.ts tests/unit/archive-page.test.ts tests/unit/privacy-panel.test.ts tests/unit/accept-ui.test.ts tests/unit/config-api.test.ts tests/unit/static.test.ts tests/unit/check-visual.test.ts` → **10 files / 140 tests passed**。
- 全量 `pnpm vitest run tests/unit`：**105 passed / 1 failed**，唯一失败 `tests/unit/graph-2d.test.ts > etype → hex 走同一张表`（`expected '#1e293b' to be '#475569'`）。该文件在 trace 的 task-30 改动范围内（`src/ui/graph/**` 迁移中），与本卡无关；本卡未改 graph 文件。
- `pnpm lint:deps` ✔（160 模块/730 依赖）；`pnpm lint:writes` ✔ 111 文件；`pnpm lint:lifecycle` ✔ 111 文件。

### 浏览器验收（真实 Fastify + `temp/ui-accept/p2-19a/harness.ts`，port 53110 / token=accept-token）

- `/ui?token=...` → `/ui/graph?token=...`（static.ts 302 保持）。
- `body` 计算样式：`background: rgb(5, 7, 13)`、`color: rgb(248, 250, 252)`；token 读取：
  `--color-bg-base=#05070d`、`--color-bg-raised=#0b1220`、`--color-accent=#22d3ee`、`--color-accent-alt=#8b5cf6`、`--color-text-primary=#f8fafc`。
- `/ui/graph`：`window.__moshiGraph = { calls: 6, nodes: 3, edges: 2, fps: 60 }`（≤12，未因样式增加）；nav 5 项。
- `/ui/memories`：3 行、`window.__moshiTable.requests=1`、fps 60。
- `/ui/inbox`：三 tab（消解确认 0 / 低置信 0 / 淘汰候选 0）+「刷新」。
- `/ui/archive`：3 主题列表 + 自动选中「开发环境」+ markdown 预览。
- `/ui/settings`：ConfigForm / MaintenancePanel / PrivacyPanel / DiagPanel（I1–I10）均渲染。
- 截图（`temp/ui-accept/`）：
  - `p2-19b-tokens-graph.png`
  - `p2-19b-tokens-memories.png`
  - `p2-19b-tokens-inbox.png`
  - `p2-19b-tokens-archive.png`
  - `p2-19b-tokens-settings.png`

## 遗留 / 需 Lead 处理

- `src/ui/graph/**` 仍有 24 条裸颜色，归 task-30（trace）；本卡验收按 `!graph/**` 为 0。合并后 `check-visual` 才能全库 0。
- `tests/unit/graph-2d.test.ts` 当前 1 条失败，来自 trace 的 graph 迁移中间态，非本卡。
- Tailwind preflight 会重置默认元素样式；五页截图已确认现有 inline 样式覆盖关键区域，未发现布局回退。后续卡可逐步把重复 inline 样式收敛为 utility/className。
- 未跑根 `pnpm build`/`pnpm verify`，未 git commit（按纪律等 Lead）。
- Progress 文件按任务卡保持 `p2-19b-tokens-progress.md`；Lead 验收后可改名 `.done.md`。
