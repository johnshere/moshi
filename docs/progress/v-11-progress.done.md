# V-11 UI 国际化 S3（门禁 + 英文审校 + 文档）— 进度（DONE.m2，2026-11-16）

## 目标（承接 D-184/D-185，用户 m01194/m01218）

1. **门禁**：`src/ui` 除 `i18n/` 外出现裸中文字面量即失败，且能区分「注释里的中文」（允许）与「上屏的中文」（禁止）。
2. **英文审校**：逐页 EN 截图复核，修不通顺/缺空格/被截断的英文。
3. **文档**：概设 §8.11 / 详设 §10.9 补「UI 国际化」小节，台账收口 V-11 → DONE.m2。

## 改动

| 文件 | 内容 |
| --- | --- |
| `tests/unit/i18n-gate.test.ts`（新增，4 例） | `findCjkLiterals(file, source)` = `ts.createSourceFile(..., ScriptTarget.Latest, true, ScriptKind.TSX)` → `forEachChild` 递归，只判 `StringLiteral` / `NoSubstitutionTemplateLiteral` / `TemplateHead｜TemplateMiddle｜TemplateTail` / `JsxText`；注释不是语法节点故天然放行；`listUiSources()` 跳过 `i18n/`；`ALLOWED_LITERALS` 只登记数据契约并各带 `why`；4 例 = ①全量扫描无违规 ②白名单文件仍存在 ③扫描器自检（字符串/模板/JSX 命中，注释与标识符不命中）④中英 `{占位}` 一一对应 |
| `src/ui/graph/Graph3D.tsx` | 三段 GLSL（`EDGE_VERT`/`EDGE_FRAG`/`ENVELOPE_FRAG`）内部中文注释改英文（它们属模板字面量内容，改不掉就永远卡门禁）；TS 侧注释保留中文 |
| `src/ui/archive/ArchivePage.tsx` | 空态「尚未配置归档目录？+ 去设置」改成 `display:flex; alignItems:baseline; gap:4; flexWrap:wrap` 的两子节点，中英共用一套间距（原先中文无空格、英文 `?Open settings` 粘死） |
| `src/ui/i18n/dict.en.ts` | `filter.scopePlaceholder` `(empty = any)` → `(= any)`（输入框宽度下会被截断）；`diag.weights` `Weights {value}` → `Weights: {value}`；`diag.has` `yes` → `present`；`diag.none` `no` → `none`；`settings.hint.config` 语序（`changes that take effect immediately apply at once` → `keys that need no restart apply immediately, the rest are flagged as requiring one`） |
| `docs/概设.md` | 新增 **§8.11 UI 国际化：zh 默认 / en**（范围、模块表、边界、D-185 写法定式、门禁三条、顶栏收敛、状态与 I-70 遗留）；§8.1 页面清单 `5 项 → 6 项`（补「接入」行）、「全局常驻元素」重写为顶栏收敛后的描述 |
| `docs/详设.md` | 新增 **§10.9 UI 国际化**（模块边界树、`t/translate/useT/hasKey/Translator` 语义、`state/locale.ts` 的 `globalThis` 约束、key 命名、D-185 定式代码片段、不可翻译项、门禁与验证命令、**`pnpm build:ui` 后必须 `node tools/copy-assets.mjs`** 的验收坑、I-70 遗留） |
| `docs/任务台账.md` | §1 当前任务/上次更新/下一步、§2 V-11 行 → `DONE.m2` |
| `docs/任务台账/决策记录.md` | **D-186** 裸中文门禁与英文审校口径（AST 而非正则；白名单带存在性断言；占位校验；英文质量靠看图） |
| `docs/任务台账/进度日志-2026-11.md` | 追加 `2026-11-16 19:45 V-11 DONE.m2` 长行 |

## 英文审校清单（截图逐页过）

- 图谱 HUD：`Moshi · Memory graph 3D / §10.3`、视图 `3D/2D/Table`、`Nodes 558 / 558 Edges 312 / 312 draw calls 7 fps: 59.9`、`Evidence chain: none · appears after one query ("direct / 1 hop / 2+ hops")`、底栏 `Drag to rotate · wheel to zoom · click a node = select (enlarge + always-on label) · …` —— 通过。
- 记忆：`Search facts (/)`、`All scopes`、`Filter Scope`、`Search content (Enter · backend q)`、`Sort Time｜Importance`、状态 chips `Active/Archived/Invalidated/Pruned/Disputed`、底栏 `Loaded 200 / 558 rows · 1 requests · limit ≤ 200 each · Scroll within 20 rows of the bottom to load more` —— 通过（作用域占位符修后不再截断）。
- 待办：`Moshi · Inbox Three queues / §10.6`、`Resolve (0)`/`Low confidence (0)`/`Prune candidates (0)`、`Nothing pending` —— 通过。
- 归档：`Archive topics`、`No topics yet (a community is archived once it has ≥8 facts and complete dependencies)`、`Last export: Never exported`、`Pick a topic on the left to view its body.`、`Rebuild archive` —— 修 `?Open settings` 空格后通过。
- 接入·日志：`Requests 2366`/`OK 0`/`Degraded 2366`/`Updated 19:28:28`、`All sources`/`All statuses`/`Search corr / endpoint / text`、`Logs & retention` —— 通过。
- 设置四面板：`Config`（`Collection & enrichment`/`Archive & thresholds`/`Startup settings`、`harvest cron`/`export cron`、端口提示）、`Maintenance`（`Count only, no rebuild (dry_run)`/`Rebuild FTS`/`Rebuild vectors`/`Recompute degree`/`Rebuild all`）、`Privacy`（`Soft-deleted / invalidated`、`idle 80 days · half-life 14 days`、`Purge data`）、`Diagnostics`（`INVARIANTS`/`GRAPH QUALITY (SIX METRICS + LAYOUT FRESHNESS)`/`Weights: none`/`Run golden set`）—— 修 `Weights`/hint 语序后通过。
- 首启弹窗两阶段（V-10 已验，本轮回归未变）。

## 验证

- `pnpm typecheck` 0、`pnpm typecheck:ui` 0、`pnpm verify` **156 files / 1815 tests 全绿**、`pnpm build` 0（`index-CN17aGS3.js` 1,431.49 kB gzip 382.97 kB、`index-Byb2Y3My.css` 13.62 kB）。
- `node .dsh/temp/cjkcheck.mjs src/ui -v` → `files=0 lines=0`（剥注释后 `src/ui` 零裸中文）。
- `.dsh/temp/audit-en.ts`：675 键中「中英同文」17 条全为技术词（`MCP`/`3D`/`daemon`/`—`/`{path} · {size}`）、「首尾空白不一致」6 条均为英文括号前空格的刻意差异。

## 教训（别再踩）

1. UI 产物有两份：`src/app/ui/dist`（vite 产物）与 `dist/app/ui/dist`（daemon 实际托管）。只跑 `pnpm build:ui` 看不到变化，**必须** `node tools/copy-assets.mjs`；浏览器还要 `ignoreCache` 重载。
2. GLSL / SQL / 模板字符串里的中文是**字符串内容**，文档级注释才是注释——门禁会抓前者，这正是设计意图。
3. 手写词法器扫 CJK 会被 JSX 里的撇号带偏（`.dsh/temp/cjkcheck.mjs` 曾把 JSX 注释算成命中），所以门禁改用 AST。
4. `write`/`edit` 偶发 `ReplaceFileW EIO (Win32 1175)`：重试一次即可（本轮两次都是重试成功）。
5. 一次性把 `{` 写掉（`<a` 变 `<aa`）会得到 `TS17002: Expected corresponding JSX closing tag for 'aa'` —— 批量替换后必须 `typecheck:ui` 兜底。

## 下一步（待用户裁定）

- **I-70**：后端把 `plans.labels` / `plans.manual` / `InstallStep.action` / `plan.reason` / `plan.risk` / `step.note` 改成码值，前端再 `enumLabel` 映射；改完可删门禁白名单两条。
- 英文母语润色（当前为直译，用户如需要再走一轮）。
- 回到主线：接入层与日志 / Phase 4 待裁决项（见台账 §1「下一步」）。
