# P2-19A-05b 归档页交互补完（task-24）进度

状态：**实现 + 自测完成，待 Lead verify/build/commit（纯 UI，无后端接线）**

## 目标与实现

| 要求 | 实现 |
| --- | --- |
| MD 预览走 `GET /api/archive/topics/:slug` | 右侧预览渲染标题、revision、status、`derived_at`、`content_hash` 前 8 位、正文；不引入 markdown 库，按行切 `# / ## / ### / - ` 并剥掉 frontmatter（`pure.ts:previewLines`） |
| 文件缺失降级 | 200 + `markdown:null` / `missing:true` → 琥珀色「正文文件缺失（可能在归档目录外被移动）」+ 期望路径，不报错 |
| 404 降级 | `主题不存在，列表可能已过期` + 刷新列表按钮（同时自动刷新一次列表） |
| `?slug=` 深链 | 初始化读 URL 自动选中（URL 里 slug 即使不在列表也去请求，用 404 暴露）；点行 `history.replaceState` 写回；popstate 重新解析（URL 唯一真相源） |
| `.proposed.md` 三选一 | 行上「待合并」徽标 + 「处理」；对话框列 `accept_auto` / `keep_human` / `promote_human` 及后果文案；成功 toast + 刷新列表与预览；失败显示 `message（reason）` |
| 重建按钮 | 工具栏「重建归档」→ `POST /api/archive/export {}`；期间禁用并显示「重建中…」；成功 toast 用真实响应字段 `written/unchanged/proposed/elapsed_ms`；显示列表最大 `last_exported_at`（无则「从未导出」） |
| 空态 | 列表为空 → 归档条件提示（社区事实数 ≥8 且依赖完整度达标）+「尚未配置归档目录？去设置」链接（SPA 到 `/ui/settings`，保留 token） |

## 关键决策

- **D1 无 markdown 依赖**：预览用 `PreviewLine` 模型（h1/h2/h3/bullet/text/blank），组件只按 kind 上样式；frontmatter 不展示。
- **D2 human_edited 三态**：`0` 无徽标；`1` 待合并 + 可处理；`2` 永久人工 + 无「处理」（后端此时无 `.proposed.md`，三选一没有对象）。验收卡写的「>=1 待合并」在 `2` 上细化为「永久人工」，报告已说明。
- **D3 空态不假装知道目录状态**：`GET /api/archive/topics` 不返回 `archive_dir` 是否配置，前端无法区分「未配置」与「配置了但没主题」，因此空态同时给两条提示，不新增接口（D-89）。
- **D4 URL 写回用 replaceState**：点行/自动选中不新增历史条目；SPA 前进后退仍由 popstate 重解析。
- **D5 预览数据源**：详情响应优先（含 `derived_at`），列表行兜底 `last_exported_at`/`human_edited`/`proposed_path`。

## 改动文件

| 文件 | 说明 |
| --- | --- |
| `src/ui/archive/pure.ts`（新） | slug 深链/href、三态徽标、空态、预览行切分、缺失态、重建/提示文案、三选一动作表 |
| `src/ui/archive/ProposedDialog.tsx`（新） | 三选一对话框（展示 + 回调） |
| `src/ui/archive/ArchivePage.tsx` | 接入预览/深链/对话框/重建/空态/404/缺失降级 |
| `src/ui/api.ts`（只增） | `fetchArchiveTopics` / `fetchArchiveTopic`（404→null）/ `requestArchiveExport` / `applyArchiveProposal` + `MoshiApiError` |
| `tests/unit/archive-page.test.ts`（新） | 19 例纯函数契约 |
| `docs/progress/p2-19a-archive-ui-progress.md` | 本文件 |

## 验收命令与结果

```
pnpm typecheck        → clean（无输出）
pnpm typecheck:ui     → clean（无输出）
pnpm vitest run tests/unit/archive-page.test.ts
  → Test Files 1 passed (1)，Tests 19 passed (19)
pnpm exec eslint src/ui/archive tests/unit/archive-page.test.ts
  → src/ui 被既有 ignore 规则忽略（UI 无 eslint 配置），测试文件 0 error
```

单测覆盖：slug 读取/写回保留 token、初始选中（URL 优先/首项/空）、深度态、proposed 三态徽标、空态四态、last_exported_at 取最大、shortHash、frontmatter 剥离、行切分（标题/列表/正文/空行）、缺失态判定、重建按钮态、exportToast 字段、三选一动作齐全、错误 reason 拼接。

## 浏览器验收（真实 Fastify + 临时 dist，端口 53110，token=accept-token，脚本跑完已停）

- 列表 3 行；点「开发环境」→ URL 变为 `.../ui/archive?token=accept-token&slug=%E5%BC%80%E5%8F%91%E7%8E%AF%E5%A2%83`；`data-state="ok"`；预览正文 153 字符、含 `PowerShell 7`、frontmatter 未出现。截图 `temp/ui-accept/p2-19a-archive-preview.png`。
- 点「本机工具链」→ `data-state="file_missing"`，文案「正文文件缺失（可能在归档目录外被移动）。期望路径：topics/本机工具链/本机工具链.md」。截图 `p2-19a-archive-missing.png`。
- 「网络配置」行显示 `待合并` 徽标 + 「处理」；点开对话框出现三选一（`archive-action-accept_auto|keep_human|promote_human`）。截图 `p2-19a-archive-dialog.png`。
- 点 `keep_human` → `data-kind="ok"` toast「已保留人工版，此后不再自动导出（永久人工）（revision 1，human_edited=2）」；行刷新为「永久人工」，无「处理」。
- 点「重建归档」→ toast「重建完成：写入 0、未变 0、待合并 0（0ms）」（种子库无达标社区，导出 0 篇是真实结果；字段名按路由响应 `written/unchanged/proposed/elapsed_ms`）。
- 深链 `?slug=开发环境` 直接打开 → 选中该行且预览 `data-state="ok"`；`?slug=no-such-topic` → `data-state="not_found"` + 「主题不存在，列表可能已过期（404 archive_slug_not_found）」。

> 截图来自浏览器 MCP，已按既有做法复制到 `temp/ui-accept/`；`temp/` 为缓存目录，不入提交。

## 遗留 / 说明

- 空态无法区分「归档目录未配置」与「已配置但 0 主题」——后端列表接口不返回目录状态；如产品要求精确区分，需另开接口（本卡禁改后端）。
- 浏览器验收未点 `accept_auto`（需要真实 `.proposed.md` 文件；种子 harness 无提案文件）；其三选一动作与请求体已由纯函数/类型覆盖，`keep_human` 已走真实 POST。
- 重建按钮在无达标社区时显示 0；这是后端真实结果，不是前端占位。
- UI 无 eslint 配置（既有），只跑 `typecheck:ui` + 单测。
- 不做视觉美化（P2-19-B 统一）；未新增依赖。
