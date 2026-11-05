# P3-A4 本机开发库（合成数据面）

状态：DONE（2026-11-05 15:00 → 19:25）

## 交付

- `tools/seed-devdb.ts`（`pnpm seed:devdb`）：确定性生成 75 个合成会话，写到 `~/.claude/projects/p3-a4-devdb`；之后经 `runCli` 依次跑 import 和派生命令，再经 `callTool` 调 `memory_query` / `memory_feedback`，最后出 golden v1。对 moshi.db 不写任何 SQL；库里有外来数据时抛 ForeignDataError，拒绝执行。
- `tests/unit/seed-devdb.test.ts`：8 例（同种子同输出、换种子输出变化、时间跨度、护栏等）。
- `package.json`：新增一行脚本。

## 验收

- 执行：deepseek-flash（用户指定）。首轮因 doctor 有 3 处 src/ 缺陷而 blocked，由 P3-A5 / P3-A6 修复。
- 独立验收：volcengine/kimi-k3.1-pro，与执行者异家族，S1–S10 全过。claude 验收者两次中途失败、未出结论，不计入 n。路由记录见 `.dsh/temp/p3-a4/p3-a4-routing.log`。
- 数据：fact 478 / edge 1710 / adjudication 178（outcome 0，见 I-49）/ query_log 152 / feedback 72；doctor I1–I10 全绿，exit 4（向量降级）；eval 32/32；verify 1364 passed。
- 主进程终审：看过 diff（package.json +1 行；工具只走 runCli / callTool）；seed-devdb 单测 8/8。

## 局限

- 合成数据面，不得作为 P3-12 真实验收的证据。
- 只有 `temporal_invalidate` 裁决，没有 `mutex_win`（I-51）；outcome 无写入方（I-49）。
