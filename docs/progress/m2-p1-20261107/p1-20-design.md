# P1-20 设计：dev 数据面 + 存量补边 + 四类全过

## 目标

在 M2 建一个固定、可重建的 dev 数据面，使 P1-20 的 40 条 golden 四类题全部通过（含 multi_hop），并让 P1-19 后续能在同一库导出主题。

## 非目标

- 不写 DSH 适配器，不读 `C:\Users\john\.dsh\sessions`。
- 不用 P3-A4 合成 seed 库作为 P1 证据。
- 不改 `~/.moshi` 的生产数据；不把旧库“迁移”成第二套长期库。
- 不为 P1-19 降 `MIN_FACTS`/删 `chain` 过滤。

## 输入

- 旧库：`C:\Users\john\.moshi\moshi.db`（只读；WAL 安全复制）。
- golden：`C:\Users\john\.moshi\golden\golden.jsonl` 与 `golden.v1.jsonl`（40 条）。
- 真实会话源：`C:\Users\john\.claude\projects`（`claude-code` 适配器；本机 jianmu 3 个 jsonl；只读）。
- 配置能力：P3-A8 的 `--config`/`MOSHI_CONFIG`、`storage.data_dir`、`eval.golden_set`、`[[ingest.sources]]`。

## 输出

- `<repo>/temp/moshi-dev.toml`（生成物，不提交）
- `<repo>/temp/moshi-dev/data/`（dev 库）
- `<repo>/temp/moshi-dev/golden/`（40 条 golden）
- 新命令 `moshi db rebuild-edges`（存量事实补 `extractEdges`，幂等、可报告）
- 新脚本 `pnpm dev:reset`（`tools/dev-db.ts`）
- `docs/progress/p1-20-m2-progress.md`（实施者更新）

## 实现要点

1. `db rebuild-edges`
   - 打开配置库；取全部 fact；调用 `extractEdges(db,{facts})`；报告 created/skipped；重复执行第二次 created=0（幂等）。
   - 只增边，不删既有边；不修改 fact。
2. `tools/dev-db.ts` / `pnpm dev:reset`
   - 固定 root=`<repo>/temp/moshi-dev`；如果存在则清空 data/golden，保留/重写配置。
   - 用 `better-sqlite3` 的 backup 或 `VACUUM INTO` 从 `~/.moshi/moshi.db` 生成一致副本；复制 `golden.jsonl`/`golden.v1.jsonl`。
   - 写 `temp/moshi-dev.toml`：`storage.data_dir` 绝对路径；`eval.golden_set` 指向 dev golden；`[[ingest.sources]]` 一个 `claude-code` 实例，root=`C:\Users\john\.claude\projects`，id 固定。
   - 用配置跑 `import`（游标在 dev 数据目录，不写源）；再跑 `db rebuild-edges`、`db community`。
   - 最后跑 `eval run --golden v1`，把输出写入进度文件；exit code 透传。
   - 幂等：重复执行从同一源重建；不备份；不碰 `~/.moshi`/`~/.claude/projects`。
3. 测试
   - 单测：`rebuild-edges` 幂等；`dev:reset` 生成的配置路径为绝对路径、不指向 `~/.moshi`；源目录不被写。
   - 集成/冒烟：`pnpm dev:reset` 后 eval 四类各 10 且全过，exit 0。
4. 若 multi_hop 失败
   - 先检查 golden 的多跳事实对在 dev 图中是否有活跃 `depends_on`；补真实边或按真实图改写多跳题。
   - 不修改 `EVAL_GATE_TYPES`、不跳过 `dependency_summary`、不放行 0/10。

## 约束

- 源目录前后哈希不变。
- 不提交 `temp/` 下任何数据/配置。
- 不新增依赖（优先 Node 内置/现有库）。
- 提交前 `pnpm verify`、`pnpm build`、`git diff --check` 全过。

## 完成定义

- `pnpm dev:reset` 在 M2 可重复执行，退出 0。
- dev 库 golden 40 条；`eval run --golden v1` 四类各 10、40/40、exit 0。
- 进度文件记录配置路径、DB/golden 哈希、eval 读数、源目录未变证据。
