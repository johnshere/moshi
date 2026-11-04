# P2-19-A 反向对账清单（文档 → 任务表 → 代码）

- 任务：task-11（P2-19-A 反向对账；只产出清单，不改代码）
- 核对基线：工作区 HEAD `7955e3d`（P2-18），其前 `0aa22eb`(P2-25)、`85c4e41`(P2-17)、`7c68bdf`(P2-16)、`caeab4e`(P2-15/P2-24)、`fa22214`(P2-13)、`9df8a3b`(P2-12)、`0872378`(P2-14)
- 方法：逐条对照「文档写了什么（文件+行号）→ 台账 §3 排没排 → 当前代码有没有（文件:行号或 grep 结论）」。只把「文档写了 + §3 未排任务 + 代码没有」记为缺口；`§5.3` 的 I-xx 观察单列（G 组），不计缺口；代码已有但任务表没排的，挂到对应已完成任务并给证据。
- 归属口径：`已有任务`（含进行中）/ `需新拆任务` / `I 类观察（非缺口）`。UI 外壳与页面类缺口统一归 **task-12（archive，进行中）**，本清单不重复派发。

## 汇总

| 组 | 主题 | 条目数 | 其中缺口（需新拆/已有任务） | 其中 I 类观察 |
| --- | --- | --- | --- | --- |
| A | 应用外壳与一级导航 | 10 | 10 | 0 |
| B | `/ui` 旧页与重定向 | 3 | 3 | 0 |
| C | 三个一级页面挂载点 | 4 | 4 | 0 |
| D | 深链 | 5 | 3 | 2 |
| E | P2-14/15/16/18 新增能力接线 | 21 | 19 | 2 |
| F | 其它「文档写了、任务表没排」 | 17 | 14 | 3 |
| G | 文档/台账自身偏差 | 7 | 0 | 7 |
| **合计** | | **67** | **53** | **14** |

需新拆任务归并为 18 张卡（见文末「建议新拆任务」）；UI 外壳/五页挂载归已有 task-12。

---

## A. 应用外壳与一级导航

依据：概设 §8.1 L929-947；详设 §10.1 L2878-2888、§10.2 L2890-2900。

| # | 文档出处（行号 + 原文摘要） | 现状证据（文件:行号） | 差距 | 归属 | 建议补齐方式与验收口径 |
| --- | --- | --- | --- | --- | --- |
| A1 | 概设 §8.1 L929-937「一级页面（左侧导航 5 项）」；L939 路由五条 | `src/ui/main.tsx:415-416` 仅 `isInbox ? <InboxPage/> : <App/>`；`src/app/http/static.ts:93` 只循环 `['/ui/graph','/ui/inbox']` | 5 页缺 3 页；无左侧导航外壳；静态入口只 2 条 | 已有任务 task-12（进行中） | task-12 已含：AppShell 侧栏 5 项 + 路由分发 + static 扩 5 前缀。验收：5 条 URL 各渲染对应页、当前项高亮、无 404。 |
| A2 | 概设 §8.1 L943「顶部搜索（`/` 唤起）：跨实体与事实，输入即查 alias 表 + FTS5」 | `src/ui` 无搜索组件（grep `CommandPalette`/`TopBar` 零命中）；无 `/api/search` 路由（`src/app/http/routes/`（7 个路由文件）无 search.ts）；`src/app/http/routes/facts.ts:163-171` 仅事实列表 `q` | 跨实体搜索 API 与 UI 全缺 | 已有任务 task-12（前端部分：输入走 `/api/facts?q=`）；**后端跨实体搜索 API 需新拆 P2-19A-02** | 建议：先按 task-12 降级为「事实 FTS 搜索 + `/` 唤起」；另拆后端 `GET /api/search?q=` 合并 entity(canonical_name/alias)+fact 两组。验收：`q=<实体名>` 返回实体组，alias 命中；UI `/` 聚焦、Esc 关闭、回车跳 `/ui/memories?q=`。 |
| A3 | 概设 §8.1 L944「右下角『待办 N』角标：队列不为空时显示，点进 /ui/inbox」 | 无组件；三队列各自 GET（`src/app/http/routes/queues.ts:33-70`），无汇总 total | 无角标、无汇总字段 | 已有任务 task-12（前端并行拉三队列 `limit=1` 求和） | task-12 实现要求第 1 条已写明；验收：种子库 5 条候选 → 显示「待办 5」，清空后隐藏，点击进 `/ui/inbox`。 |
| A4 | 概设 §8.1 L945「连接状态指示：daemon / sidecar / 模型 三个灯」 | `src/app/http/server.ts:96-118` `/api/status` 返回 `daemon/sidecar/vector/fts`，无 model 灯；`src/ui` 无消费者（grep `/api/status` 零命中）；`src/infra/sidecar/client.ts` `SidecarStatus` 已有 `mode/embedModel` | 缺 model 字段与三灯组件 | 已有任务 task-12（三灯用现有字段）；**model 灯需后端补字段，建议并入 P2-19A-02 或单拆小卡** | `/api/status` 只加字段 `model:{state,mode,embed_model}`（D-89 允许只增）；验收：停 sidecar / 无模型 / 正常三态灯色正确，`/api/status` 快照含 model。 |
| A5 | 概设 §8.1 L933 图谱页关键动作「框选 → 跳 §8.3 批量」 | `src/ui/state/selection.ts:12` 仅注释预留 `Set`；`Graph2D/Graph3D` 无拖框逻辑（grep `box-select`/`dragSelect` 零命中） | 框选多选未实现 | 需新拆 P2-19A-18（图交互补强，可与 task-12 后做） | 2D 视图拖框入选 `selectedIds`，Esc 清空，底栏跳批量预览。验收：拖框选 ≥2 节点后「预览影响」计数正确。 |
| A6 | 概设 §8.1 L932 记忆页关键动作「纠正、失效、合并、导出主题」 | `src/ui/table/FactsTable.tsx`、`src/ui/inspector/` 已有单条纠正/失效（P2-04/P2-06）；批量失效/剪枝在 `src/ui/inbox/BatchPanel.tsx`；**合并**入口无（见 E7/E10） | 合并入口缺（其余已有） | 已有任务 P2-19A-05/10（页面落地 + 实体合并） | 合并按钮随实体合并能力一起上；验收：选中两条 → 合并预览 diff → 确认。 |
| A7 | 概设 §8.9 L1142 键盘可达：`/`、j/k、Enter、Tab、Cmd/Ctrl+Enter、Esc、`g m`、`g i` | 仅 `src/ui/inspector/Inspector.tsx:271-274`（Esc / Cmd+Enter）与 FilterBar Enter；无 `/`、j/k、`g m`、`g i` | 键盘导航大部分缺失 | 已有任务 task-12（`/` 必有）；j/k、g m/g i 建议随 shell 一起 | 全局 keydown：`/` 聚焦搜索、`g m`/`g i` 跳页、j/k 列表移动、Esc 关闭面板。验收：handoff 单测 + 手动按键路径。 |
| A8 | 详设 §10.1 L2884-2888 全局常驻 `<TopBar>` / `<ToastHost>` / `<CommandPalette>` | 无独立组件（grep 零命中）；inbox 撤销条内联在 `src/ui/inbox/BatchPanel.tsx` | 外壳组件未抽出 | 已有任务 task-12（TopBar/搜索）；ToastHost 全局化建议随 P2-19-B 或 task-12 尾 | ToastHost 统一撤销条队列；验收：任一页面触发 batch 后显示撤销条并在 30s 消失。 |
| A9 | 概设 §8.4 L990-1002 首开五态（0 事实卡片 / MCP 未连接黄条 / sidecar 未就绪灰条 / 查无命中空态 / 归档目录未配置空态） | 无空态卡片/黄条/灰条（grep「尚未观测到」零命中）；后端无「MCP 最近调用时间」写入（详设 §10.7 L3092-3102 需 30 分钟内无 MCP 调用判定；grep `mcp_last_call` 零命中） | 五态 UI 与判定数据全缺 | 需新拆 P2-19A-08（前端五态 + 后端 MCP 时间戳） | MCP handler 每次调用写 `meta.mcp_last_call_at`；`/api/status` 暴露 sidecar.ready；前端五态。验收：空库/停 sidecar/未连 MCP/无命中/未配归档目录五种场景文案与配色正确。 |
| A10 | 概设 §8.1 L947 筛选六维 `scope×ftype×epistemic_status×strength×时间×pool`，状态写 URL | `src/ui/state/filter.ts:28` 七键已在 store/URL；`src/ui/filter/FilterBar.tsx:4-6` 只渲染 scope/ftype/status/timeRange（注释「strengthBand/pool 后端暂无可消费方」）；`facts.ts` 列表参数无 strength_min/pool | 前端 2 维控件与后端 2 参数缺 | 需新拆 P2-19A-07（后端参数）+ task-12（UI 控件，若范围允许） | `GET /api/facts` 加 `strength_min/strength_max/pool`（只增参数）；FilterBar 补两控件且写 URL。验收：URL 带参时请求参数与结果过滤正确、刷新保持。 |

## B. `/ui` 旧页与默认重定向

依据：概设 §8.1 L939（`/ui/graph` 默认）、§8.4 L1002（`moshi init` 拉起 UI）。

| # | 文档出处（行号 + 原文摘要） | 现状证据（文件:行号） | 差距 | 归属 | 建议补齐方式与验收口径 |
| --- | --- | --- | --- | --- | --- |
| B1 | 概设 §8.1 L939「`/ui/graph`（默认）」 | `src/app/http/server.ts:66-70` `GET /ui` 200 返回老 `ui.html`（15409 bytes），与 `/ui/graph` 并存，无 302 | `/ui` 未重定向；老页仍在线 | 已有任务 task-12（write scope 含 `src/app/http/static.ts`，但 server.ts 列禁止——重定向需 Lead 接线或改 static 挂载） | 建议：`GET /ui`、`/ui/` → 302 `/ui/graph` 并透传 token 查询参数；老 `ui.html` 下线或移 legacy。验收：`curl -i /ui` 302 + Location 含 token；grep `ui.html` 无引用（除历史文档）。 |
| B2 | 概设 §8.4 L1002「`moshi init` … 拉起 UI」 | `src/app/cli/commands/init.ts:99/115/119` 仅打印 daemon 状态与 UI 地址（老 `/ui`），不打开浏览器、不指 `/ui/graph` | init 输出与打开行为不符 | 已有任务 task-12（打印部分）+ **需新拆 P2-19A-16（init 拉起 UI：打开浏览器 / --no-open）** | init 打印 `/ui/graph`；默认 `open` 浏览器（失败仅警告），`--no-open` 关闭；验收：输出 URL 含 `/ui/graph`，`--no-open` 不调用 open。 |
| B3 | 概设 §8.1 L939 五页路由 | `src/app/http/static.ts:93` 仅 2 前缀；`/ui/memories`、`/ui/archive`、`/ui/settings` 无静态入口 | 静态托管缺 3 路由 | 已有任务 task-12（SPA fallback 覆盖 5 页） | 验收：5 条路径均返回 200 index.html（带 token 占位替换）。 |

## C. 三个一级页面挂载点

依据：概设 §8.1 L931-937；详设 §10.1 L2880-2886。

| # | 文档出处（行号 + 原文摘要） | 现状证据（文件:行号） | 差距 | 归属 | 建议补齐方式与验收口径 |
| --- | --- | --- | --- | --- | --- |
| C1 | 概设 §8.1 L931「记忆：列表 + 筛选 + 检查器」；§8.1 L940 深链 fact/canonical_key | `src/ui` 无 memories 目录（目录清单：filter/graph/history/inbox/inspector/node_modules/settings/state/table）；无 `MemoriesPage` 引用；FilterBar/FactsTable/Inspector 可复用 | 页面未建；深链无落点 | 已有任务 task-12（要求第 3 条） | 组合 FilterBar+FactsTable+Inspector；`?fact` 选中滚动、`?canonical_key` 过滤（依赖 P2-19A-07 后端参数）。验收：10k 行首屏 <500ms（CDP 实测）、URL 深链生效。 |
| C2 | 概设 §8.1 L932「归档：文档列表 + MD 预览；导出、重建、处理 .proposed.md」；详设 §10.1 L2882 | 无 `ArchivePage`；后端 `src/app/http/routes/archive.ts:52` 仅 `GET /topics`、`:73` 仅 `POST /proposed/:slug`；缺 `GET /topics/:slug`（详设 §4.3 L1360）与 `POST /export`（L1361） | 页面缺；详情/导出两个后端路由缺 | 已有任务 task-12（页面/列表）；**详情与导出路由需新拆 P2-19A-05（后端）**，task-12 已注明缺接口则 BLOCKED | 后端：详情读 `archive_dir/<slug>.md`（路径校验在根内，越界 400/404）+ `POST /api/archive/export` 触发 archiveAll（可异步 job）。验收：预览 <300ms、二次导出仅变更主题 mtime 变化、`.proposed.md` 三选一后 ledger 正确。 |
| C3 | 概设 §8.1 L933/937「设置与诊断：配置、隐私总览、自检（§10.5）」；§10.5 L1302-1304 | 无 `SettingsPage`；`src/ui/settings/DiagPanel.tsx` 存在但 `main.tsx` 零引用；缺 `GET/PUT /api/config`（详设 §4.3 L1365-1366）、`POST /api/maintenance/rebuild`（L1367）、`POST /api/privacy/purge`（L1368） | 页面未建；4 个后端端点缺（ConfigForm/PrivacyPanel/维护） | 已有任务 task-12（只挂 DiagPanel，要求第 5 条）；**其余需新拆 P2-19A-06（设置页后端）** | task-12 先挂诊断；P2-19A-06 补 config/maintenance/purge/eval 端点与 ConfigForm/PrivacyPanel。验收：改配置 PUT 往返、重建修复 `degree_mismatch`、purge dry_run 出数。 |
| C4 | 概设 §8.1 L932 归档「处理 .proposed.md」 | `src/app/http/routes/archive.ts:73` `POST /proposed/:slug` 已实现（P2-15，含 accept_auto/keep_human/promote_human） | 后端已覆盖，仅差页面按钮 | 已有任务 task-12（调用既有端点） | 验收：三选一后 `archive_meta.human_edited` 与文件基线符合详设 §9.4。 |

## D. 深链

依据：概设 §8.1 L940；台账 §4 P2-19-A L1006。

| # | 文档出处（行号 + 原文摘要） | 现状证据（文件:行号） | 差距 | 归属 | 建议补齐方式与验收口径 |
| --- | --- | --- | --- | --- | --- |
| D1 | 概设 §8.1 L940 `/ui/memories?fact=<id>` | 无 memories 页；`src/ui/main.tsx:46-58` `initialView`/`initialLimit` 只读 `view`/`limit` | 深链无落点 | 已有任务 task-12 | 解析 `fact` → 选中行并展开 Inspector；验收：URL 直达后 Inspector 显示该 fact id。 |
| D2 | 概设 §8.1 L940 `/ui/graph?focus=<id>` | `src/ui/state/selection.ts:19-41` `focusId` 仅内存；`main.tsx` 不读 `focus`；台账 L1006 称「已有落点」与代码不符（见 G2） | URL 读写缺失 | 需新拆 P2-19A-17（小卡：focus URL 同步） | 初始化读 `focus` 并 `select()`；点击节点 `history.replaceState` 写回；验收：URL 直达图聚焦该节点、点击后 URL 更新、Esc 清除参数。 |
| D3 | 概设 §8.1 L940 `/ui/memories?canonical_key=<k>` | 无页面；`facts.ts:163-171` 无 `canonical_key` 参数 | 深链与后端过滤缺 | 已有任务 task-12（页面）+ 需新拆 P2-19A-07（后端参数） | `GET /api/facts` 加 `canonical_key`；验收：URL 过滤出对应事实。 |
| D4 | 台账 §4 L1006「四条深链」 vs 概设 §8.1 L940 只列 3 条 | 概设全文只 3 条 | 数量不一致 | I 类观察（G1） | 修台账为 3 条，或补第 4 条定义。 |
| D5 | 概设 §8.1 L947 只写「筛选状态写 URL」；实现另有 `view`/`limit` | `main.tsx:46-58`；`src/ui/state/filter.ts:28` | 文档未列既有 URL 参数 | I 类观察（G6） | 详设 §10.1 补 URL 参数表（view/limit/筛选键）。 |

## E. P2-14/15/16/18 新增能力的 UI/CLI 接线

依据：详设 §4.3 L1340-1368、§4.8 L1542-1554、§10.6 L3057-3090；台账 §3 P2-14~P2-18、I-19~I-21。

| # | 文档出处（行号 + 原文摘要） | 现状证据（文件:行号） | 差距 | 归属 | 建议补齐方式与验收口径 |
| --- | --- | --- | --- | --- | --- |
| E1 | 详设 §4.8 L1551 `schema infer\|validate\|diff`；概设 §2.6 L265-289 | `src/app/cli/commands/schema.ts:55` `SUBCOMMANDS = ['validate','diff']`（无 infer）；infer 仅后台 `src/app/schemaInferRunner.ts` | CLI `infer` 缺 | 需新拆 P2-19A-10 | 复用 `src/core/lifecycle/schema-infer.ts`，写 ontology + 输出待晋升 JSON；验收：`moshi schema infer` 产出 ontology 行与摘要，非法参数退出码 2。 |
| E2 | 概设 §2.6 L289 infer 输出「待晋升清单」到 `/ui/diagnostics` | `src/core/diag/types.ts:78-87` `DiagReport` 无 pending_promotions 字段；`DiagPanel.tsx` 无该分节 | 字段与展示缺 | 需新拆 P2-19A-10（后端）+ P2-19A-06（展示） | infer 落库时写 `meta.pending_promotions`；diag 聚合；设置页展示。验收：infer 后 `/api/diag` 含 N 条待晋升。 |
| E3 | 详设 §4.8 L1548 `export [--slug X] [--all]` | `src/app/cli/commands/export.ts:21` summary 写 `moshi export --all`，但 `:24` 只解析 `--out`；无 `--slug/--all` | CLI 参数缺（参数被静默忽略） | 需新拆 P2-19A-11 | 解析参数并传给 `archiveAll`（slug 过滤）；验收：`--slug X` 只写该主题、`--all` 与默认一致、未知 slug 退出码 2。 |
| E4 | 详设 §4.3 L1360 `GET /archive/topics/:slug` | `src/app/http/routes/archive.ts:52-73` 仅 topics 与 proposed | 详情路由缺 | 需新拆 P2-19A-05 | 见 C2。验收：200 返回 markdown + revision/status；不存在 404；`..` 越界 400。 |
| E5 | 详设 §4.3 L1361 `POST /archive/export` | archive 路由无此端点 | 导出路由缺 | 需新拆 P2-19A-05 | 触发 `archiveAll`（异步 job 返回统计）；验收：二次导出仅变更主题写盘（mtime/内容对比）。 |
| E6 | 详设 §4.3 L1357-1358 `GET /graph` + `GET /graph/neighbors/:id`（depth≤2） | `src/app/http/routes/graph.ts` 仅 `GET /`（无 neighbors） | 邻域接口缺 | 需新拆 P2-19A-18（或并入图交互卡） | 复用 `graphRepo` 邻域查询；验收：`depth=2` 返回邻域、`depth>2` 400、缺 id 404。 |
| E7 | 详设 §4.3 L1350-1352 entities list / merge / merge preview | 无 entities 路由；grep `merged_into` 仅 `src/domain/types.ts:98`；无 entityRepo merge | 实体合并全链路缺 | 需新拆 P2-19A-09 | entityRepo：alias 合并、canonical_key 重算、audit；preview 返回 facts/edges 迁移 diff；验收：合并后仅保留实体可查、diff 与实际写入一致、写 audit。 |
| E8 | 详设 §4.3 L1356 `POST /queues/:kind/decide`；概设 §8.3 L973-989 单条决策三动作 | `src/app/http/routes/queues.ts:33-70` 仅三 GET（无 decide） | 单条决策缺（台账 I-19 已记） | 需新拆 P2-19A-04 | resolve: confirm/reject/new-entity；lowconf: boost/invalidate/isolate；prune: archive/prune/keep；每动作写 audit；验收：动作后队列移除/保留正确、重复决定 409。 |
| E9 | 详设 §4.3 L1347 batch `{action: invalidate\|archive\|prune}` | `src/app/http/routes/batch.ts:31` `BATCH_ACTIONS = ['invalidate','prune']`（archive 未支持） | archive 批量动作缺（台账 I-19） | 需新拆 P2-19A-04 | 复用归档逻辑标 archived + 置设计 dirty；验收：batch archive 后状态 archived、下次导出含该主题。 |
| E10 | 概设 §8.3 L983「合并必须给 diff 视图」 | 无合并接口与 UI | diff 视图缺 | 需新拆 P2-19A-09 | 前端 diff（facts 迁移/边保留/冲突）；验收：预览与确认后结果一致。 |
| E11 | 详设 §10.6 L3057-3090 队列 `cursor` 参数（台账 I-20） | `queues.ts` 仅 `limit`（`parseLimit`），无 cursor | 游标缺 | 需新拆 P2-19A-04 | 键集分页（id > cursor）；验收：翻页无重复遗漏、limit 上限 200。 |
| E12 | 详设 §4.3 L1344 facts 列表 `strength_min`、`pool` | `facts.ts:163-171` 参数仅 limit/sort/cursor/q/scope/ftype/status/from/to | 过滤参数缺 | 需新拆 P2-19A-07 | 见 A10。验收：参数存在时 SQL 过滤生效并影响 total。 |
| E13 | 详设 §4.3 L1345 facts detail `depth≤3` | `facts.ts:218-222` 无 depth（固定返回） | 参数缺 | I 类观察（实现收窄，功能可用） | 补 depth 参数或改详设；建议补（成本低）。 |
| E14 | 详设 §4.3 L1365-1366 `GET/PUT /config` | 无 config 路由；配置仅启动读 `src/app/config.ts` | 设置页配置表单无后端 | 需新拆 P2-19A-06 | GET 脱敏、PUT 白名单键 + zod 校验 + 写回 `config.json`；验收：改 `backup_keep` 往返生效、非法键 400。 |
| E15 | 详设 §4.3 L1367 `POST /maintenance/rebuild` | 无；CLI `db rebuild-strength/community` 存在（`src/app/cli/commands/db.ts:52`） | 重建端点缺 | 需新拆 P2-19A-06 | 触发 layout/degree/community 重建（异步 job）；验收：`rebuild-degree` 后 `/api/diag` `degree_mismatch` 归零。 |
| E16 | 详设 §4.3 L1368 `POST /privacy/purge` | grep `purge` 在 src/tools 零命中 | 隐私 purge 全缺（见 F4） | 需新拆 P2-19A-12（隐私） | 见 F4。 |
| E17 | 详设 §4.3 L1363-1364 `/api/diag`、`/api/diag/quality` | `src/app/http/routes/diag.ts:33/38` 已实现；`server.ts:88` 已注册（P2-18 已提交） | 已覆盖，仅差页面挂载 | 已有任务 task-12（挂 DiagPanel） | 验收：`/ui/settings` 显示六项质量与不变量。 |
| E18 | 详设 §10.2 L2890-2900 五个 store（useFilter/useSelection/useGraph/useInspector/useJobs） | 仅 `src/ui/state/filter.ts`、`selection.ts` 存在；无 useGraph/useInspector/useJobs | 状态层未拆 | 已有任务 task-12（页面落地时按需拆，不强制） | 若拆：筛选仍以 URL 为唯一真相源（D-? 纪律）；验收：URL 变化驱动列表刷新。 |
| E19 | 台账 §4 P2-18 L990-996 验收要求 `moshi doctor`（含 `--fix`） | `src/app/cli/index.ts:14,29` 已注册 doctor；`doctor.ts` 含 `--fix` 只修 degree/FTS | 已覆盖（P2-18 已提交 7955e3d） | I 类观察（已覆盖） | 无。 |
| E20 | 概设 §10.5 L1302-1304 自检页要求「布局新鲜度、实体消解待办量、golden set 最近结果」 | `src/core/diag/types.ts:78-87` 有 `last_eval` 但无 layout/resolve 字段；grep `setMeta(...,'last_eval')` 零命中（P2-17 未写） | 3 项数据缺 | 需新拆 P2-19A-13（布局/消解量）+ P2-19A-10（eval 写 last_eval） | diag 聚合 layout lag、resolve pending；eval 跑完写 `meta.last_eval`；验收：`/api/diag` 三块有值（无数据为 null 并说明）。 |
| E21 | 概设 §8.1 L932 归档页「重建」动作 | 无 UI；重建能力仅 CLI/内部 runner | 缺少页面入口（后端能力已有） | 已有任务 task-12（若范围允许）或 P2-19A-05 | 归档页「重建」按钮调 `POST /archive/export`（P2-19A-05 提供）；验收：点击后 dirty 主题写盘。 |

## F. 其它「文档写了、任务表没排」

依据：概设 §2.4 L242-245、§5.5.1 L742-743、§8.1 L937、§9.5 L1178-1206、§10.5 L1302-1304、§12 L1425-1432；详设 §4.3 L1368、§4.8 L1542-1554、§9.7 L2864-2870、§4.7 L1508-1541。

| # | 文档出处（行号 + 原文摘要） | 现状证据（文件:行号） | 差距 | 归属 | 建议补齐方式与验收口径 |
| --- | --- | --- | --- | --- | --- |
| F1 | 概设 §2.4 L242-245「每日 `VACUUM INTO` 快照 + 归档导出前额外快照；保留 N 份」 | 已实现（P2-17，`85c4e41`）：`src/app/jobs/scheduler.ts:252-265` backup 任务 `cron: 0 <backup_hour>`、`db.backup(file)`（node:sqlite 原生备份 API；迁移前另有 `VACUUM INTO` 备份，见 `src/infra/sqlite/migrate.ts:67-74`）、`pruneBackups` 保留 `backup_keep`；配置见 `src/app/config.ts:38-39` | 每日快照已覆盖；**导出前额外快照缺**（scheduler export 任务 `:296-306` 未先快照） | 已有任务 P2-17（每日快照）；**导出前快照需新拆小卡 P2-19A-03** | 在 export 任务开头调用同一 backup 函数（文件名带 `pre-export`）；验收：导出前后 backups/ 多一个文件且 mtime 早于导出写盘。 |
| F2 | 概设 §2.4 备份恢复；详设 §4.8 L1550 `db migrate\|vacuum\|backup\|rebuild-degree` | `src/app/cli/commands/db.ts:52` `SUBCOMMANDS = ['rebuild-strength','consolidate','community']`（无 migrate/vacuum/backup/rebuild-degree；migrate 仅内部 L106 调用） | 4 个子命令缺 | 需新拆 P2-19A-03 | migrate/vacuum 调 `infra/sqlite/maintenance.ts`（`vacuum` 已有 L39），backup 复用 scheduler 备份函数，rebuild-degree 复用 doctor fix；验收：四命令 smoke + `rebuild-degree` 后 diag 归零 + 退出码正确。 |
| F3 | 详设 §9.7 L2864-2870 `tools/check-archive.ts` 静态扫描 `core/archive/*`（禁回灌/禁写原文/禁 rm/unlink） | `tools/` 目录仅 bench/check-lifecycle/check-writes/copy-assets/lint-deps/lint-descriptions/seed-graph；`package.json` verify 链路无该检查 | 静态检查缺 | 需新拆 P2-19A-01 | 按 `tools/check-lifecycle.ts` 模式扫描（正则/AST）；接入 `verify`/CI；验收：违规样例 exit 1、正常 exit 0、输出文件:行。 |
| F4 | 详设 §4.3 L1368 `POST /api/privacy/purge`；概设 §5.5.1 L742-743 物理删除唯一合法入口 | grep `purge` 在 src/tools 零命中；无 UI PrivacyPanel | 隐私 purge 全缺 | 需新拆 P2-19A-12 | 后端 `{source?, dry_run}`：dry_run 只计数；实际删除按 source 清 fact/edge/raw 并写 audit（不碰归档文件）；UI PrivacyPanel；验收：dry_run 前后行数不变、实际删除写 audit、二次调用 0 影响。 |
| F5 | 概设 §8.1 L937 设置页「导出全库」 | 无 API/UI | 缺 | 需新拆 P2-19A-12（与 purge 同卡） | 复用 import 可回灌的 JSONL 导出；验收：导出条数 = fact 行数、可回灌到空库且计数一致。 |
| F6 | 概设 §8.1 L937 设置页「跑 golden set」 | 无 HTTP eval 触发（routes grep `eval|golden` 零命中）；CLI `src/app/cli/commands/eval.ts:137` 有 `run` | 缺 | 需新拆 P2-19A-10（与 schema infer 同卡或单列） | `POST /api/eval/run` 异步 job + 写 `meta.last_eval`；验收：触发后 `/api/diag.last_eval` 更新、并发触发 409。 |
| F7 | 概设 §8.1 L937 设置页「清库」 | 无端点/UI；详设 §4.3 也无对应行（仅 purge） | 缺（含文档未定义语义） | 需新拆 P2-19A-12（危险操作二次确认） | 建议 `POST /api/privacy/purge {all:true}` 或独立 `POST /maintenance/wipe`（详设需补行）；验收：清库后 fact 0 行、需确认 token、写 audit。 |
| F8 | 概设 §8.1 L937 设置页「隐私总览」 | 无 PrivacyPanel | 缺 | 需新拆 P2-19A-12（与 purge 同卡） | 展示 raw/session 来源计数、最近 purge 记录；验收：数字与 DB 一致。 |
| F9 | 概设 §8.4 L1000 归档目录未配置空态 | 无归档页（C2）；无空态文案 | 缺（随页面） | 已有任务 task-12 | 空态显示 archive_dir 配置路径与「去设置配置」链接；验收：未配置时存档页不报错。 |
| F10 | 概设 §12 L1429「同 cwd 重复 3 次操作序列 → `procedure:*`」 | 已实现：`src/core/lifecycle/consolidate.ts:511,526,603` 生成 `procedure:${name}`；`src/app/harvestRunner.ts:117` 调 `extractProcedures` | 无缺口 | I 类观察（已覆盖，P2-10） | 无。 |
| F11 | 概设 §10.5 L1304「图质量六项」 | `src/core/diag/quality.ts` 已实现六项并在 `report.ts` 输出（P2-18） | 无缺口 | I 类观察（已覆盖） | 无。 |
| F12 | 概设 §10.5 L1304「实体消解待办量」 | `DiagReport` 无该字段；`report.ts` 无 resolve pending | 缺 | 需新拆 P2-19A-13 | 聚合 `resolve` 队列 total（复用 `listResolveQueue`）；验收：`/api/diag.resolve.pending` 有值且随决策变化。 |
| F13 | 概设 §10.5 L1304「布局新鲜度」 | `DiagReport` 无 layout 字段；scheduler layout 任务 `:308-317` 已有 | 缺 | 需新拆 P2-19A-13 | 读 layout 表最大 updated_at / 未布局事实数；验收：`/api/diag.layout` 含 `unlaid` 与 `lag_ms`。 |
| F14 | 详设 §4.7 L1508-1541 trace 契约（TLL 64、两 GET、无 SSE） | `src/app/http/routes/trace.ts:57,72` 已实现；P2-24 已提交 `72b3a26`/`caeab4e`；前端 P2-25 已提交 `0aa22eb`（`src/ui/main.tsx:15-19,305,388`、`src/ui/history/HistoryPanel.tsx`） | 无缺口 | I 类观察（已覆盖） | 无。 |
| F15 | 概设 §8.9 L1126-1134 性能预算：图谱 30fps、表格 10k 首屏 <500ms、检查器 <50ms | 已有历史验收证据（P2-02/P2-03/P2-04/P2-06，见各自 progress.done.md）；归档预览 <300ms、搜索 <80ms 因接口/页面缺失暂不可验 | 归档/搜索两项待页面落地后验 | 已有任务 task-12 + P2-19A-05 | 归档预览/搜索验收时补 CDP 实测；验收：<300ms / <80ms。 |
| F16 | 详设 §4.7 L1538 `GET /api/trace?limit=20` + 概设 §8.1 L943「顶部搜索输入即查」 | trace 有前端（P2-25）；搜索无 | 搜索无实现（见 A2） | 需新拆 P2-19A-02 | 见 A2。 |
| F17 | 概设 §8.1 L937 设置页「改配置」 | 无 ConfigForm；config API 缺 | 缺（见 E14） | 需新拆 P2-19A-06 | 见 E14。 |

## G. 文档 / 台账自身偏差（I 类观察，非缺口）

| # | 偏差 | 证据 | 建议 |
| --- | --- | --- | --- |
| G1 | 台账 §4 L1006 写「四条深链」，概设 §8.1 L940 只列 3 条 | 概设 L940 三条 | 台账改 3 条，或补第 4 条定义 |
| G2 | 台账 L1006 称 `?focus` 已有落点，代码无 URL 读写 | `src/ui/state/selection.ts:19-41`；`src/ui/main.tsx:46-58` | 台账改为「待实现（P2-19A-17）」 |
| G3 | 概设 §10.5 L1303 `/ui/diagnostics` vs §8.1 L939 `/ui/settings` 命名冲突 | 两处文档 | 统一为 `/ui/settings`，诊断作为分节 |
| G4 | 详设 §4.3 无 `/api/status` 行，代码已有 | `src/app/http/server.ts:96-118` | 补详设 §4.3 一行 |
| G5 | 详设 §10.6 prune SQL 无 60 天条件，§8.3.4 有；P2-13 已按 §8.3.4 实现 | `docs/详设.md` §8.3.4 vs §10.6；`src/infra/sqlite/inboxRepo.ts` `listPruneQueue` | 更新 §10.6 SQL 与 §8.3.4 对齐 |
| G6 | 概设 §8.1 L947 只写筛选状态写 URL；实现另有 `view`/`limit` 参数 | `src/ui/main.tsx:46-58` | 详设 §10.1 补 URL 参数表 |
| G7 | 台账 §4 P2-19-A L998-1009 的「已知缺口」条目部分过时（P2-18 doctor/diag 已接线、P2-17 backup 已实现、P2-25 trace 已进 graph） | `7955e3d`/`85c4e41`/`0aa22eb` | 台账 §4 改为指向本清单，避免二次过时 |

---

## 建议新拆任务（18 张，按依赖顺序）

| 新卡 | 范围 | 来源条目 | 依赖 / 备注 |
| --- | --- | --- | --- |
| P2-19A-01 | `tools/check-archive.ts` + `verify` 接入 | F3 | 独立，可并行 |
| P2-19A-02 | `GET /api/search` 跨实体+事实（alias+FTS5） | A2、F16 | 独立；前端归 task-12 |
| P2-19A-03 | 备份补强：导出前快照 + `moshi db migrate\|vacuum\|backup\|rebuild-degree` | F1、F2 | 依赖 P2-17 的 scheduler 已有函数 |
| P2-19A-04 | 队列单条 decide 三动作 + batch archive + cursor 分页 | E8、E9、E11 | 依赖 P2-07/P2-13；后端为主 |
| P2-19A-05 | 归档后端补路由：`GET /topics/:slug`、`POST /export` | C2、E4、E5、E21 | 先于 task-12 的归档页（task-12 标 BLOCKED 的子项） |
| P2-19A-06 | 设置页后端：`GET/PUT /config`、`POST /maintenance/rebuild`、隐私/清库/导出/eval 端点 | C3、E14、E15、F4-F8、F17、E2 展示 | 大卡；建议与 P2-19A-12 合并评审 |
| P2-19A-07 | facts 列表过滤参数：`strength_min/max`、`pool`、`canonical_key` | A10、E12、D3 | 独立；前端控件 task-12 或 P2-19A-05 后补 |
| P2-19A-08 | 首开五态 + MCP 最近调用时间戳 | A9、F9 | 后端 1 行 meta + 前端五态（前端可归 task-12 扩展） |
| P2-19A-09 | 实体合并：entities API（list/merge/preview）+ core merge + diff UI | E7、E10、A6 | 大卡；前置 P2-19A-10 |
| P2-19A-10 | `moshi schema infer` CLI + 待晋升清单 + eval HTTP 触发 | E1、E2、F6、E20 | 后端为主 |
| P2-19A-11 | `moshi export --slug/--all` 参数补全 | E3 | 小卡 |
| P2-19A-12 | 隐私 purge + 全库导出 + 隐私总览 + 清库 | F4、F5、F7、F8、E16 | 红线：物理删除仅此入口且写 audit |
| P2-19A-13 | diag 补三项：布局新鲜度、实体消解待办量、last_eval 写入 | E20、F12、F13 | 依赖 P2-18 diagRepo |
| P2-19A-14 | 社区周重建调度（scheduler 加 community job） | 详设 §8.4「每周或用户点重建」；P2-11 遗留 | 小卡，依赖 P2-17 |
| P2-19A-15 | 设置页前端 ConfigForm/PrivacyPanel/维护（后端就绪后） | C3、E14-E16 | 依赖 P2-19A-06/12；若 task-12 已覆盖则合并 |
| P2-19A-16 | `moshi init` 拉起 UI（打开浏览器 / `--no-open`）+ 打印 `/ui/graph` | B2 | 小卡；与 B1 的 `/ui` 重定向同批 |\n| P2-19A-17 | `/ui/graph?focus=` URL 同步（读初始 focus、点击写回、Esc 清除） | D2、G2 | 小卡；前端 task-12 之外，避免与其主改动冲突 |\n| P2-19A-18 | 图交互补强：2D 框选多选 + `GET /api/graph/neighbors/:id` | A5、E6 | 中卡；后端 neighbors 与前端框选可拆两个子项 |

**已在 task-12 覆盖、不重复拆的 UI 缺口**：A1、A2（前端）、A3、A4（组件）、A7、A8、A9（前端）、B1、B3、C1、C2（页面/列表）、C3（挂 DiagPanel）、C4、D1、D3（前端）、F9。
**确认不是缺口的 I 类**：E13、E17-E19、E21 中已由 P2-17/P2-18/P2-24/P2-25 完成的部分、F10、F11、F14、F15（已覆盖部分）、G1-G7 全部。

---

## 与台账 §4 P2-19-A「已知缺口」的对应

| 台账线索 | 本清单行 | 结论 |
| --- | --- | --- |
| 1) 应用外壳与一级导航全表无任务归属 | A1-A4、A7、A8 | 已派 task-12；后端 search/status model 需 P2-19A-02 补 |
| 2) `/ui` 仍老 ui.html、未重定向 | B1、B2 | task-12 + P2-19A-16 |
| 3) `/ui/memories`、`/ui/archive`、`/ui/settings` 无挂载点 | C1-C3 | task-12；归档后端两路由 P2-19A-05 |
| 4) 四条深链只有 `?focus` 一类有落点 | D1-D5 | 实为 3 条；focus 反而无落点（G2），P2-19A-17 + task-12 |
| 补充：备份恢复 | F1、F2 | 每日已实现（P2-17）；导出前快照 + CLI 四命令 P2-19A-03 |
| 补充：tools/check-archive.ts | F3 | P2-19A-01 |
| 补充：moshi trace 命令 | F14、G（无文档行） | 非缺口（HTTP + 前端已覆盖；CLI 行需先补文档） |
| 补充：隐私 purge | F4、F8、E16 | P2-19A-12 |
