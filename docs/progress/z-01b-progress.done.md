# Z-01B MCP 结构化反馈提醒

状态：DONE（2026-11-08，m2）

## 目标

- `memory_query` 有证据时返回人类可读 `feedback_hint`；无证据不返回。
- server `instructions` + `moshi://protocol/feedback-v1` resource 给出同一格式。
- 标准 MCP，不写 Magpie 专用代码。
- 完成后把 moshi MCP 装入 Claude Code。

## 实施清单

- [x] `query.ts`：`FEEDBACK_HINT`、`feedbackHintFor()`、`EvidencePackJson.feedback_hint?`
- [x] `tools.ts`：text 分支有证据时带 `query_id` 与反馈提醒
- [x] `server.ts`：instructions 增加反馈段说明 + `feedback-v1` resource
- [x] 单测：有证据/无证据、json/text 两路
- [x] 详设 §4.1.1 / §4.2
- [x] `pnpm verify`：129 files / 1574 passed（2 skipped）
- [x] `pnpm build`：通过
- [x] 启动 daemon 并装入 Claude Code：`claude mcp list` 显示 moshi ✔ Connected
- [x] 真实调用：`claude -p` 调 `memory_query("node version")` → status ok、1 条证据；`query_log` 新增 `q_01m6wgjzky1mkkgzjwafgt5eak`
- [x] 台账 §1/§3/§6 收口

## 验收证据

- 有证据的 MCP 返回含 `feedback_hint`（`【记忆反馈】` + `[M1]`）；
- 无证据查询 `zzzz-no-such-fact-xyz` 的返回体 grep `feedback_hint` = 0；
- text 分支有证据时含 `query_id: q_...` 与反馈提醒；
- 工具 description 未改，`lint:desc` 继续通过。

## 格式

```text
【记忆反馈】
[M1] 采纳：user's own words
```

映射：`[M#]` ↔ `m_id`；采纳/否定/修正 ↔ adopt/reject/correct；冒号后原话 ↔ note。

## 边界

- 这是提醒，不强制；MCP 协议不约束模型响应。
- 工具 description 保持非祈使（`lint:desc`）。
- 适配器事后解析与 feedback 落库不在本任务。

## 后续（2026-11-08）：固定端口 9836 + 设置页端口可编辑

- 默认端口 `53000` → `9836`；daemon 不再顺延端口，被占用时报 `E_CONFIG` / `port_in_use`，由用户在设置页改端口后重启。
- 设置页 `http.port` 从只读改为可编辑（1024–49151 校验），保存后提示重启与新的 MCP 地址。
- 旧 `port_scan_max` 键保留解析但不再使用（旧配置兼容）。
- 验收：`pnpm verify` 130 files / 1577 passed；`pnpm build` 通过；真实 daemon 在 9836 监听；`claude mcp list` ✔ Connected；Claude 实际调用 `memory_query("node version")` 返回 `[M1] node 版本 = 22.22.2`，query_log 新增 `q_01m6wj6bezgpm6qx9ajfar5z60`；无头浏览器渲染 `/ui/settings`，端口输入框 `value=9836`、`min=1024`、`max=49151` 且非只读。
