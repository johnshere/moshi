# P2-19-B 浏览器验收工具（accept-ui）进度

- 状态：DONE
- 任务：task-31（P2-19-B 验收工具：五页截图 + calls/fps 报告）
- 开工：2026-11-04 23:00（Asia/Shanghai）
- 完成：2026-11-04 23:10
- 依据：台账 §4 P2-19-B；概设 §8.1（五个一级页面）、§8.9（性能预算与交互纪律）；用户 D-133（`renderer.info.render.calls ≤ 12`）
- 上一节点：task-28（裸 hex 检查 + seed-graph 可编程入口，已提交 `fd9b01a`）

## 开工核查

- `src/app/ui/dist/index.html` 存在但落后于最新 UI 提交（22:02），先 `pnpm build:ui` 刷新（113 modules，3.18s，产物 1,294.83 kB JS），dist 在 .gitignore 内。
- 本机 Node v22.19.0（全局 `WebSocket`、`fetch` 可用）；Chrome `C:\Users\john\AppData\Local\Google\Chrome\Application\chrome.exe` 存在，Edge 亦存在。
- UI 五页均挂在同一 SPA：`src/ui/main.tsx` 的 `pageFromPath` 映射 graph/memories/inbox/archive/settings，`Shell` 提供 `shell-nav`/`global-search`/`status-lights`/`nav-*`/`inbox-badge`。
- `/ui/graph` 侧由 `Graph3D.tsx` 每 500ms 发布 `window.__moshiGraph = {...stats, calls: stats.renderCalls, ...}`，可直接读 calls / nodeCount / edgeCount / fps。
- `buildHttpApp` 可 `listen({port:0})`；`seedGraph({data, facts, edges, quiet:true})` 已由 task-28 导出。

## 实现

### 1. `tools/accept-ui-lib.ts`（纯逻辑，可单测）

- 常量：`ACCEPT_UI_PAGES = ['graph','memories','inbox','archive','settings']`、`MAX_CALLS = 12`（用户 D-133）、`FPS_WARN = 30`、`FPS_SAMPLE_ROUNDS = 3`。
- `medianFps(samples)`：过滤非有限/负数，空样本 → null，排序取中位。
- `decideVerdict({pages, graph})`：
  - 缺页 → violation `page_missing`；`graph.calls > 12` → violation `calls=<n> > 12`；`graph.calls === null` → violation `calls_missing`；
  - 任一样本 fps < 30 → warning `fps=<n> < 30`（不 fail）；
  - 有 violation → `fail`，仅 warning → `warn`，否则 `pass`。
- `buildReport(input)`：输出 `{schema:'moshi-accept-ui/1', at, base_url, facts, edges, pages, graph, verdict, violations, warnings}`。
- `formatPageLine(page, graph)`：`PASS graph /ui/graph title="…" fps=49.2 calls=7 nodes=1000 edges=632 shot_ms=258`（fps<30 前缀 WARN）。

### 2. `tools/accept-ui.ts`（CDP 直连，不引新依赖）

- 参数：`--small`（facts 3 / edges 0）、`--facts N`、`--edges N`、`--timeout ms`、`--keep`；未知参数 → usage + exit 2。
- 临时目录：`temp/accept-ui/<stamp>/`（home、`home/.moshi` 库、`chrome-profile`、截图、report.json），**绝不碰 `~/.moshi`**。
- 启动链：`seedGraph` → `loadConfig` → `openDb` → `migrate` → `buildHttpApp` + `listen(port:0)` → 本机 headless Chrome（独立 `--remote-debugging-port` + `--user-data-dir`，`--use-angle=swiftshader` 供软件渲染）→ `/json/version` 轮询 → `PUT /json/new` 取 `webSocketDebuggerUrl` → 全局 `WebSocket` 直连 CDP。
- 逐页：`Page.navigate /ui/<page>?token=<test-token>` → 等 `readyState=complete` → 等 `shell-nav`（上限 5s，失败只记录）→ 页面标记（graph: `window.__moshiGraph`；settings: `[data-testid="settings-page"]`；其余无）→ 固定 500ms → 采 3 轮 1s rAF 得 fps → graph 页读 `__moshiGraph`（calls/nodeCount/edgeCount/fps）→ `Page.captureScreenshot` 存 `<page>.png`。
- 报告：`report.json` 同目录；控制台逐页 `PASS/WARN/FAIL`，`verdict=fail` → exit 1，异常 → exit 2。
- 清理：先 `browser.kill()` + 等退出 + 短暂等待，再带 3 次重试删 home/profile（Windows 上 Chrome 退出后 profile 可能短暂被占用）；`--keep` 保留。
- 不做 30fps 硬断言（集显口径差异），只按 `FPS_WARN=30` 标 warn。

### 3. `tests/unit/accept-ui.test.ts`（10 例）

`medianFps` 空/无有限样本/奇偶；`decideVerdict`：calls=12 pass、calls=13 fail、fps 29.9 warn、fps 30 不警告、缺页 fail、calls null fail；`buildReport` schema/verdict；`formatPageLine` 字段与 WARN 前缀。

## 验收

### 命令与输出

```text
$ pnpm typecheck
# 无本地错误（并发任务 src/ui/graph/pure/palette.ts 有 DOM lib 报错，非本卡文件）

$ pnpm vitest run tests/unit/accept-ui.test.ts
 ✓ tests/unit/accept-ui.test.ts (10 tests) 9ms
 Test Files  1 passed (1)
      Tests  10 passed (10)

$ pnpm build:ui
✓ 113 modules transformed.
../app/ui/dist/index.html                     0.90 kB │ gzip:   0.60 kB
../app/ui/dist/assets/index-BwgBnOv3.js   1,294.83 kB │ gzip: 348.39 kB
✓ built in 3.18s
```

### 冒烟（--small）

```text
$ npx tsx tools/accept-ui.ts --small
[accept-ui] seed facts=3 edges=36 seeded_ms=165
PASS graph /ui/graph title="默识 · 记忆图谱" fps=60 calls=7 nodes=3 edges=36 shot_ms=121
PASS memories /ui/memories title="默识 · 记忆图谱" fps=60.1 calls=— shot_ms=68
PASS inbox /ui/inbox title="默识 · 记忆图谱" fps=60.1 calls=— shot_ms=63
PASS archive /ui/archive title="默识 · 记忆图谱" fps=60.1 calls=— shot_ms=61
PASS settings /ui/settings title="默识 · 记忆图谱" fps=60 calls=— shot_ms=65
[accept-ui] PASS · fps_warn=0 · fail=0
[accept-ui] report: temp\accept-ui\2026-11-04T15-08-47-847Z\report.json
[accept-ui] 临时数据/浏览器 profile 已清理（--keep 可保留）
```

### 5k 规模（--facts 5000 --edges 15000）

```text
$ npx tsx tools/accept-ui.ts --facts 5000 --edges 15000
[accept-ui] seed facts=5000 edges=15000 seeded_ms=2107
PASS graph /ui/graph title="默识 · 记忆图谱" fps=49.2 calls=7 nodes=1000 edges=632 shot_ms=258
PASS memories /ui/memories title="默识 · 记忆图谱" fps=60 calls=— shot_ms=76
PASS inbox /ui/inbox title="默识 · 记忆图谱" fps=60 calls=— shot_ms=61
PASS archive /ui/archive title="默识 · 记忆图谱" fps=60 calls=— shot_ms=60
PASS settings /ui/settings title="默识 · 记忆图谱" fps=60 calls=— shot_ms=70
[accept-ui] PASS · fps_warn=0 · fail=0
[accept-ui] report: temp\accept-ui\2026-11-04T15-09-44-237Z\report.json
[accept-ui] 临时数据/浏览器 profile 已清理（--keep 可保留）
```

report.json 摘要（5k）：

- `schema=moshi-accept-ui/1`，`facts=5000`，`edges=15000`，`verdict=pass`，`violations=0`，`warnings=0`
- graph：`calls=7`、`nodeCount=1000`、`edgeCount=632`、`fps=49.2`（`frame_samples=[47.8,49.2,49.9]`）
- memories/inbox/archive/settings：`fps=60`、`frame_samples≈[60.9,60,60]`
- 截图：`graph.png`（264,557 B）、`memories.png`（143,150 B）、`inbox.png`（37,779 B）、`archive.png`（33,505 B）、`settings.png`（64,589 B）

说明：`nodes=1000` 是 `/ui/graph` 单页 payload 上限（详设 §10.1 graph limit），非种子总数；graph 走软件渲染（SwiftShader）仍有 49.2fps，真实 GPU 只会更高。

## 决策与遗留

- D-P2-19B-AU-1：CDP 直连 + 全局 `WebSocket`，不引 Playwright/Puppeteer，保持零新依赖。
- D-P2-19B-AU-2：选择器/标记只记录不判失败（任务卡口径），等待上限从 `--timeout` 压到 5s，避免拖慢整轮；`toast-host` 为空态时不存在，属正常记录 false。
- D-P2-19B-AU-3：`calls ≤ 12` 为硬断言；fps < 30 仅 warn，不做 30fps 硬断言。
- D-P2-19B-AU-4：截图/报告保留在 `temp/accept-ui/<stamp>/`，数据目录与浏览器 profile 默认清理（`--keep` 保留）；Windows profile 删除带重试，失败只警告不判失败。
- I-1：settings 页首屏采样约 9s（其余页 ~3.7s），主因是 settings 页自身数据加载；不影响判定，暂不优化。
- I-2：report 的 `facts/edges` 记录的是请求参数，不是 seed 实际写入数（`--small` 时 edges 传 0 但 seed 仍生成 36 条）；如需精确可在 report 增 `seed` 字段，属可选增强。
- I-3：工具依赖先 `pnpm build:ui`，未构建时明确报错返回 2（任务边界决定不让工具构建 UI）。
