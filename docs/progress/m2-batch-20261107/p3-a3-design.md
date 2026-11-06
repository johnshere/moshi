# P3-A3 m2 设计：无代码复核（M2 机器证据）

> 本任务**不改代码**，只复核 M2 的 P3-A3 机器证据并写进度文件。工作区 `J:\Workspace\Codes\moshi`。
> 完成后写 `docs/progress/p3-a3-m2-progress.md`；不改台账/总进度/验收文档；不 commit（Lead 提交）。

## 1. 背景

- B-7（sidecar venv `python.exe` 继承 `Low` 完整性、写不进 `~/.moshi`）是 **M1** 的 `E:\Workspace` 根 ACL 条件；M2 仓库在 `J:\Workspace\Codes\moshi`，`setup-env --check` 合格，已重编码 60/60、sidecar ready 8.47s、`eval --vector` 拒答 10/10，M2 未复现 B-7。
- I-55（运行时写探测/原因码/selftest/锁文件/sidecar 测试）是**机器无关硬化**，但源于 M1 的低完整性条件；已于 D-150 标注为 M1 侧/P3-A7，不阻塞 M2 的 P3-A3 收口。
- 本任务只做 M2 本机复核；不跑 `icacls /setintegritylevel L` 低完整性 fixture（那是 M1 条件回归）。

## 2. 复核步骤

1. `node scripts/setup-env.mjs --check`：确认 venv 合格、依赖 hash、模型权重；记录 exit code 与关键输出。
2. `pnpm exec tsx src/app/main.ts eval run --golden v1 --vector`：走真实 sidecar 编码 60 条，记录编码数、四类计数、`temporal`/`refusal` 通过数、exit code。
3. `pnpm exec vitest run tests/integration/sidecar.test.ts`：确认整组未 skip，3 条集成用例通过（或记录实际 skip 原因；若 skip 则 FAIL）。
4. 只读确认 `~/.moshi/moshi.db` 的 `fact` 数仍 60、`fact_vec` 可查（sidecar 路径）；不修改库。
5. 写 `docs/progress/p3-a3-m2-progress.md`：命令、输出、exit code、结论。

## 3. 验收口径

- 不需要重编码之外的代码改动；`git diff` 只允许 `docs/progress/p3-a3-m2-progress.md`。
- 不要求 `pnpm verify`/`build`（无代码改动）；但需 `git diff --check` 干净。
- 证据必须来自 M2 本机；不得引用 M1 读数代替。
- 若 `setup-env --check` 非 0 或 `eval --vector` 门禁失败，按 FAIL 处理，不自行改代码；报 Lead 决定。

## 4. 风险

- `eval --vector` 会启动 sidecar；若已有 daemon 占用同名管道，测试/CLI 可能冲突，先确认无残留或按现有管道隔离逻辑处理。
- 不要用 `--in-place`；保持默认临时副本，避免污染 `query_log`。
- 不要把 `fact_vec` 的 `no such module: vec0` 当成失败：查询 SQL 需加载 vec 扩展；以 `eval --vector` 的编码计数为准。
