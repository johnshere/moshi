# P2-07 三队列 + 批量预览 + 30s 撤销 — 施工进度

- 起止：2026-11-03 12:05 ~ 12:23（代码/测试/build/浏览器验收均完成；等 Lead 复验与 commit）
- 依据：台账 §4 P2-07（目标：消解/低置信/淘汰三队列 + 影响面预览 + 30 秒撤销；产出：`InboxPage.tsx`、`BatchPanel.tsx`；验收：批量失效前显示 facts/edges/topics/invalidated_by_cascade，30 秒内可撤销；坑：`invalidated_by_cascade` 必须算，不显示等于盲签）
- 详设：§10.6（三队列 SQL 逐字 + 预览/撤销语义）、§10.1（`/ui/inbox → InboxPage = QueueTabs + QueueList + BatchPanel`）、§10.2（store 约定）、§4.3（batch/preview/undo/queues 路由）、§1.2（时间恒 UTC，`nowIso`）、§1.4（枚举只用 `domain/enums.ts`）
- 概设：§8.3（批量两条硬规矩：影响面预览必达、30 秒可撤销，撤销=清 `valid_to`）、§8.1（`/ui/inbox` 是一级页面）

## 开工前核查（2026-11-03 12:10）

后端现状（已通读 `server.ts` / `static.ts` / `routes/facts.ts` / `factRepo` / `edgeRepo` / `auditRepo` / `db` / `tx` / `migrations/001_init.sql`）：
- `/api/*` 统一 `onRequest` 钩子校验 `X-Moshi-Token`（GET 也校验），非法 401 `E_UNAUTHORIZED`；路由插件用「async 函数 + opts」注册（`factRoutes` / `graphRoutes`）。
- 无全局 errorHandler：参数错误必须在路由内就地 `reply.code(...)`（否则 Fastify 默认 500）。既有惯例：`catch (err) { if (!(err instanceof MoshiError)) throw err; return reply.code(400).send({ error, message, detail }); }`。
- `factRepo.invalidate(db, id, {validTo, status})` 已校验 `id 存在`（E_NOT_FOUND）/`已收口`（E_IMMUTABLE）/`validTo > valid_at`（E_INPUT）；写 `valid_to/superseded_by/epistemic_status/updated_at`。
- `auditRepo.appendAudit(db, {tbl,rowId,field,before,after,source,reason,ts})` 只追加，`tbl` 联合类型含 `'fact'`。
- `edgeRepo.closeEdge` 存在，但**本路径不碰 edge**（派单语义：撤销=清 `valid_to`，不删/不关边；只有 `edge` 有 `trg_edge_no_reopen`，`fact` 无 reopen 触发器 → 清回 NULL 在 DB 层可行）。
- `fact`/`alias`/`entity` DDL 已核对：`alias(alias, entity_id, source, confidence, created_at)` PK `(alias, entity_id)`；`entity.canonical_name`；`fact.community_id/strength/last_access_at/valid_to`；`edge.etype/src/dst/valid_to`。
- `errors.ts`：`ERROR_CODES` 无 410 码；`ERROR_META` 是 `Record<ErrorCode, ErrorMeta>`，新增码必须同步补 meta；`tests/unit/errors-logger.test.ts` 逐行抄了详设 §1.5 码表并断言 `ERROR_CODES` 集合一致 → 新增码必须同步更新该测试。
- `static.ts` 只托管 `/ui/graph`、`/ui/graph/`、`/ui/graph/*`；`TOKEN_PLACEHOLDER` 整句替换；产物缺失 503 `E_UI_NOT_BUILT`。
- `src/ui/vite.config.ts` 的 `base = '/ui/graph/'`（产物按绝对路径引用 `/ui/graph/assets/...`）→ `/ui/inbox` 页面复用同一份产物与同一批资源路由，不需要第二套构建。

前端现状：
- `main.tsx` 单入口 `createRoot(host).render(<App/>)`；`api.ts` 有 `resolveToken()`（?token > `window.__MOSHI_TOKEN__` > localStorage）与 `fetchGraph` 的错误处理范式。
- `src/ui/tsconfig.json` include 是逐目录白名单，新目录必须显式加。
- 无路由库、无状态库依赖（不新引依赖）→ 页面分派在 `main.tsx` 用 `pathname.startsWith('/ui/inbox')`。

## 决策记录（P2-07）

- **D1**：批量动作只实现 `invalidate`；`archive`/`prune`、单条决策（`POST /api/queues/:kind/decide`）、合并 diff 视图**不做**，记 §5.3 遗留（属 P2-19-A）。
- **D2**：撤销 op 表放在 `batchRoutes` 插件闭包内的 `Map<string, {expiresAt, snapshots}>`，每个 app 实例独立（测试不串味），签发时懒清理过期项；`op_id` 复用 `newId('batch')`（`b_` 前缀）。
- **D3**：新增错误码 `E_OP_EXPIRED`（410，`mcpCode: -32602`，`retryable: false`），`ERROR_CODES` 与 `ERROR_META` 同步补，`tests/unit/errors-logger.test.ts` 的详设抄录表同步加一行。需记 §5.2：详设 §1.5 码表缺 410。
- **D4**：队列接口不做游标分页（派单契约只有 `limit`/`min_sim`/`max_sim`），一次取 `limit` 条（默认 50、1..200，非法 400 `limit_invalid`）；游标分页记 §5.3。
- **D5**：`preview` 与 `batch` 复用同一个 `previewInvalidate(db, ids)`，保证「预览看到的数字 = 执行时的数字」（同一事务外先后调用，中间无并发写的假设与既有 REST 一致）。
- **D6**：`invalidateMany` 只处理当前 `valid_to IS NULL` 的行（已失效行跳过，不抛 `E_IMMUTABLE`）；`valid_to` 取 `nowIso()`，若与目标行 `valid_at` 撞同一毫秒（`validTo <= valid_at` 会被 `factRepo.invalidate` 拒），顺延 1ms——否则测试里"插入后立刻批量失效"会随机 400。
- **D7**：`restoreMany` 的 UPDATE 带 `AND valid_to = <快照里的 validTo>` 条件：只恢复本批签发的失效，不误开别人后来收口的行；`changes === 0` 跳过并计数。
- **D8**：撤销成功后立即从 op 表删除 → 同一 `op_id` 二次撤销 404 `E_NOT_FOUND`（不得二次还原）；`expiresAt <= now` 判过期 → 410 `E_OP_EXPIRED` 并删表项。
- **D9**：`static.ts` 把 `/ui/graph` 与 `/ui/inbox` 两前缀用同一套 `sendIndex`/`resolveInside`/缓存逻辑循环注册（资源仍只走 `/ui/graph/assets/*`，因为 vite base 固定）。
- **D10**：前端选中集是 `Set<string>`（fact id）放在 `InboxPage`，跨 tab 累加；resolve 行不可选（纯信息展示）；`BatchPanel` 只做展示 + 回调，操作状态（preview/op/倒计时/error）留在 `InboxPage`。
- **D11**：撤销倒计时按 `undo_deadline - Date.now()` 每 250ms 重算；读到 0 自动提示「撤销已过期」并刷新队列（与 410 分支同一处理）。

## 进度

- [x] 读台账 §1/§3/§4 P2-07、详设 §10.6/§10.1/§10.2/§4.3/§1.2/§1.4、概设 §8.3/§8.1
- [x] 核查后端（server/static/facts/repos/db/tx/migrations/errors）与前端（main/api/tsconfig/vite）现状
- [x] 后端：`src/infra/sqlite/inboxRepo.ts`（三队列 + preview/invalidate/restore + 缺失 id 查询）
- [x] 后端：`errors.ts` 新增 `E_OP_EXPIRED`（410）+ 同步 errors-logger 测试
- [x] 后端：`src/app/http/routes/queues.ts`（/api/queues/{resolve,lowconf,prune}）
- [x] 后端：`src/app/http/routes/batch.ts`（preview / batch / undo，插件闭包 op 表 + ttlMs）
- [x] 后端：`server.ts` 注册两插件 + `HttpDeps.batchOpTtlMs?`；`static.ts` 增加 `/ui/inbox` 入口
- [x] 前端：`src/ui/inbox/{api.ts,InboxPage.tsx,BatchPanel.tsx}` + `main.tsx` 分派 + `tsconfig.json` include
- [x] 测试：`tests/unit/inbox.test.ts`（18 例，repo 层）、`tests/unit/batch-http.test.ts`（17 例，inject 全链路）、`static.test.ts` 补 `/ui/inbox` 2 例
- [x] `pnpm typecheck`（0 错）/ `pnpm typecheck:ui`（0 错）/ `pnpm test`（847 passed | 3 skipped；69 passed + 1 skipped files）/ `pnpm build`（TEMP 重定向工程内 `temp/`，vite 83 modules，dist 落盘）
- [x] 浏览器验收 `/ui/inbox`（三 tab、预览含连带失效、确认后撤销倒计时、撤销刷新、过期提示、空态）
- [x] 汇报 Lead（不改台账、不 commit）

## 验收记录（2026-11-03 12:16–12:21）

### 环境（都在临时目录 / 假域名里，不碰 `~/.moshi`）

- 临时 daemon：`.dsh/temp/p2-07/accept-server.mjs`（`node` 直接 import `dist/` 产物：`openDb` + `migrate` + `loadConfig` + `buildHttpApp`），监听 `127.0.0.1:53999`，库 `.dsh/temp/p2-07/home/accept.db`。
- 种子数据：`alias` 3 条 vector(0.88/0.79/0.66) + 2 条不该进队列（human 1.0、vector 0.45）；`fact` 低置信 3 条（conf 0.30/0.38/0.42，imp 0.92/0.70/0.55）、淘汰候选 3 条（strength 0.05/0.09/0.13）、依赖方 2 条；`edge` 5 条（4 条活跃 `depends_on`：dep1→prune1、dep2→low3、prune1→prune2、low1→low2；1 条已失效 dep1→prune3）。
- 入口：whistle 规则 `moshi.local 127.0.0.1:53999`（`dev-service.ps1 map -PublicUrl 'http://moshi.local/' -Port 53999`，带 `# [dev-service]` 备注）；浏览器用 `browser-accounts` 隔离环境 `moshi-p207 --proxy http://127.0.0.1:8899`，打开 **`http://moshi.local/ui/inbox?token=accept-token-p207`**（`curl -x http://127.0.0.1:8899` 与直连均 200、字节一致，HTML 里 token 已注入）。
- **偏离说明（dev-service「入口自证」）**：该页是 `vite build` 的**构建产物**（`/ui/graph/assets/index-*.js`），不是 vite dev server，所以「`@vite/client`/`/src/` 自证」不适用；改用「假域名 + whistle 映射回本地 53999 + 资源带 `/ui/graph/` 前缀 + 该域名无线上站点」证明本地代码，不涉及线上构建混淆。chrome MCP 自带浏览器不走 whistle（`ERR_NAME_NOT_RESOLVED`），按要求改用 browser-accounts 代理环境，未改系统代理、未杀用户浏览器。

### 实测步骤（全部通过）

1. 三 tab 计数 `消解确认（3）/ 低置信（3）/ 淘汰候选（3）`；消解 tab 只有信息行、无 checkbox；低置信/淘汰候选每行 1 个 checkbox。
2. 淘汰候选勾 2 条 → 底部 BatchPanel「已选 2 条事实」→「预览影响」→ 「将影响 2 条事实、2 条边、1 个主题」+ **单独一行警示色**「连带失效 1 条依赖事实（它们依赖这批事实，会一起变 stale）」+ 2 条 sample + 「确认失效（2 条）」「取消」。
3. 确认失效 → 队列刷新（淘汰候选 3→1），notice「已失效 2 条事实（连带失效 1 条）」，浮出撤销条「撤销窗口剩余 30 秒」；3 秒后显示「剩余 20 秒」（250ms tick 生效，≤30s）。
4. 点「撤销」→「已撤销，恢复 2 条事实」，淘汰候选回到 3，选中清空、撤销条消失。
5. 跨 tab 累加：淘汰候选勾 1 + 切低置信勾 1 → 「已选 2 条事实」不丢；预览 → 「将影响 2 条事实、3 条边、2 个主题」+ 连带失效 1（数字与手算一致）；「取消」可回退预览态。
6. 过期路径（410/自动过期）：再确认 1 条后等 33 秒 → 撤销条自动消失、提示「撤销已过期，已刷新队列」、队列 3→2（该条未恢复）。
7. 空态：把淘汰候选剩余 2 条再确认失效 → tab 计数 `淘汰候选（0）` + 「没有待处理项」。
8. 库内复核（`.dsh/temp/p2-07/check-db.mjs`）：`epistemic_status` invalidated 3 条且 **valid_to 全部非空**（无 `valid_to IS NULL` 的 invalidated）；`audit` 按 source：`ui_batch_invalidate` 5 / `ui_batch_undo` 2，reason 均为 `b_` 开头 op_id、field 均为 `epistemic_status`；`edge` 5 条（4 活跃）与种子完全一致 → **批量失效/撤销都没有碰 edge**。
9. 截图存证：`.dsh/temp/be/moshi-p207-*.png`（5 张：首屏三 tab、撤销条倒计时、过期提示、预览含连带失效、空态）。
10. 收尾：临时 daemon 进程已停、whistle 规则已摘、`be env rm moshi-p207` 已删环境；`git status` 未见临时库/截图进入仓库（`.dsh/` 被忽略）。

### 未验证 / 已知偏离

- 未用真实 `moshi daemon` 命令端到端起服务（用 `buildHttpApp` + `dist` 产物等价直连），CLI 接线未覆盖。
- 未做 HTTPS / 真实域名验证（本地假域名）；未做键盘可达性/移动端布局验收（页面为桌面工具型，深色主题 #05070d / 13px 已目视确认）。
- 单条决策、`archive`/`prune` 批量动作、合并 diff 视图均未做（D1，属 P2-19-A）。
- 队列未做游标分页（D4，记 §5.3）；错误码 `E_OP_EXPIRED`/410 是详设 §1.5 码表外的补充（D3，记 §5.2）。
- `pnpm build` 用工程内 `temp/` 重定向后，仓库根出现未跟踪的 `temp/`（`git status` 显示 `?? temp/`，`.gitignore` 未覆盖）→ 需 Lead 决定补 `.gitignore` 或清理，本次未动（不在授权写范围）。
- `git status` 里 `AGENTS.md`（已暂存 M）与 `docs/任务台账.md`（MM）的改动**非本任务产生**，本任务未碰这两份文件。

## 独立验收（2026-11-03 12:56，verify-p2-07）

- 结论：**有条件通过，0 阻断 / 6 非阻断**；报告 `.dsh/temp/p2-07-verify/report.md`（157 行），截图 `shots/01-inbox-three-tabs.png` … `08-expired-no-undo.png`。
- 命令：`pnpm verify` exit 0（**847 passed | 3 skipped；70 files**，基线 812/68 只增不减）、`pnpm build` exit 0（83 modules）、`typecheck`/`typecheck:ui` exit 0；TEMP 重定向 `.dsh/temp/p2-07-verify/temp`。
- 契约核对 A1–A8 全过：三队列 SQL 与详设 §10.6 逐字一致；preview 四数语义含方向反例；batch 单事务逐条 invalidate+audit 且不碰 edge；undo TTL/410/404/CAS 全过；E_OP_EXPIRED 只新增抄录行、无弱化既有码；安全校验全过；前端四数+连带失效单列+倒计时+过期提示；既有测试纯追加。
- scratch daemon 端到端 **51/51**：port 54107（`.dsh/temp/p2-07-verify/c/config.toml`，USERPROFILE/HOME 指向 c/home，未触 `~/.moshi`），种子 7 alias/12 fact/8 edge；`ids=[low1,prune1]→2/6/1/2`、`ids=[low2]→1/3/1/1`；1.28s 撤销恢复、真实等 30.8s→410、二次/未知 404、edge 保持 7 条。
- 浏览器：`http://p207-verify.local/ui/inbox`（whistle 8899→54107，隔离环境 p207verify）8 张截图；32s 过期不可撤且库内仍 invalidated。
- 非阻断偏离已收口：E1→D-104 改详设 §10.6 口径；E2→沿 facts.ts limit 约定（D-105）；E3→I-20；E4→I-21；E5→详设 §1.5 已补 E_OP_EXPIRED；E6→D-105 记录。
- 未验证：单事务回滚、空态/错误态仅代码审查（浏览器未构造）；验收未碰 `~/.moshi` 真实库。

## 收口（2026-11-03 12:56）

- 台账：§1 快照（P2-07 DONE、61/96、当前 P2-08）、§1.1（P2 11 / 合计 61）、§3（25 项 / 26 + 待估 人日；P2-07 DONE）、§5.2 D-103~D-105、§5.3 I-19~I-21、§6 日志 DONE 行。
- 详设：§1.5 补 `E_OP_EXPIRED`（410 / -32602 / 不可重试）；§10.6 撤销段改为「不建不删 edge、只清 valid_to + 还原状态、过期 410、二次 404」并补队列 limit 口径。
- 其它：`.gitignore` 补 `temp/`；`pnpm build` 遗留的仓库根 `temp/` 已被忽略（未删除，供后续构建复用）。
