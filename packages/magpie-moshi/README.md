# magpie-moshi

moshi（默识）的 **Magpie 网关钩子**。挂在 Magpie 的 LLM 网关上，每轮对话前向本机 moshi daemon
要一段"记忆注入"追加进 system 提示，回复后再把这一轮信号投回去落库。零依赖，只有两个时机：
`onRequest(body, ctx)` / `onResponse(reply, ctx)`。

## 它做什么

| 时机 | 动作 | 超时预算 |
| --- | --- | --- |
| 每次 LLM 请求前 | `POST {daemon}/hook/api/recall` → 把返回的台账文本追加到 system（没有 system 就在最前插一条） | 800ms |
| 每次回复后 | `POST {daemon}/hook/api/signal`（fire-and-forget，不阻塞回复） | 500ms |

任何失败（daemon 没起、超时、没 token、返回空）都**原样放行**，绝不改变请求的
`tools` / `model` / `stream` 等字段（Magpie 会校验这些键）。

## 安装（两步，缺一步都不生效）

> 前提：本机 moshi daemon 已运行（`node dist/app/main.js daemon`，默认 `127.0.0.1:9836`）。

1. **注册插件**：把本包放进 Magpie 能加载的位置并登记到**根**清单
   `%USERPROFILE%\.config\magpie\plugins.json`（形如
   `{"plugins":[{"spec":"<本包的绝对路径>"}]}`）。
   最稳的做法是直接用 Magpie 自己的命令：

   ```powershell
   magpie plugin add "E:\path\to\magpie-moshi"
   magpie plugin list --json   # loaded 里应能看到上面这条 spec
   ```

   注意：Magpie 读的是**根** `plugins.json`；只写 `plugins\plugins.json` 会静默不生效。

2. **打开开关**：让 daemon 允许 Magpie 的注入与落库（等价于设置页里把
   `magpie_enabled` 打开）：

   ```powershell
   curl -X POST http://127.0.0.1:9836/hook/api/config -H "x-moshi-token: <token>" `
        -H "content-type: application/json" -d '{"action":"connect"}'
   ```

   逐请求的 token 从 `<MOSHI_DATA_DIR 或 ~/.moshi>/daemon.lock` 读；也可以用
   `magpie plugin options magpie-moshi '{"daemonUrl":"http://127.0.0.1:9836","token":"..."}'`
   把固定值写进插件配置（daemon 重启会换 token，写死会过期，读锁文件不会）。

## 配置项（`magpie plugin options magpie-moshi '<json>'`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `daemonUrl` | 先读 `MOSHI_DAEMON`，再读 `daemon.lock` 的 `port`，最后 `http://127.0.0.1:9836` | daemon 地址 |
| `token` | 先读 `MOSHI_TOKEN`，再读 `daemon.lock` 的 `token` | `x-moshi-token` 的值 |

## 会话与工程识别

- `ctx.session` 非空 → 直接作为会话标志（`source: magpie`）；
- 为空（例如 DSH 走 pi-ai 不发会话头）→ 用「cwd + 会话开头第一条真实 user 消息」的
  sha256 前 32 位做标志（`source: conversation-opening`）；`Current runtime context…`
  开头的快照会被跳过，避免同一会话中途换号；
- 工程由 daemon 依据 `ctx.cwd`（逐个清洗：去 `(was …)`、去引号/转义/句末点）解析；
  拿不到 cwd 才退化为 global。

注入结果的 `identity_source`：`vcs`（命中仓库 remote）/ `local`（仅本地标记）/
`unknown`（没有工程）。`degraded` 里可能出现：`no_sidecar`（向量通道未就绪）、
`no_vector`（命中都低于相关性地板）、`timeout`、`disabled`、`inject_disabled`、
`empty_query`、`no_evidence`。

## 排查

- 插件有没有被加载：`magpie plugin list --json`（看 `loaded`），或 Magpie 日志
  `%LOCALAPPDATA%\magpie\logs\app.log` 里的 `plugin: host starts`；
- 改完本包（`hook.cjs`）要让它重新加载：重启 Magpie，或结束 `magpie-bun` 进程让宿主自动重拉；
- daemon 侧看效果：`moshi hook status`、`moshi hook trace 5`、`GET /hook/api/trace`；
- 注入不生效时先确认 daemon 在跑、`daemon.lock` 里的端口/token 与上文一致、
  `magpie_enabled` 已打开。

## 开发

源码在 `packages/magpie-moshi/`，构建时由 `tools/copy-assets.mjs` 复制到
`dist/magpie-moshi/`。测试在 `tests/unit/hook-package.test.ts`（直接 require 本包，用假
`fetch` 断言请求形状与降级行为）。
