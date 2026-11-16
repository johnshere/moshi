# V-08 接入结构与采集源归一 — 进度（DONE.m2，2026-11-16）

## 目标（用户 m00871 / m00882 / m01083）

1. **配置源归一**：采集源只有一处配置，导入与自动采集同源；客户没配来源时「自动/手动都不可用」。
2. **菜单归一**：与接入相关的全部放进与「设置」平级的一级「接入」，设置下不再有「接入与日志」。
3. **去掉割裂文案**：首启横幅的三个采集提醒态暂不提示客户（注释掉，等正式接入逻辑定稿）。
4. 开发态不留兼容包袱：不认 `ingest.sources` 旧键，旧地址 `/ui/settings/access-logs` 不做重定向（D-182）。
5. **日志保留策略不单占菜单**（用户 m01083）：一级「接入」只留 日志 / 接入点 两子页，「日志与保留」改日志页右上角弹框（D-183）。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/app/config.ts` | `CollectSchema.sources`（:97，默认 `['claude-code','dsh']`），`IngestSchema.sources` 删除；`resolveSources` 读 `cfg.collect.sources`；错误文案 `collect.sources[index]`（:429）/ id 重复（:436）；新增 `CollectSourceStatus`（:476）/ `CollectSourcesState`（:484）/ `rootIsUsable`（:494）/ `collectSourcesOf`（:509，`configured` = 声明数>0、`available` = 至少一个 enabled 源 root 是目录，`sources` 只列 enabled） |
| `src/app/http/routes/config.ts` | :188 `GET /collect/sources`（挂 `/api` 前缀；token + `cache-control: no-store`；读启动期 cfg，与扫描器同源） |
| `src/app/http/routes/import.ts` | :323-326 `POST /api/import` 前置拦截：`!collectSourcesOf(...).available` → 400 `E_INPUT` / `detail.reason='no_source'`，消息「没有可用的采集来源，请先配置 collect.sources」，不进子进程；CLI 退出码 4 保留兜底 |
| `src/app/main.ts`、`src/app/collectRunner.ts`、`src/app/cli/commands/import.ts`、`src/core/adapters/index.ts`、`tools/dev-db.ts`、`config.example.yaml` | 消费方与示例配置随段名迁移（`ingest:` → `collect:`） |
| `src/ui/shell/pure.ts` | `SettingsSection` 四值（:43）、`SETTINGS_SECTIONS` 四节（:53）、`DEFAULT_SETTINGS_SECTION='config'`（:60）；`AccessSection` 两值 `'logs' \| 'endpoints'`（:66）；`ACCESS_SECTIONS` 只剩 日志/接入点（:76-84）；`NAV` children 由两数组生成（:262/:275）；删 `ACCESS_LOG_CONFIG_PATH`、`isLegacyAccessLogsPath` 与旧地址特判 |
| `src/ui/shell/first-run.ts`、`FirstRun.tsx` | `BANNERS` 改 `Partial<Record<Exclude<FirstRunState,'ready'>, BannerSpec>>`（:94）；`collect_off` 整段注释并注明用户 m00882（:111）；`FirstRun.tsx` 先 `ready → null`，再 `BANNERS[state] === undefined → null` |
| `src/ui/settings/SettingsPage.tsx` | 删 `AccessLogsPanel` 引用与分支，只剩 config/maintain/privacy/diagnose |
| `src/ui/access/LogConfigModal.tsx`（新，117 行） | 「日志与保留」弹框：`role="dialog"` / `aria-modal` / `aria-label="日志与保留"`；遮罩 `rgba(8,12,18,0.78)` zIndex 100、面板 maxWidth 760 / maxHeight 82vh；Esc / × / 点遮罩三法关闭（`data-testid="log-config-modal-close"`）；`initialSection='query-log'\|'plugin-trace'` 打开时 `scrollIntoView`；`!open → null`（关即卸载，面板按需拉 `GET /api/config`）；body 直接挂 `AccessLogsPanel` |
| `src/ui/access/LogsPage.tsx` | 右上角按钮文案「日志与保留」（去 `↗`，全 `src/ui` 已无 `↗`）；点击 `setConfigOpen(true)` 出弹框，不再导航；表头注释改弹框口径 |
| `src/ui/main.tsx` | 删 `LogConfigPage` 引用与 `log-config` 分派；`Root` 只分派 endpoints / logs；旧地址 `replaceState` 块删除 |
| `src/ui/access/api.ts` | `errorBody`；`postImport` 对 400+`detail.reason='no_source'` 抛人话、409→「已有导入在执行」；`fetchCollectSources()` → `GET /api/collect/sources` |
| `src/ui/access/EndpointsPage.tsx` | :113 `noSource`；:123 mount 并行 `fetchCollectSources`；:254 `data-testid="import-sources"`（未知/可用/无源三态文案）；仅无源时渲染 `import-source-list`；:310-313 按钮 `disabled={importRunning \|\| noSource}`；:209 文案「配置在日志页右上角的「日志与保留」弹框」 |
| `src/ui/settings/AccessLogsPanel.tsx` | 头注释改「由 `LogConfigModal` 挂载」（组件本身与 props 未动） |
| `src/ui/api.ts` | `resolveToken` 改经 `globalThis as {window?: TokenWindowLike}` 取（`TokenWindowLike` 最小面），无 window 返回 `''`；三条 token 来源与 try/catch 全保留（修根 `pnpm typecheck` 的 6 处 `TS2304 window`） |
| `docs/概设.md` :1150/:1155/:1161-1167/:1171、`docs/详设.md` :3631、`docs/开发方案-接入层与日志-2026-11-11.md` :16-18/:63-65/:102-108/:119/:127/:139-150 | 旧「设置 › 接入与日志」说法改新 IA：接入两子页 / 设置四二级 / 保留策略写入口在日志页「日志与保留」弹框 |
| 测试 | `tests/unit/config.test.ts`（默认源、旧键 strict 拒绝、`collectSourcesOf` 4 例）、`tests/integration/import-api.test.ts`（无源 400、`GET /api/collect/sources` 有源/无源/401）、`tests/unit/shell.test.ts`（四节设置/两节接入/NAV/`/ui/access/log-config` 兜底 logs）、`tests/unit/first-run.test.ts`（`BANNERS` 无 `collect_off`）、`tests/unit/access-api.test.ts`（新，6 tests） |

## 验证

- `pnpm verify`：**154 files / 1802 tests 全绿**（根 `typecheck` + `typecheck:ui` + 四项 lint + 全量测试）；`pnpm build`：0。
- UI 产物（copy 补丁后最终版）：`dist/app/ui/dist/assets/index-ChdO5ELc.js` 1,358,657B + `index-DQM9ccZD.css` 13,602B，`index.html` 指向新 JS，产物内 `↗` 命中 0。
- 真机（9836，daemon pid 29268，新构建）：
  - `GET /api/collect/sources` → `{"configured":true,"available":true,"sources":[claude-code✓,dsh✓]}`；
  - `/ui/access/endpoints`：菜单 图谱/记忆/待办/归档/接入(**日志·接入点**)/设置；导入卡「可用来源：claude-code、dsh」`data-available=true`、按钮可点；页面无「未配置采集来源」；
  - `/ui/access/logs`：右上角按钮 textContent 实测 `"日志与保留"`、无箭头；点击出 `log-config-modal` + `access-logs-panel`（`query_log_keep_days=3`、`hook_plugin_trace.level=full`、`max_bytes`、`keep_days=14` 可见）；Esc 关、× 关、点遮罩关三法均生效，关闭后 modal 卸载、URL 仍 `/ui/access/logs`；每次打开重新拉一次 `GET /api/config`；
  - `/ui/access/log-config`：已是未知二级，原地渲染日志页（高亮 接入+日志），不 redirect、不白屏；
  - `/ui/settings`：四二级且默认 `config`，无 access-logs 面板；`/ui/settings/access-logs`：URL 不被改写，落到 设置›配置（与任意未知二级一致）；
  - `/ui/hook?from=magpie`：200，外部契约未断；
  - 临时 daemon 9837（`.dsh/temp/t7/nosrc/config.yaml`，`collect.sources` 指向不存在的 root）：`GET /api/collect/sources` → `available:false`；`POST /api/import` → 400 `{error:'E_INPUT',message:'没有可用的采集来源，请先配置 collect.sources',detail:{reason:'no_source'}}`；页面导入按钮 `disabled=true`、来源列表「ghost · claude-code · 不可用」；验完已 stop。
- 截图：`.dsh/temp/t7/01-access-endpoints.png`、`03-settings.png`、`04-nosource-disabled.png`、`05-legacy-now-settings.png`、`06-log-config.png`、`07-log-config-modal.png`（`02-legacy-redirect.png` 记录的是已删除的旧 replace 行为，已过时）。

## 遗留 / 观察

- `collect.enabled` / `interval_ms` / `llm_scan` 仍在 设置 › 配置 的「采集与整理」段，与 `collect.sources` 分居两处（想法池 I-68，等接入逻辑定稿一起做）。
- `/api/import/status` 仍只存内存（想法池 I-67②，未修）。
- 弹框交互（开/关/点遮罩/Esc）只有真机验收，仓库无 DOM 渲染器，没有自动化回归（想法池 I-69）。
- 历史文档 `docs/设计-Hook台账节点与Magpie适配器.md`、`docs/测试-Hook台账节点-2026-11-10.md` 里的五二级描述属当时设计快照，刻意不改。
