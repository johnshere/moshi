# P1-20 验收标准（M2）

验收者只读 repo、独立执行；不得修改实施者文件；结论写 PASS/FAIL + 证据。

## AC-1 `db rebuild-edges`

- `moshi db rebuild-edges --help` 可用；在 dev 配置库上执行成功。
- 首次执行报告 created>0（若图中无边）；第二次执行 created=0，边总数不减少。
- 单测覆盖幂等/只增不删；`pnpm verify` 不回归。

## AC-2 `pnpm dev:reset`

- 从仓库根执行 `pnpm dev:reset`，exit 0；可重复执行两次，第二次仍 exit 0。
- 只写 `<repo>/temp/moshi-dev` 与 `<repo>/temp/moshi-dev.toml`；配置中的 `storage.data_dir` 是绝对路径，且不等于 `~/.moshi`。
- 不生成备份目录；不修改 `~/.moshi`、`~/.claude/projects`。

## AC-3 快照与 golden

- dev 库包含旧库 60 条 fact 的 id（可抽查 `f_01m6b6daaqygpfhek56g2nwe1n` 等）。
- dev golden 目录有 40 条 `golden.v1.jsonl`；四类各 10；`expect_facts` 在 dev 库可解析。
- 旧库与 golden 复制前后的源文件 SHA256 不变。

## AC-4 真实会话导入

- `dev:reset` 通过 `claude-code` 源实例导入 `C:\Users\john\.claude\projects`；dev 库 episode/session 数 > 0，fact 数 > 60。
- 游标写在 dev 数据目录，不写源目录。
- 不出现 DSH 适配器/DSH 路径。

## AC-5 补边与社区

- `db rebuild-edges` 后 edge 总数 > 0；`PRAGMA table_info` 等确认边合法。
- `db community` 后 `community_id` 非空，社区数 > 1。
- 不得手工插入伪造边；边由 `extractEdges` 产生。

## AC-6 P1-20 全过

- 在 dev 配置上执行 `eval run --golden v1`，exit 0。
- 输出四类各 10（至少各 ≥8）；**40/40 全过，multi_hop 10/10**。
- multi_hop 的 `dependency_summary` 非空；不得把 `EVAL_GATE_TYPES` 改成跳过、不得 `--allow-partial` 掩盖、不得换回旧 `~/.moshi` 的 30/40。
- 若 multi_hop 失败：记录失败题 id、缺失边/事实；不得判 PASS。

## AC-7 源只读

- 验收前后对 `C:\Users\john\.moshi` 与 `C:\Users\john\.claude\projects` 做文件数/SHA256 对比，必须一致。
- `~/.moshi` 的 mtime/query_log 不得变化；禁止 `--in-place`。

## AC-8 工程门禁

- `pnpm verify` 全绿；`pnpm build` 0；`git diff --check` 无错误。
- 新增测试覆盖 `db rebuild-edges` 与 `dev:reset` 的关键路径。

## AC-9 文档与边界

- `docs/progress/p1-20-m2-progress.md` 更新：命令、路径、计数、eval 输出、源哈希。
- 无 DSH、无合成 seed 事实、不降 P1-19 门槛。
- 不提交 `temp/`；未 push。

## AC-10 交付

- 报告 commit 前的 diff 范围；实施者不得自行 commit（Lead 统一 commit）。
- 验收者报告 PASS/FAIL、AC 逐项、证据路径。
