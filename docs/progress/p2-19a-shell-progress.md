# P2-19-A 应用外壳与一级页面挂载 — 进度

- 任务：task-12（P2-19-A）
- 状态：**实现 + 自测 + 浏览器验收完成**；待 Lead `pnpm verify` / `pnpm build` / commit，以及 task-13 接口在部署环境上线后复验（本地 harness 已按真实接口验证）。
- 日期：2026-11-04
- 范围：只做外壳 / 一级导航 / 5 页挂载 / `/ui` 重定向 / 深链；不混视觉美化（P2-19-B 另做）。

## 1. 逐条要求与落点

| 要求 | 落点 |
| --- | --- |
| 应用外壳 + 一级导航（5 页，全局常驻） | `src/ui/shell/Shell.tsx`：左侧 172px 导航（图谱/记忆/待办/归档/设置与诊断）、顶部 46px（搜索 + 三灯 + 待办角标），`aria-current="page"` |
| `/ui` → `/ui/graph` 302 | `src/app/http/static.ts`：`onRequest` 精确匹配 `/ui`、`/ui/`（去 query）→ 302 `/ui/graph` + 原查询串；用 `Symbol.for('skip-override')` 让钩子进入根作用域，绕开 server.ts 已有 `GET /ui` 的重复路由 |
| 5 页挂载 | `src/ui/main.tsx` 的 `Root` 按 `parseRoute` 渲染：graph→既有 `App`、memories、inbox→既有 `InboxPage`、archive、settings |
| 深链 `?fact=` | `src/ui/memories/MemoriesPage.tsx`：写入 selection、滚动到行；`?canonical_key=` 归一为 `q=`（后端无该筛选参数，页内说明） |
| 深链 `?focus=` | `Root`/`App`：读 `?focus=` → selection（3D/2D/表格/Inspector 共用）；选中态变化用 `history.replaceState` 写回 `?focus=`；无该 id 时清选中 + HUD `focus-miss` 提示 |
| 顶部搜索（`/` 唤起） | `src/ui/shell/SearchBox.tsx`：`/` 聚焦、250ms 防抖建议、回车进记忆页、点建议进 `?fact=` |
| 待办角标 | `Shell.tsx`：三队列 `?limit=200` 并行取 items.length，合计显示；打满显示 `N+`（后端无 total，D-89 不改契约） |
| 三灯 | `Shell.tsx`：`/api/status` → daemon/sidecar/vector 三态颜色与 title |
| 归档页正文预览 | `src/ui/archive/ArchivePage.tsx` 接 task-13 的 `GET /api/archive/topics/:slug`；`markdown:null`/`missing` → 琥珀色「正文文件缺失」降级；404 → 「接口未就绪/主题不存在」空态 |
| 设置与诊断 | `src/ui/settings/SettingsPage.tsx`：复用既有 `DiagPanel`（只读自检） |

## 2. 关键决策

- **D1 `/ui` 302 不改 server.ts**（禁改）：staticRoutes 加 `skip-override` + 根级 `onRequest` 钩子；实测 `/ui`、`/ui/`、`/ui?token=` 均 302 且保留 query。
- **D2 页面容器**：Shell 的 `<main>` 为 `position:relative`，既有 `FactsTable`/`Graph3D` 的 `position:absolute; inset:0` 不改，避免动 P2-25/P2-26 行为。
- **D3 深链统一走 selection store**：3D/2D/表格/Inspector 都消费同一个 `useSelection`；URL 只是它的镜像（`replaceState` 不新增历史条目）。
- **D4 待办角标**：后端队列接口无 total，按单页 200 估算，打满显示 `200+`；不新增接口。
- **D5 canonical_key 深链**：`/api/facts` 无 canonical_key 参数，前端归一成 `q=` 并显式提示近似（不自造契约）。
- **D6 归档页**：只读接口由 task-13 提供；前端不读本地文件、不写 DB；文件缺失是降级态（琥珀）而不是红色报错。

## 3. 改动文件

新增：
- `src/ui/shell/pure.ts`（路由/深链 href/角标/三灯纯函数）
- `src/ui/shell/api.ts`（status、队列计数、搜索建议）
- `src/ui/shell/navigate.ts`（pushState + popstate）
- `src/ui/shell/SearchBox.tsx`
- `src/ui/shell/Shell.tsx`
- `src/ui/memories/MemoriesPage.tsx`
- `src/ui/archive/ArchivePage.tsx`
- `src/ui/settings/SettingsPage.tsx`
- `tests/unit/shell.test.ts`（22 tests）

修改：
- `src/ui/main.tsx`（Root 路由分派、保留 TraceNote/HistoryPanel/Graph3D publish；focus 双向；canonical_key 归一）
- `src/app/http/static.ts`（`/ui` 302、5 页 prefix）
- `tests/unit/static.test.ts`（`/ui` 改断言 302 + 5 页 fallback；9 tests）
- `tests/unit/http.test.ts`（`/ui` 改断言 302；23 tests）
- `docs/progress/p2-19a-shell-progress.md`（本文件）

未改：`src/app/http/server.ts`、`src/app/cli/index.ts`、`src/app/main.ts`、`docs/任务台账.md`、`src/core/**`、`tools/**`、`migrations/**`。

## 4. 验证命令与输出

```
pnpm typecheck        → clean
pnpm typecheck:ui     → clean
pnpm vitest run tests/unit/shell.test.ts tests/unit/static.test.ts tests/unit/http.test.ts
                      → Test Files 3 passed (3), Tests 54 passed (54)  [shell 22 + static 9 + http 23]
pnpm lint:deps        → ✔ 151 个模块，656 条内部依赖，5 条规则
pnpm lint:writes      → OK，103 个文件，无白名单外写调用
pnpm exec eslint src/app/http/static.ts tests/unit/static.test.ts tests/unit/http.test.ts tests/unit/shell.test.ts --ext .ts
                      → 无输出
pnpm --filter moshi-ui exec vite build --outDir temp/ui-accept/p2-19a/dist --emptyOutDir
                      → ✓ built in 3.08s（1,235.71 kB，gzip 332.96 kB）
```

## 5. 浏览器验收（真实 `buildHttpApp` + 临时 dist，端口 53110 / token accept-token）

环境：`temp/ui-accept/p2-19a/harness.ts`（3 facts + 两条边 + layout + 3 条 archive_meta + 两个归档正文样本；第三个主题故意缺文件）。截图均在 `temp/ui-accept/`。

| 验收点 | 读数 / 证据 |
| --- | --- |
| `/ui` 重定向 | 打开 `/ui?token=accept-token` → 最终 URL `/ui/graph?token=accept-token`（302） |
| 一级导航 | 5 项：图谱/记忆/待办/归档/设置与诊断；当前项 `aria-current="page"` |
| 三灯 | daemon `ok`；sidecar `off`（未配置）；vector `warn`（0/3） |
| 待办角标 | 真实 DB 无队列项 → `待办 0` |
| 图页 | `window.__moshiGraph`：`calls=6`（带 focus 时 7）≤12、nodes=3、edges=2、mode=live |
| 图深链 focus | `/ui/graph?focus=<id>` → graph.focusId=该 id，Inspector 显示 `alpha service version = 22.0.0`；2D 视图同样选中 |
| 选中 → URL | 表格视图点第一行：selection=行 id，URL 追加 `&focus=<id>`，`history.length` 保持 16（replaceState，无新历史条目） |
| Esc → URL | 按 Esc 清选中：URL 移除 `focus`，`history.length` 仍 16 |
| 无效 focus | `/ui/graph?focus=no-such-id` → 不选中，HUD 显示「深链 focus=no-such-id 不在当前图中（limit=1000），已取消选中」，URL 自动去掉 focus |
| 记忆页 `?fact=` | 行找到且 title 以 id 结尾；`window.__moshiTable.selectedId` 命中；Inspector 含 alpha |
| `?canonical_key=` | URL 归一为 `...&q=alpha`；页内提示「后端 /api/facts 无该筛选参数，已按 q 近似检索」；1 行 |
| 归档页列表 | 3 行（开发环境/本机工具链/网络配置），status/human_edited 标签正确 |
| 归档正文 | 开发环境：`data-state=ok`，`<pre data-testid="archive-markdown">` 153 字符、含 `PowerShell 7` |
| 归档文件缺失 | 本机工具链：`data-state=file_missing`，琥珀降级文案（非红色报错），列表/元数据仍可用 |
| 设置与诊断 | I1–I10 全渲染（种子库 I9 红属真实自检结果）、图质量六项、模型/归档、最近 harvest/eval |
| 待办页 | 三个 tab（消解确认/低置信/淘汰候选）+ 刷新；空态「没有待处理项」 |
| 顶部搜索 | `/` 聚焦 `[data-testid="global-search"]`，输入 alpha 回车 → `/ui/memories?q=alpha`（1 行） |

截图：
- `temp/ui-accept/p2-19a-graph.png`
- `temp/ui-accept/p2-19a-graph-focus.png`（focus 深链选中）
- `temp/ui-accept/p2-19a-graph-focus-miss.png`（无效 focus 降级）
- `temp/ui-accept/p2-19a-memories.png`
- `temp/ui-accept/p2-19a-canonical.png`
- `temp/ui-accept/p2-19a-archive.png`（正文预览）
- `temp/ui-accept/p2-19a-archive-missing.png`（文件缺失降级）
- `temp/ui-accept/p2-19a-settings.png`
- `temp/ui-accept/p2-19a-inbox.png`

## 6. 依赖 / 遗留

- **task-13**：`GET /api/archive/topics/:slug` 已落盘并已按真实响应验收（`markdown`、`missing`、404）；若部署版本尚未含该接口，归档页显示 404 空态而非报错。
- 本卡不含：归档「三选一」提案对话框（ProposedDialog）、ConfigForm/PrivacyPanel、队列条目批量操作、CommandPalette/ToastHost、视觉美化 —— 均按范围留给 P2-19-B 或后续任务。
- 待办角标是「前 200 条」估算，打满显示 `200+`；要精确总数需后端加 total（D-89 下暂不做）。
- 表格视图 focus 滚动依赖行进入 DOM，最多轮询 10s；极端大表未加载到目标行时只选中不滚动。
