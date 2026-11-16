# Z-01C Hook 台账节点 + Magpie 适配器 · 进度

状态：**WIP**（m2）——本体 a..f 遗留未做；子节点 **Z-01C-g / Z-01C-h / Z-01C-i 已 `DONE.m2`**（2026-11-10）
开始：2026-11-10
设计：`docs/详设.md` §14（原专题 §16 已删）
决策：D-173（协议自持 / budget / Magpie 2-7 时机）、D-174（身份哈希口径）、D-175（项目三步识别）
测试：git 历史（原测试文档已删）；第一轮 = 协议/注入/signal，第二轮 = 入驻/安装/界面 IA

## 步骤

| # | 步骤 | 状态 | 备注 |
| --- | --- | --- | --- |
| 1 | 设计文档落盘 | 完成 | `docs/详设.md` §14 |
| 2 | 台账加节点 Z-01C | 完成 | §1 / §1.1 / §3 / §4 卡片 / §9.2 / 决策 / 日志 |
| 3 | 首次 commit + push（文档 + 台账） | 完成 | `0ecdaa9`（当时 push 失败，后随网络恢复补推成功） |
| 4 | 实现 Magpie 侧 | 完成 | domain/identity → core/hook → http routes → cli hook → packages/magpie-moshi |
| 5 | 实现完 commit + push（不测） | 完成 | `ae4f81b` |
| 6 | 本机测试（第一轮） | 完成 | 真端口 + 真插件 + 真 SQLite，见测试文档第一轮 |
| 7 | 有网则再 commit + push | 完成 | 网络恢复后 `bb4ab5f` → `3657a67` → `0426c7c` 全部推上 |
| 8 | §16 设计（入驻 + 界面 IA）落盘 | 完成 | 原专题 §16（16.1~16.10，文档已删）；台账 `bb4ab5f` |
| 9 | Z-01C-g U-IA 实现 | `DONE.m2` | 见下节 |
| 10 | Z-01C-h ONBOARD 实现 | `DONE.m2` | 见下节 |
| 11 | Z-01C-i INSTALL 实现 | `DONE.m2` | 见下节 |
| 12 | 第二轮门禁 + 机测 + 测试文档 | 完成 | `pnpm verify` 145 files / 1695 tests；测试文档第二轮；`0426c7c` |
| 13 | 本体遗留 a..f（`moshi_id` 接线 / sidecar 编码 / CC 一次性入口 / MCP 安装 / 真 plugin-host 往返 / `hook status` 占位） | 待开始 | 见测试文档 §15 与台账 §1 下一步 |

## 变更记录

### 2026-11-10 00:47 设计与台账

- 新增 Hook 专题设计文档（已删）。
- 决策记录追加 D-173 / D-174 / D-175。
- 台账 §3 v1.1 加 Z-01C 行（2.5 人日），Z-01A 标注「由 Z-01C 收编」；§1.1 v1.1 计数 8→9、合计 113→114；§1 快照当前任务与下一步改写；§9.2 加 Z-01C 行、机器相关节点数 11→12。
- `docs/任务台账/任务详述.md` 写入 Z-01C 卡片（目标/依据/产出/验收 AC-1..AC-8/坑）。

### 2026-11-10 08:30 子节点 g/h/i 收口（DONE.m2）

新增/改动文件：

- **U-IA（g）**：`src/ui/shell/pure.ts`（`SettingsSection` / `SETTINGS_SECTIONS` / `HOOK_UI_PATH` / `sectionFromPath` / `isStandaloneHook` / `settingsHref` / `NAV` 树 / `RouteInfo.section|standalone`）、`src/ui/shell/Shell.tsx`（左侧菜单树 + `OnboardModal` 挂载 + section prop）、`src/ui/settings/SettingsPage.tsx`（五二级页签 + 内容分派）、`src/ui/main.tsx`（`/ui/hook` 独立渲染 + 设置二级）、`src/ui/access/AccessPage.tsx`（新建，React 版接入页）、`src/app/http/static.ts`（`HOOK_PAGE_PATH` + SPA fallback 6 前缀）、**删除** `src/app/http/hookPage.ts`（309 行内联 HTML）。
- **ONBOARD（h）**：`src/app/onboard/{state,detect,routes}.ts`（新建）、`src/infra/proc/processes.ts`（新建）、`src/ui/shell/OnboardModal.tsx`（新建）、`src/app/http/server.ts`（注册 `/hook/api` onboard 路由 + `?from=magpie` 服务端置连接态）、`src/ui/shell/first-run.ts`（删掉 MCP 旧提示语）。
- **INSTALL（i）**：`src/app/onboard/install.ts`（新建：plan/apply/uninstall + 白名单例外通道只加目标目录）、`tools/copy-assets.mjs`（复制 `packages/magpie-moshi` → `dist/magpie-moshi`）、`src/ui/tsconfig.json`（include 显式化）。

验收证据（详见 git 历史（原测试文档已删） 第二轮）：

- `pnpm verify` 145 files / 1695 tests / 163.32s 全绿；`pnpm build` 通过（`dist/magpie-moshi` 4 文件已复制）。
- 新增测试：`tests/unit/onboard.test.ts`(17)、`tests/integration/onboard-api.test.ts`(9)、`tests/unit/shell.test.ts` +5、`tests/integration/hook-api.test.ts` 改 2 例。
- 真机探测三客户端全中（magpie via `['dir','port','process']`，CC/DSH via `['dir']`）。
- 浏览器全流程：首启弹窗 → 二次确认（列 5 条写入路径）→ 真实写入 `~/.config/magpie/plugins` → 跳 `/ui/hook?from=onboard&result=ok` 显示结果 → 页面「卸载」删净回滚。
- 机测发现并修 4 个 bug：`/ui/hook` 被误当受保护路径（401）、弹窗与五态提示条重叠、MCP 旧文案残留、装完同路由跳转不刷新。
- 提交：`3657a67`（功能）、`0426c7c`（机测修复），均已 push。

### 2026-11-10 19:25 m1 身份适配修复（Z-01C-a/b 补 · 真 Magpie 往返）

- 插件真实装入本机 Magpie 0.1.3362（本地路径 spec，`plugin-host` 热加载）；发现三处适配错误并修复：ctx 读成嵌套（真实是扁平 `GatewayContext`）、cwd 未清洗、`report` 第二参误传证据条数（面板显示「已注入 5 字节」）。
- 身份策略：`ctx.session` 非空直接用；DSH 无 session 头 → 会话开头指纹（跳过 `runtime-context` 快照），cwd 自解析 body 只用于 project，不进指纹。
- 证据：真实流量 `identity_source=vcs`、`inject_bytes` 649–842、latency 70–98ms；直连 recall `moshi_id=4628a84d…`、`project_id=7dcf8c88…`、注入头带工程哈希。
- 回归：`pnpm verify` 145 files / 1705 tests、`pnpm build` 通过；设计文档补 §7.1.1（字段来源源码级更正）。
