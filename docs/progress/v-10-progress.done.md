# V-10 UI 国际化 S2（全量抽取）— 进度（DONE.m2，2026-11-16）

## 目标（用户 m02019「继续下面的步骤」，承接 D-184/D-185）

1. 把 S1 没覆盖的 UI 文件**全部**接进自研词典，做到「`src/ui` 除 `i18n/` 外无裸中文字面量」这一步只差门禁测试。
2. 顺带完成用户 m01201 的顶栏收敛：顶栏只留 语言 + 三灯 + 待办角标，全局搜索与作用域下拉下移记忆页工具条。
3. 手法固定（D-185）：纯函数模块翻译函数作**末尾可选参**默认 zh；模块级中文常量表拆 `*_KEYS` + 调用期函数；标点/括号进词典；数据契约（`[失效]`、服务端 `action`/`reason`）不译。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/ui/shell/Shell.tsx` | 顶栏删 `SearchBox`/`ScopeSwitcher` 渲染；新增模块级 `focusGlobalSearch()`（找不到 `[data-testid="global-search"]` 就先 `navigatePage('memories')` 再 20×50ms 轮询聚焦），`case 'focus-search'` 改调它 |
| `src/ui/memories/MemoriesPage.tsx` | 工具条插入 `<SearchBox />` + `<ScopeSwitcher />`（`memories.title` 之后、`FilterBar` 之前） |
| `src/ui/shell/scope-options.ts` | `scopeLabel(scope, t)` / `scopeOptions(items, current, t)`，`t: T = translateNow`；`scope.all`/`scope.global` 走词典 |
| `src/ui/shell/ScopeSwitcher.tsx`、`shell/SearchBox.tsx` | `useT()` + `enumLabel('ftype', …)`；`scope.switcher.label/title`、`search.global`/`search.placeholder` |
| `src/ui/filter/FilterBar.tsx` | 裸 `scope` 标签 → `t('filter.scope')` |
| `src/ui/main.tsx` | 图谱 HUD 全量：`VIEWS` 改 `{ v, labelKey, titleKey, tagKey }`；`ActivityNote`/`TraceNote`/`ImpactPreview` 各自 `useT()`；深链未命中由拼中文改 `focusMiss: boolean` + `t('graph.focusMiss', { focus, limit })`；`graph.truncated` 四变量（`{returned,total,limit,full}`）；底部提示/无坐标/取数失败全键化 |
| `src/ui/settings/MaintenancePanel.tsx` | `TARGETS`/`COUNT_LABELS` 改 `labelKey: DictKey`；`settings.maint.*` 14 键；`errorText` 走 `translate('settings.cfg.httpError', …)` |
| `src/ui/settings/UpdatePanel.tsx` | `message` 状态由字符串改 `{ key: DictKey; vars? }`，渲染 `t(message.key, message.vars)`；`settings.update.*` 18 键 |
| `src/ui/settings/ConfigForm.tsx` | `FIELD_GROUPS` → `titleKey/hintKey/labelKey`；端口提示拆 `portNoticePrefix/Suffix` 中间夹 `<code>`；`settings.cfg.*` 33 键 |
| `src/ui/settings/DiagPanel.tsx` | `QUALITY_FIELDS` 改 `labelKey`；`formatMetric` 走 `translate('diag.noData')`；`diag.*` 40 键（含 `diag.evalRunning`） |
| `src/ui/settings/PrivacyPanel.tsx`、`settings/privacy-pure.ts` | `PURGE_SCOPES` → `purgeScopes(t)`；`purgeSummary(wouldDelete, t)`；`overviewRows(overview, t)` 七行全键化（`privacy.row.*` + `privacy.row.*Value`）；`evalRunText(result, httpStatus, t)`；`privacy.*` 44 键 |
| `src/ui/inspector/Inspector.tsx`、`inspector/pure/lastAudit.ts`、`inspector/pure/attrs.ts` | `lastModifiedLine(audit, t = translateNow)`；`formatExtValue(value, t = translateNow)`（`开/关` → `inspector.attr.on/off`）；`inspector.*` 37 键 |
| `src/ui/inbox/InboxPage.tsx`、`inbox/BatchPanel.tsx` | `TABS` 改 `labelKey/hintKey`；`decideNotice(action, before, after, t)`；`setError(t('inbox.decideFailed', { error }))`；`inbox.*` 35 + `batch.*` 24 键 |
| `src/ui/archive/ArchivePage.tsx`、`archive/ProposedDialog.tsx`、`archive/pure.ts` | `EMPTY_TOPICS_HINT` → `emptyTopicsHint(t)`；`PROPOSAL_ACTIONS` → `proposalActions(t)`；`archive.*` 36 键 |
| `src/ui/history/HistoryPanel.tsx`、`history/pure.ts` | `REPLAY_MISS_MESSAGE` → `replayMissMessage(t)`；`history.*` 9 键 |
| `src/ui/memories/EntityMergePanel.tsx` | 面板与入口按钮全键化（`merge.*` 19 键），源/目标选择、预览计数、合并结果都走占位符 |
| `src/ui/shell/OnboardModal.tsx` | `VIA_LABELS` → `VIA_KEYS`（`Record<string, DictKey>`）；pick/confirm 两阶段全部 `t()`（`onboard.*` 24 键），`plan.reason`/`step.action` 属服务端码值 |
| `src/ui/shell/FirstRun.tsx`、`shell/first-run.ts` | `BannerSpec` 的 `text/hint` 改 `textKey/hintKey`；`firstRun.*` 6 键；重试按钮 `common.retry` |
| `src/ui/access/EndpointsPage.tsx` | 来源 id 连接符 `.join('、')` → `.join(t('common.listSep'))` |
| `src/ui/access/AccessPage.tsx` | 不支持原因 `t('access.notSupported', { label, reason })`；两处 `（…）` 改 `t('common.paren', { text })` |
| `src/ui/i18n/dict.ts`、`dict.en.ts` | 键总数 **284 → 675**（S2 新增 391 键），中英键集一致 |
| `tests/unit/first-run.test.ts` | `BANNERS.daemon_off?.text` → `?.textKey === 'firstRun.daemonOff.text'` |
| `tests/unit/privacy-panel.test.ts` | `PURGE_SCOPES` → `purgeScopes()`（3 处） |
| `tests/unit/archive-page.test.ts`、`tests/unit/history-replay.test.ts` | `EMPTY_TOPICS_HINT`/`PROPOSAL_ACTIONS`/`REPLAY_MISS_MESSAGE` 改调用期函数 |

## 验证

- `pnpm typecheck`（根）0、`pnpm typecheck:ui` 0。
- `pnpm verify`：**155 files / 1811 tests 全绿**（四项 lint + 全量测试）。
- `pnpm build` 0：`src/app/ui/dist/assets/index-037HeXiV.js` 1,431.55 kB（gzip 383.52 kB）+ `index-Byb2Y3My.css` 13.62 kB。
- 真机 9836（edge MCP，`localStorage['moshi.locale']='en'`）：
  - `/ui/settings` 五页零裸中文（隐私页唯一残留是服务端目录名 `默识归档`，属数据）；
  - `/ui/settings/diagnose` 零裸中文（`orphan ratio`/`degree mismatch 0`/`Run golden set` 等）；
  - 记忆页实体合并面板：`Merge entities` / `Set as source` / `Set as target` / `Preview` / `Confirm merge` / `Mergeable: yes · moves …`；
  - 首启弹窗（先 `POST /hook/api/detect?refresh=1` 造 `should_prompt`）pick 阶段：`Connect your agent` / `Detected (directory, port, process)` / `Coming soon (display only for now)` / `Detect again` / `Maybe later` / `Next`；confirm 阶段：`Confirm install` / `Heads-up: …` / `Back` / `Install`；
  - 归档页、接入页零裸中文；图谱页/待办页/记忆页仅剩**数据正文**与**服务端下发**文案。
- 残留中文全部属 I-70（后端改码值）：`plan.reason`（`缺少一次性钩子入口（moshi hook emit 未实现）` 等）、`step.action`（`新增/修改/删除`）、`plan.risk`、`step.note`、`plans.labels`、`plans.manual`。

## 下一步（S3 / V-11）

1. 门禁测试：`src/ui`（除 `i18n/`）出现裸中文字面量即失败；白名单只留数据契约（`'[失效]'`、`'新增'|'修改'|'删除'`、`zh-CN`/`moshi`）。`.dsh/temp/cjkcheck.mjs` 的注释剥离逻辑可直接搬进测试。
2. 英文审校：逐页 EN 截图复核，修不通顺英文（当前英文本轮为直译，未做母语审校）。
3. 概设 §8.11 / 详设 §10.9 补「UI 国际化」小节。
4. 台账收口 V-11 → DONE.m2。
