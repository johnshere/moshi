# I-70 进度（DONE.m2）

> 2026-11-16，m2。上游：V-11（UI 国际化 S3）收口后发现英文界面里仍有中文，全部来自服务端下发的整句。
> 用户 m03208：「继续，不要使用子代理。」→ Lead 亲自改。

## 目标

安装计划相关的服务端文案（`plan.reason` / `plan.risk` / `step.note` / `step.action` / 手动安装说明）改为**码值 + 数据**下发，句子在 UI 层按当前语言拼；这样 `enumLabel` 才有意义，门禁白名单也能只剩真正的数据契约。

## 改动

### 服务端（`src/app/onboard/`）

| 文件 | 改动 |
| --- | --- |
| `install.ts` | 新增 `InstallAction = 'add'\|'update'\|'remove'`、`InstallReasonCode`（`plugin_dir_missing`/`package_missing`/`hook_emit_missing`/`host_plugin_missing`/`mcp_not_implemented`/`nothing_to_uninstall`）、`InstallRiskCode = 'reload_plugin_host'`、`InstallStepNote`（`{code:'from_package',file}` / `{code:'registry_present'}` / `{code:'registry_add',spec}`）；`InstallPlan.reason: InstallReasonCode\|null`、`risk: InstallRiskCode\|null`。`InstallRecord.reason` 仍是自由字符串（安装失败的错误诊断，不属 I-70） |
| `routes.ts` | 删 `MANUAL_HOOK` / `MANUAL_MCP` 两个中文多行常量（注释指向词典 `access.manualText.*` 为正本）；`GET /hook/api/install/plan` 响应删 `manual` 字段；占位计划 reason 改 `claude-code → hook_emit_missing`、其它 → `host_plugin_missing`。`HOST_LABELS`（Magpie / Claude Code / DSH）保留，品牌名中英同形 |

### UI

| 文件 | 改动 |
| --- | --- |
| `src/ui/access/plan.ts`（新） | 线上契约类型（`HookHost`/`InstallStep`/`InstallPlan`/`PlanPayload`，`reason`/`risk` 放宽为 `InstallReasonCode\|string\|null` 以兼容旧 `onboarding.json`）+ 映射：`actionText`、`reasonText`（空/null/undefined → `''`）、`riskText`、`noteText`（`from_package` 拼 `access.note.fromPackage`，旧字符串原样）、`MANUAL_TEXT_KEYS` / `manualTextKey(host, kind)` |
| `src/ui/access/AccessPage.tsx` | 删本地镜像接口，改 `export type { HookHost } from './plan.js'` + 具名导入；`{actionText(step.action)}`、`noteText(step.note) ?? ''`、`reasonText(...) \|\| t('access.result.unknownReason')`、`riskText(...)`、`{t(manualTextKey(manual.host, manual.kind))}` |
| `src/ui/shell/OnboardModal.tsx` | 同样删镜像接口改 import；`reasonText(plan.reason)`、`actionText(step.action)`、`riskText(plan.risk)` |
| `src/ui/i18n/dict.ts` / `dict.en.ts` | +19 键：`enum.installAction.*`（3）、`enum.installReason.*`（6）、`enum.installRisk.reload_plugin_host`、`access.note.*`（3）、`access.manualText.*`（6，多行文案用 `\n` 存在词条里）；删无引用的 `access.manual.empty` |
| `src/ui/i18n/enums.ts` | `DOMAIN_PREFIX` 加 `installAction` / `installReason` / `installRisk` 三域 |

### 测试

- 新增 `tests/unit/access-plan.test.ts`（5 例）：动作码映射 + 未知码原样；`reasonText` 对 null/空/未知码/旧中文整句；`riskText`；`noteText` 对三种 note 与旧字符串；六种 `manualTextKey` 唯一 + `hasKey` + 中英都 >10 字符且英文无 CJK。
- `tests/unit/onboard.test.ts`：`reason` 断言 `'plugin_dir_missing'`；注册表步骤断言从「修改」改为两条路径——注册表已有 spec → `update` + `{code:'registry_present'}`，新装 → `add` + `{code:'registry_add', spec: <abs path>}`；`risk` → `'reload_plugin_host'`；MCP 占位 → `'mcp_not_implemented'`；重装幂等用例再规划一次断言全 `update`。
- `tests/integration/onboard-api.test.ts`：去掉 `manual` 的类型与断言，改 `expect(body).not.toHaveProperty('manual')`，并按 host 断言 reason/risk/action 码值。
- `tests/unit/i18n-gate.test.ts`：白名单删 `src/ui/access/AccessPage.tsx` 条目，只剩 `src/ui/graph/pure/encoding.ts` 的 `'[失效]'`。

## 验证

- `pnpm typecheck` 0、`pnpm typecheck:ui` 0；目标单测 44 例全绿。
- `pnpm verify` **157 files / 1820 tests 全绿**；`pnpm build` 0（`index-DrEkLQmP.js` 1,437.86 kB / gzip 385.33 kB + `index-Byb2Y3My.css` 13.62 kB），`node tools/copy-assets.mjs` 已跑。
- 真机 9836（daemon 重启为 pid 24384，新 token）：`/ui/hook` 英文环境
  - 不支持原因：`Not supported: Missing one-shot hook entry (moshi hook emit is not implemented)`、`Missing in-host plugin (design §11.2 is not implemented)`；
  - 手动安装弹窗（`Claude Code · plugin manual install`）整段英文；
  - 二次确认：`Add` ×4 / `Update`（注册表）+ `(from E:\…\hook.cjs)` + `Note: The plugin is registered as an absolute-path spec…`；
  - `GET /hook/api/install/plan` 响应键 `plans,labels,keys`，无 `manual`；magpie hook 五步全 `update`，risk `reload_plugin_host`。
- 环境复原：误点旧版 `Uninstall`（当时无二次确认）后重新 `Install`；`~/.config/magpie/plugins/node_modules/moshi/`（hook.cjs 18394 B / identity.cjs 2880 B / index.cjs 469 B / package.json 651 B）与 `~/.config/magpie/plugins.json`（spec 指向该目录）复原，页面回 `Installed v0.1.0`。

## 教训

1. **兼容要放宽类型，不要严格码值**：`onboarding.json` 是本地持久文件，用户机器上可能存着上一版结构；`reason` / `risk` / `note` 放宽为 `string` 后旧中文原样显示，不空白。
2. **镜像接口是负债**：`AccessPage.tsx` 与 `OnboardModal.tsx` 各有一份 `InstallStep`/`InstallPlan` 镜像类型，改码时两处都得改；合并到 `src/ui/access/plan.ts` 后只有一处。
3. **多行文案进词典**：`access.manualText.*` 的值是带 `\n` 的多行串，写 `keys.json` 时要写成 `\\n`（`addkeys2.mjs` 负责还原），否则词条里会出现字面 `\n`。
4. **白名单是账要清**：改码后 `AccessPage.tsx` 那条白名单失去理由，必须同步删掉，否则门禁形同虚设。
5. 真机点按钮前先确认按钮有没有二次确认——旧版 `Uninstall` 直接执行，误点一次（已复原）。

## 下一步

- 可选：英文文案母语润色（当前多为直译）。
- 回主线：接入层与日志的待裁定项；Phase 4 数据受限项 P4-01 / P4-03（等 I-60 与真实数据）。
