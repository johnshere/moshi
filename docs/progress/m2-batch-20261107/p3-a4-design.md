# P3-A4 m2 设计：dev 配置下的合成数据面

> 依赖 P3-A8 已完成并验收通过。实施子代理读本文件 + `p3-a4-acceptance.md`。
> 工作区 `J:\Workspace\Codes\moshi`。本任务主要是运行/取证；如 seed 在 P3-A8 后仍有路径硬编码，允许小修 `tools/seed-devdb.ts`，但不得回退 P3-A8 的配置语义。
> 完成后写 `docs/progress/p3-a4-m2-progress.md`；不改台账/总进度/验收文档；不 commit（Lead 提交）。

## 1. 背景

- P3-A4 的 m1 已 DONE（fact=478/edge=1710/adjudication=178/feedback=72/query_log=152，doctor I1–I10 全绿 exit 4，eval 32/32）。
- m2 上一轮没有 `~/.moshi` 合成库；P3-A8 之后可以走统一配置：默认不配置仍 `~/.moshi`，dev 配置显式指到 `temp/`。本任务用 **dev 配置**，不碰真实 `~/.moshi` 与真实 `~/.claude/projects`。
- P3-A4 是“开发数据面”，不是 P1-16/P1-19/P1-20 的真实库；所有结论标「合成数据面」。

## 2. 配置

在 `temp/m2-p3a4/moshi.toml`（`temp/` 已 gitignore）写：

```toml
[storage]
data_dir = "J:/Workspace/Codes/moshi/temp/m2-p3a4/data"

[eval]
golden_set = "J:/Workspace/Codes/moshi/temp/m2-p3a4/data/golden/golden.jsonl"

[[ingest.sources]]
id = "p3a4-seed"
adapter = "claude-code"
root = "J:/Workspace/Codes/moshi/temp/m2-p3a4/projects"
```

- 不配置真实 `~/.moshi`，不配置真实 `~/.claude/projects`。
- seed 会写 `<data_dir>/golden/golden.v1.jsonl`（P3-A8 的 `goldenDir`）。

## 3. 步骤

1. 记录基线：
   - `C:\Users\john\.moshi\moshi.db` 的 SHA256/mtime（若存在）；
   - `C:\Users\john\.claude\projects` 下 `*.jsonl` 文件数 + 总字节；
   - `J:\Workspace\Codes\moshi\temp\m2-p3a4` 若存在先清空（只清该 dev 目录）。
2. 全量 seed：
   ```powershell
   pnpm exec tsx tools/seed-devdb.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml
   ```
3. 只读统计 dev DB（用 better-sqlite3 或 `moshi db` 等价查询）：
   - `fact`、`edge`、`episode`、`annotation`、`adjudication`、`feedback`、`query_log` 计数；
   - `adjudication` 按 `type` 分组（记录是否有 `mutex_win`；没有则记 I-51，不阻断）。
4. doctor：
   ```powershell
   pnpm exec tsx src/app/main.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml doctor
   ```
   记录 I1–I8/I9/I10、exit code（预期 4=向量降级；0 也可）。
5. eval：
   ```powershell
   pnpm exec tsx src/app/main.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml eval run --golden v1
   ```
   记录四类计数与通过数（seed 基线 32/32）。
6. 复检基线：真实 `~/.moshi` 的 SHA256/mtime、真实 `~/.claude/projects` 的 jsonl 数/字节数不变。
7. 写进度文件，列出所有计数/命令/exit code/合成数据面标注。

## 4. 验收口径（摘要）

- `fact/edge/annotation/adjudication/feedback/query_log > 0`；`episode > 0`；
- doctor I1–I10 全绿（exit 0 或 4）；
- eval 四类各 8、temporal/refusal 全过、exit 0；
- 真实 `~/.moshi` 与真实 `~/.claude/projects` 未被修改；
- 只有 dev 目录产生数据；`git diff` 只允许 progress 文件（若小修 seed，允许 `tools/seed-devdb.ts` + 测试，并在进度说明理由）；
- 结论标注「合成数据面」，不得写成 P1-16/P1-20 的真实证据。

## 5. 风险

- `assertOwnedDb` 会拒绝“dev 库已有非本工具 episode”；如果 `temp/m2-p3a4` 是旧的，先确认/清空，不要清真实库。
- `doctor` 无 sidecar 时 exit 4 属预期；不要把 4 当失败。
- `adjudication` 可能只有 `temporal_invalidate`、没有 `mutex_win`（I-51）；按 m1 P3-A4 历史口径，`adjudication>0` 即可，但必须在进度中如实写类型。
- 不要用 `--home`；不要改 `~/.moshi`；不要 push。
