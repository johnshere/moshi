# P1-19 设计：同一 dev 库导出主题

## 前置

- P1-20 已通过独立验收并被 Lead commit（P1-20 的 `DONE.m2` 记录先落台账）。
- 使用同一份 `temp/moshi-dev.toml` / `temp/moshi-dev/data`；不得新建第二个 dev 库，不得换回 `~/.moshi`。

## 目标

在 P1-20 的 dev 数据面上，`selectTopics`/`export --all` 导出 ≥1 篇主题文档，并满足 P1-19 的 eval/bench 门禁。

## 步骤

1. 读取 dev 配置；确认 DB 与 P1-20 验收时一致（记录哈希）。
2. 执行 `moshi eval run --golden v1`，确认 temporal/refusal 全过（≥8/类，10/10）。
3. 执行 `moshi bench` 或等价基准，记录 P50/P95/P99；要求 P95 < 80ms。
4. 执行 `selectTopics`/`export --all`：
   - 至少导出 1 篇；
   - 主题满足现有门槛：`community_id` 非空、`fact_count ≥ 8`、`chainCompleteness ≥ 0.5 || hasMutex`。
5. 若导出 0：
   - 允许把更多真实 Claude Code 会话导入**同一个 dev 库**，补边/社区后重跑；
   - 不允许下调 `MIN_FACTS`、不允许删除/放宽 `chainCompleteness || hasMutex`；
   - 补数据后仍 0，记 BLOCKED，列出社区规模/边数/selectTopics 原因，不伪造通过。
6. 记录导出文件路径、大小、主题名、fact_count、community_id、chain/mutex、eval 读数、bench P95。

## 输出

- `docs/progress/p1-19-m2-progress.md`（实施者更新）
- 验收证据（export 文件、命令输出、库哈希）
- 待 Lead commit 的改动（如有）

## 约束

- 不改 `EVAL_GATE_TYPES`、不降主题门槛、不换库、不新增 DSH。
- 源目录只读；不提交 `temp/`；不 push。
