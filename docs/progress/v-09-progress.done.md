# V-09 UI 国际化 S1（基建 + 首批页面）— 进度（DONE.m2，2026-11-16）

## 目标（用户 m01241，D-184）

1. 界面支持 **中文（默认）/ English** 双语，顶栏一个开关切换，刷新后保持。
2. 自研词典，不引第三方 i18n 依赖；**中文是 key 的定义处**，英文缺键在编译期报错。
3. 约定：**后端字段值不翻译**——`ftype` / `epistemic_status` / `turn` / `outcome` / 日志 `kind`、`status` 等枚举值一律经 `enumLabel(域, 值)` 映射，未知值兜底原样显示。
4. S1 范围：基建 + shell（菜单/三灯/角标）+ 设置四二级 + 记忆页 + 筛选条 + 事实表格 + 日志页 + 接入点页 + 接入页 + 「日志与保留」弹框。剩余页面留 S2（V-10）。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/ui/i18n/dict.ts`（新） | 中文词典，key 的**定义处**；命名空间：`common.*`、`app.*`、`locale.*`、`nav.*`、`settings.section.*`、`access.section.*`、`topbar.*`、`light.*`、`memories.*`、`filter.*`、`table.*`、`enum.<域>.<值>`、`logs.*`、`endpoints.*`、`access.*` |
| `src/ui/i18n/dict.en.ts`（新） | 英文词典，`satisfies Record<DictKey, string>` → 少一个键就编译失败；除 `locale.zh='中'` 外不得含中文 |
| `src/ui/i18n/index.ts`（新） | `translate(locale, key, vars)`、`t = useT()`（读当前 locale 的绑定）、`hasKey()`；占位符 `{name}` 替换，缺参**保留原样** `{name}` 便于发现 |
| `src/ui/i18n/enums.ts`（新） | `DOMAIN_PREFIX`：`ftype` / `epistemic` / `logKind` / `logStatus` / `turn` / `outcome` / `install`；`enumLabel(domain, value)` 未知值返回原值 |
| `src/ui/state/locale.ts`（新） | `localStorage['moshi.locale']`，初值取 `navigator.language`（`en*` → en，其余 zh）；写 `localStorage` 同时同步 `<html lang>`；window/document/navigator 全走 `globalThis` 最小结构面（根 tsconfig 无 DOM lib，node 侧单测 import 不炸 TS2304） |
| `src/ui/shell/LocaleSwitch.tsx`（新） | 顶栏「中 / EN」两枚按钮，`data-testid="locale-switch" / "locale-zh" / "locale-en"`；在 `ScopeSwitcher` 之后、三灯之前 |
| `src/ui/shell/pure.ts` | `PageDef` / `SettingsSectionDef` / `AccessSectionDef` / `NavChild` / `NavNode` / `StatusLight` 的 `label`/`title`/`text` 改 `labelKey`/`titleKey`/`textKey`（`DictKey`），`textVars` 承载角标数 |
| `src/ui/shell/Shell.tsx` | 菜单树、三灯、角标全部 `useT()` 渲染；插入 `LocaleSwitch` |
| `src/ui/settings/SettingsPage.tsx` | `HINTS` 改 `DictKey`；四二级标题与描述走 `t()` |
| `src/ui/memories/MemoriesPage.tsx` | 标题、`memories.canonicalApprox` 等走 `t()` |
| `src/ui/filter/FilterBar.tsx` | 筛选 chips 走 `t('filter.*')`，`ftype`/`epistemic_status` 下拉走 `enumLabel` |
| `src/ui/table/FactsTable.tsx` | 搜索框、表头、排序、空态、页脚、枚举列走 `t()` / `enumLabel` |
| `src/ui/access/LogsPage.tsx` | 删本地 `KIND_LABEL` 改 `enumLabel('logKind')`；统计 chip、来源/状态下拉、搜索刷新、表头、行与详情、分页全走 `t()`；「日志与保留」按钮 |
| `src/ui/access/EndpointsPage.tsx` | `ENDPOINTS` / `IMPORT_RANGES` 改 `*Key: DictKey`；`importStatusText(t, status, now)` 新增 `t` 首参；四卡 + 导入卡（来源可用/不可用、范围、状态、轮询）全走 `t()` |
| `src/ui/access/AccessPage.tsx` | 删 `TURN_LABELS` / `STATUS_LABELS` / `INSTALL_LABELS` 改 `enumLabel`；结果条 `data-tone` 由 `includes('失败')` 改显式 `resultTone` 状态；连接卡、三开关（`enabled`/`inject_existing`/`capture_reply`）、接入矩阵、注入台账、F8 遮罩、手动安装弹窗、二次确认弹窗（`access.confirm.*`）全部 `t()` |
| `src/ui/access/LogConfigModal.tsx`、`src/ui/settings/AccessLogsPanel.tsx` | 「日志与保留」弹框与面板：标题/说明/两组档位/清空二次确认/保存反馈全走 `access.logConfig.*`、`access.logRetention.*`（29 键） |
| `src/ui/access/api.ts` | 409 → `t('endpoints.import.error.running')`、400 `no_source` → `t('endpoints.import.error.noSource')`；错误映射不再拼中文串 |
| `tests/unit/i18n.test.ts`（新） | 9 例：中英键集一致、无空串值、英文除 `locale.zh` 外无中文残留、占位替换、缺参保留 `{x}`、`enumLabel` 已知值与未知值兜底、`hasKey` |
| `tests/unit/shell.test.ts` | :263 断言 `child.label` 改 `translate('zh', child.labelKey)` |

## 验证

- `pnpm typecheck`（根）0、`pnpm typecheck:ui` 0（每批页面改完即跑，全绿才继续）。
- `pnpm verify`：**155 files / 1811 tests 全绿**（四项 lint + 全量测试）。
- `pnpm build` 0：UI 产物 `src/app/ui/dist/assets/index-DBqqWOBa.js` 1,389.20 kB + `index-DQM9ccZD.css` 13.60 kB（daemon 静态资源读磁盘，无需重启）。
- 真机 9836（edge MCP 浏览器验收）：默认 `zh-CN` → 点 EN 后全站英文（Shell 菜单、设置四二级、记忆页、日志页、接入点页、接入面板），`localStorage['moshi.locale']='en'`、`<html lang>='en'`，刷新保持；日志页「Logs & retention」弹框整块英文；切回中文刷新 `lang='zh-CN'`、文案回中文。
- 已知残留（属 S2 范围）：`ScopeSwitcher`「全部作用域」、`SearchBox`「搜索事实」、Claude Code 的 `unsupported` 原因（**服务端下发的中文**，需后端改码值）。

## 下一步

- **S2 / V-10**：`inspector/`、`inbox/`、`batch`、`archive/`、设置各面板（`ConfigForm` / `DiagPanel` / `MaintenancePanel` / `PrivacyPanel` / `UpdatePanel`）、`history/`、`graph/`、首启与 `OnboardModal`、`main.tsx` 顶栏收敛（搜索与 scope 下移记忆页工具条），以及 `ScopeSwitcher`/`SearchBox` 文案。
- **S3 / V-11**：`src/ui`（除 `i18n/`）裸中文门禁白名单测试 + 概设/详设补「UI 国际化」小节。
- 后端后续项：`plans.labels`、`plans.manual`、`InstallStep.action`（`'新增'|'修改'|'删除'`）改码值，前端再译。
