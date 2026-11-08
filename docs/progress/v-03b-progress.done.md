# V-03B 自动更新 · 进度（DONE.m2）

- 日期：2026-11-08
- 机器：m2（JOHN）
- 决策：D-172（GitHub Releases latest + 精确资产名 + 域名白名单 + `/S` 静默安装 + `launch.vbs` 重启）

## 交付

- `src/domain/update.ts`：版本解析/比较、资产命名与精确选择（纯函数）。
- `src/app/update/check.ts`：读 GitHub latest，折成 `moshi-update/1`；联网失败折 `ok:false`。
- `src/app/update/download.ts`：落盘 `<data_dir>/updates/`，校验字节数。
- `src/app/update/install.ts`：Windows 下 detached `cmd /d /s /c "<installer>" /S`，装完 `launch.vbs init`。
- `src/app/http/routes/update.ts`：`GET /api/update`（60s 缓存，`?force=1`）、`POST /api/update/download`、`POST /api/update/install`（先回包再停 daemon）。
- `src/app/config.ts`：`[update] enabled/repo/feed_url`；`src/domain/errors.ts` 增 `E_UPDATE`。
- `src/ui/settings/UpdatePanel.tsx`：检查 / 下载 / 安装并重启；接入设置页。
- 测试：`update-domain.test.ts`（5）、`update-api.test.ts`（9）、`update-install.test.ts`（2）、`update-install-spawn.test.ts`（1，真实执行）。

## 验证

- `pnpm verify`：139 files / 1620 tests 全绿（首轮曾有 1 次时序型偶发失败，复跑全绿）。
- `pnpm build`：0。
- 安装包：`temp/installer/moshi-setup-0.1.0.exe`（5.8MB，已重建含 spawn 修复）。
- 修复：`spawn("cmd.exe", ["/d","/s","/c", command])` 会被 Node 再包一层引号，与 `cmd /s` 冲突导致安装器不执行；改 `spawn(command, {shell:true})`，带空格路径的真实 .bat 用例通过。
- 生产 daemon（9836）`GET /api/update?force=1` → `moshi-update/1`、`current=0.1.0`、`ok=false`、`error="GitHub HTTP 403"`；匿名配额为 0，错误按设计折叠。
- 浏览器 `/ui/settings`：「软件更新 / 当前版本：0.1.0 / 检查失败：GitHub HTTP 403 / 检查更新」渲染正确（仅 favicon 404 控制台噪声）。
- Release `v0.1.0` 已发布，资产 `moshi-setup-0.1.0.exe` 已上传（6094395 字节）；真实 authenticated latest payload 经 `statusFromRelease` 解析为 `ok=true`、`latest=0.1.0`、`asset_size=6094395`、`available=false`。

## 遗留

- 仓库仍 private（用户 2026-11-08：待完善后开放），客户机匿名检查暂不可用；开放后复验「发现新版本 → 下载 → 安装重启」全链路。
- 未在真实升级（0.1.0 → 更高版本）上执行覆盖安装，避免扰动生产安装；命令组装由单测覆盖，安装器静默模式在 V-03 已验证。
