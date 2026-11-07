# P3-10 熔断 · 进度

状态：DONE（2026-11-07，独立验收 AC-1..AC-7 + 修复复验 D1..D5 PASS）

## 范围

详设 §7.7。三个触发 → 降档 + 告警 + 不自动恢复：

| 触发 | 判定 | 动作 |
| --- | --- | --- |
| 延迟 | 3 分钟窗口 P95 > 80ms 且持续 3 分钟 | `on → shadow` |
| 塌缩 | 连续 100 次打分的平均 δ 标准差 < 0.01 | `on → shadow` |
| 崩溃 | sidecar 一小时重启额度用尽（`state='failed'`） | `on → off` |
| 人工 | 手改 `model.gat_mode` 后重启 | 按配置重新评估 |

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/core/read/breaker.ts`（新） | `Breaker`：`recordScore(scores, latencyMs)` 判塌缩/延迟，`recordSidecarFailure()` 判崩溃，`mode(configured)` 取较低者，`reset()` 人工恢复，`onTrip` 告警出口；阈值常量 80ms / 3min / 100 次 / 0.01 / 最少 20 个延迟样本 |
| `src/app/mcp/deps.ts` | `McpDeps.breaker` 注入位；`scoreWithBreaker(score, breaker, sidecarFailed?)`：成功打分喂 δ 与耗时，降级且 sidecar 判失败时补崩溃信号 |
| `src/app/mcp/query.ts` | `gatMode` 改取 `breaker.mode(cfg.model.gat_mode)`（不注入 = 按配置） |
| `src/app/http/server.ts` | `HttpDeps.breaker` → MCP deps；打分外包 `scoreWithBreaker`，`sidecarFailed = status().state === 'failed'` |
| `src/app/main.ts` | 进程内单例 `Breaker({onTrip})`，告警写日志 `gat.breaker`（§11.1 必记事件）；注入 `buildHttpApp` |
| `tests/unit/breaker.test.ts`（新） | 13 条：塌缩（100 次同分 / 有起伏不触发）、人工恢复、延迟（持续 3 分钟才触发 / 门槛以下不触发 / 样本不足不触发）、崩溃（on→off）、`scoreWithBreaker` 接线 3 条；修复补 4 条（窗口边界 / 重新计时 / 降级喂延迟 / query 生效档位） |

## 决策

- **每次打分取平均 δ 作为塌缩样本**，「连续 100 次」= 100 次打分而不是 100 个节点；一次查询内的节点间方差不是塌缩要抓的信号。
- **延迟用「3 分钟窗口 P95 持续 3 分钟」**，并要求窗口内至少 20 个样本：只有一两次慢请求不触发，避免冷启动/单次 IO 抖动误熔断（阈值属实现口径，详设只给 80ms/3 分钟）。
- **崩溃计数不另起一套**：`SidecarClient` 已有 1 小时重启计数与 `max_restarts_per_hour`，熔断只接「已判 failed」这个信号，避免两套计数器漂移。
- **状态只存进程内**：人工恢复 = 手改 TOML（`model.gat_mode` 不在 `PUT /api/config` 白名单）后重启，重启即重新评估；不落库，避免留下没有命令行入口能清除的永久熔断状态。
- **熔断只降档不改配置**：`mode()` 返回较低者，配置档案本身不动，与 P3-09 的门禁口径一致。

## 验收

- AC-1 连续 100 次同分 → 自动回 `shadow`；熔断后 `mode('on')` 恒为 `shadow`，只有 `reset()` 恢复；不重复告警；
- AC-2 分数有起伏不触发塌缩；
- AC-3 延迟：P95 > 80ms 持续 3 分钟才触发，门槛以下/样本不足不触发；
- AC-4 崩溃：sidecar 判失败 → `off`（`mode('on')`/`mode('shadow')` 均为 `off`）；
- AC-5 `scoreWithBreaker` 真实接线：成功打分喂熔断、降级喂延迟但不喂 δ、sidecar 失败补崩溃、结果原样透传；
- AC-6 query 生效档位取较低者（不注入 breaker 时行为不变）；
- AC-7 `pnpm verify` / `pnpm build` 全绿。

## 读数

| 命令 | 结果 |
| --- | --- |
| `vitest run tests/unit/breaker.test.ts` | 13 passed |
| `pnpm verify` | 127 files / 1540 passed（修复后） |
| `pnpm build` | exit 0 |

## 验收后修复（2026-11-07）

- **D1 日志事件名**：告警事件由 `model.breaker` 改为 §11.1 规定的必记事件 `gat.breaker`（详设同步）。
- **D2 延迟信号遗漏**：`scoreWithBreaker` 只在 `scores !== null` 时喂延迟，持续超时（`score_timeout_ms`）永远不会触发延迟熔断。改为一律 `recordScore(scores ?? [], latencyMs)`——超时也是一次 `/score` 尝试。补单测。
- **D3 窗口边界**：`< cutoff` 改为 `<= cutoff`，恰好 3 分钟前的样本必须过期。补边界单测。
- **D4 文档冲突**：§7.7 表格「人工」行原写 `moshi config set`（命令不存在）且「立即生效」，与实现口径矛盾；改为「手改 TOML 后重启 daemon」。
- **D5 覆盖缺口**：补 hotSince 回落后重新计时、query 生效档位（配置 on + 熔断 off → 查询快照记 off、配置不变）两组单测。
- **D6（不修）**：P95 每次打分对 3 分钟窗口 `map+sort`；个人库 QPS 下可接受，窗口按时间裁剪不设条数上限，留待有压测需求时再优化。
