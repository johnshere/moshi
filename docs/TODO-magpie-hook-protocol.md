# TODO · Magpie 钩子协议覆盖（moshi）

日期：2026-11-12

## 结论先行（与最初的记忆相反）

- **DSH 走的是 OpenAI Chat Completions（chat），不是 Anthropic。**
  - 证据 1：`D:\Caches\dsh-home\settings.yaml` 第 6 行 `api: openai-completions`，
    baseURL `http://127.0.0.1:8787/bili/http://127.0.0.1:3425/v1`（DSH → bili:8787 → magpie gateway:3425）。
  - 证据 2：`C:\Users\Administrator\.config\magpie\usage.jsonl` 中 `agent:"dsh"` 的行，
    `ep` 全是 `/v1/chat/completions`（provider=deepseek）。
- **Magpie 网关钩子本身不绑定某一家协议**：body 是客户端原始协议 JSON，
  `ctx.protocol ∈ {chat, responses, anthropic, gemini}`（docs/subsystems/gateway-request-hooks.md）。
- **真正缺协议的是本机唯一的钩子 moshi**：`hook.cjs` 只按 `body.messages / role / content`
  处理（chat 形状），没有 `ctx.protocol` 判断，也没有 anthropic 分支。

## 风险

- Claude Code（Anthropic 协议）的请求也出现在 `client-shapes.json`，说明它走过这个网关。
  moshi 的 `injectMail()` 会往 `messages` 里插 `{role:"system"}`——Anthropic Messages API
  不接受 messages 里的 system 角色，注入会非法/被拒。
- `responses`（Codex）body 是 `input` 而非 `messages`，moshi 会静默不注入；`gemini` 同理。

## TODO

- [ ] moshi `hook.cjs` 增加协议守卫：`ctx.protocol !== "chat"` 时直接 `report(skipped)` 返回，
      保证不往非 chat 请求里写 chat 形状的字段。
- [ ] （可选）实现 anthropic 分支：追加到顶层 `system`（字符串或 content block），
      或仅在 daemon 返回 `user-append` 时沿用现有 content-block 追加。
- [ ] 用 Claude Code 走一次网关验证：anthropic 请求下注入不报错、不破坏 body。
- [ ] DSH 回归：chat 下 user-append 正常、`<!-- moshi-hook:begin -->` 不重复注入、前缀缓存不被 system 段打穿。

## 关键文件

- `C:\Users\Administrator\.config\magpie\plugins\node_modules\moshi\hook.cjs`
  （`onRequest` 387-426 行、`injectMail` 323-337 行、`appendToLastUser` 344-364 行）
- `D:\Caches\dsh-home\settings.yaml:1-28`
- `C:\Users\Administrator\.config\magpie\usage.jsonl`（最近行）
- `C:\Users\Administrator\.config\magpie\client-shapes.json`
