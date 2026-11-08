# V-03 Windows 安装器（NSIS） · 进度

- 状态：DONE.m2（2026-11-08）
- 决策：D-170（环境责任边界与安装流程）
- 机器：m2（Windows 11 26200；平台绑定节点）

## 执行与产出

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 打包脚本 | `scripts/build-installer.mjs`：`pnpm build` → `pnpm deploy --prod --node-linker=hoisted` → 只拷 `dist/node_modules/migrations/sidecar` 到干净 stage → 查 Node 22 最新版 → `makensis`；`pnpm build:installer` |
| 2 | 安装器 | `packaging/windows/installer.nsi`：per-user 装到 `%LOCALAPPDATA%\Programs\moshi`；欢迎/目录/依赖页/安装/完成；依赖页探测 Node，缺失时勾选下载；静默安装也能自动探测 |
| 3 | 依赖下载 | `install-node.ps1`：官方 zip → 校验 `SHASUMS256.txt` → 解压到 `%LOCALAPPDATA%\moshi\node` → 自报版本；`check-node.ps1` 输出 OK/OLD/MISSING |
| 4 | 启动与登录项 | `moshi.cmd` 优先用下载的 Node、否则 PATH；`launch.vbs` 隐藏窗口跑 `init`/`daemon`；开始菜单快捷方式；`HKCU\...\Run` 开机启动（依赖页可取消） |
| 5 | 优雅停止 | `POST /api/control/stop`（`HttpDeps.onStop`，先回包再 setImmediate 停止）；`stop-moshi.ps1` 读 lock（支持自定义 data_dir）→ 调端点 → 超时兜底强杀 |
| 6 | 卸载 | 先跑 `stop-moshi.ps1`，删程序目录/快捷方式/Run 键；**数据目录保留**并提示 |
| 7 | 文档 | 概设 §11.6 改写（不内嵌 Node/Python/模型）；D-170；台账 §1/§3/§9.2/§9.3 |

## 验收读数

- `pnpm verify`：135 files / 1602 tests 全绿；`pnpm build` exit 0
- 新增单测：`tests/unit/control-api.test.ts`（2）——有 `onStop` 先回包再异步停；非 daemon 501；无 token 401
- 构建：`node scripts/build-installer.mjs` → `temp/installer/moshi-setup-0.1.0.exe`（5.8MB）
- 静默安装（`/S /D=temp\v03-install`）：安装体积 49MB；`moshi.cmd version` → `moshi 0.1.0`；`HKCU\Software\moshi\InstallDir` 与 Run 项正确；开始菜单 `默识.lnk` 存在
- 依赖下载：`install-node.ps1 -Version 22.23.4` → SHA256 通过、`node.exe --version` = v22.23.4；PATH 仅 system32 的静默安装 → `%LOCALAPPDATA%\moshi\node\node.exe`（测试用临时 LOCALAPPDATA），`moshi.cmd version` 仍输出 `moshi 0.1.0`
- 安装实例运行：`moshi.cmd --config temp\v03-install-node-accept.toml daemon`（9842，临时库）→ `/api/status` `daemon:ok`，sidecar 缺失降级纯符号；`POST /api/control/stop` → `{"ok":true}` 后进程退出
- 卸载（`/S`）：程序目录、快捷方式、Run 项消失；`~/.moshi/moshi.db`（35.7MB）保留
- 尾部：测试卸载器会按 lock 停掉默认数据目录的 daemon；验收后已重启生产 daemon（9836，sidecar ready）

## DoD

1. 代码落盘 ✅
2. build 过 ✅（含安装包）
3. 验收输出已抄进度日志 ✅
4. 关键分支单测 ✅（control stop；安装/下载/卸载走端到端）
5. 无未记录 TODO/FIXME ✅
6. §1/§3/§6 已更新 ✅
7. 生产接线点 ✅（`pnpm build:installer` → NSIS → `moshi.cmd` → `dist/app/main.js`；`onStop` 在 `main.ts` 接线）
8. 机器相关证据 ✅（§9.3/m2#V-03）

## 遗留

- 自动更新拆为 **V-03B**：需要首个 GitHub Release 与发布授权，本节点只交付手动升级的安装包。
- 未做代码签名，SmartScreen 会提示"未知发布者"；签名证书归发布流程。
- 依赖下载源固定 `nodejs.org/dist`；国内镜像可在后续做成安装器参数。
- Python 组件（V-04）在依赖页只给出入口说明，未下载。
