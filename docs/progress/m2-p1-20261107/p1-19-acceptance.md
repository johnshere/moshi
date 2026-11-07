# P1-19 验收标准（M2）

验收者只读 repo、独立执行；不得修改实施者文件；结论写 PASS/FAIL + 证据。

## AC-1 前置

- P1-20 已 PASS 并被 Lead commit；台账/进度可查。
- 使用与 P1-20 相同的 `temp/moshi-dev.toml` / `data`；不得新建第二个库。

## AC-2 同一数据面

- 记录 dev DB 哈希；与 P1-20 验收记录一致，或差异仅来自“同一 dev 库追加真实会话”。
- 不出现 `~/.moshi` 作为本节点验收库；不出现 P3-A4 合成库。

## AC-3 主题导出

- `selectTopics`/`export --all` 导出 ≥1 篇；导出文件存在、非空、可解析。
- 主题满足：`community_id` 非空、`fact_count ≥ 8`、`chainCompleteness ≥ 0.5 || hasMutex`。
- 若 0 篇：必须给出 `selectTopics=0` 的原因（社区数/最大社区/边数/门槛），不得判 PASS。

## AC-4 eval 门禁

- `eval run --golden v1` 的 temporal/refusal 各 10/10 全过，exit 0。
- 不得用 `--allow-partial`、不得改门禁类型、不得换回旧库 30/40。

## AC-5 bench

- `pnpm bench` 或等价命令成功；P95 < 80ms；记录 P50/P95/P99。
- 若 bench 不可用，记录原因并说明替代读数，由 Lead 决定。

## AC-6 边界

- 未下调 `MIN_FACTS`/未删除 `chain`、`mutex` 过滤；无 DSH；无合成 seed 事实。
- `~/.moshi`、`~/.claude/projects` 前后哈希一致。
- 不提交 `temp/`；不 push。

## AC-7 工程门禁与交付

- `pnpm verify` 全绿；`pnpm build` 0；`git diff --check` 干净。
- `docs/progress/p1-19-m2-progress.md` 已更新。
- 报告 commit 前 diff 范围；实施者不自行 commit；验收者输出 PASS/FAIL 与逐项证据。
