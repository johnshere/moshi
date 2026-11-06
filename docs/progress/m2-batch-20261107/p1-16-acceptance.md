# P1-16 m2 验收标准

> 验收子代理只读/运行命令，不改仓库文件；逐条 `PASS`/`FAIL` + 证据。临时 golden 放 `temp/verify-p1-16/`。
> 工作区 `J:\Workspace\Codes\moshi`。

## AC-1 校验函数单测

```powershell
pnpm exec vitest run tests/unit/eval.test.ts
```

通过条件：

- `validateGoldenSet` 至少覆盖：32 条四类各 8 → ok；temporal=7 → not ok；缺 multi_hop → not ok；未知 type → not ok；
- 原 `loadGolden` 2 条 + 非法行的用例仍通过；
- 原门禁用例仍通过（已加 `--allow-partial`）。

## AC-2 CLI 正例（m2 真实题集）

```powershell
pnpm exec tsx src/app/main.ts eval run --golden v1
```

通过条件：

- stdout 含 `golden 题型：single_hop=10 multi_hop=10 temporal=10 refusal=10`（或等价四类计数）；
- `temporal: 10/10`、`refusal: 10/10`；
- exit code `0`；
- `multi_hop: 0/10` 不导致非 0（P1-16 不要求多跳过）。

## AC-3 CLI 正例（默认 golden.jsonl）

```powershell
pnpm exec tsx src/app/main.ts eval run
```

通过条件：同样四类各 10，exit 0；说明默认路径未被 `--golden v1` 校验逻辑破坏。

## AC-4 CLI 负控（题集不完整）

在 `temp/verify-p1-16/partial.jsonl` 写 8 条 single_hop + 8 条 refusal（可从现有 golden 复制 `g-s01..s08`、`g-r01..r08`），缺 multi_hop/temporal：

```powershell
pnpm exec tsx src/app/main.ts eval run --golden J:/Workspace/Codes/moshi/temp/verify-p1-16/partial.jsonl
```

通过条件：

- exit code `2`（不是 1、不是 0）；
- stderr 明确列出 `multi_hop` 与 `temporal` 不足（至少其中一个）；
- 没有任何查询执行输出/没有写 query_log 的证据（校验在查询前）。

再把同一文件加 `--allow-partial`：

```powershell
pnpm exec tsx src/app/main.ts eval run --golden J:/Workspace/Codes/moshi/temp/verify-p1-16/partial.jsonl --allow-partial
```

通过条件：

- exit code `0`（single/refusal 全过；门禁通过）；
- 输出通过数 16/16（或实际条数）；
- 证明 `--allow-partial` 只跳过完整性校验，不跳过门禁。

## AC-5 门禁仍然只由 temporal/refusal 触发

用 `--allow-partial` + 2 条 golden（1 single 命中 + 1 refusal 失败）应 exit 1；与 `tests/unit/eval.test.ts` 原门禁用例一致。通过条件：exit 1，不是 2。

## AC-6 代码范围

通过条件：

- `git diff` 只涉及 `src/core/ops/eval.ts`、`src/app/cli/commands/eval.ts`、`tests/unit/eval.test.ts`（可含新测试文件）；没有改 `loadGolden` 的跳过非法行逻辑；没有改 `runGoldenSet` 判题；没有改 P1-20 的通过率/多跳口径；
- `git diff` 不含 `~/.moshi` 下任何文件；
- `rg "allow-partial" src` 出现在 usage 与解析处；`validateGoldenSet` 在 CLI 里被调用。

## AC-7 静态与构建

```powershell
pnpm typecheck
pnpm verify
pnpm build
git diff --check
```

通过条件：全 exit 0；`git diff --check` 无输出。

## AC-8 进度文件

实施子代理已写 `docs/progress/p1-16-m2-progress.md`，含：

- 修改文件列表；
- AC-2/AC-3/AC-4 的完整命令与输出（至少 exit code + 四类计数 + 负控错误行）；
- `pnpm verify` / `pnpm build` 结果；
- 未决问题（无则写“无”）。

## AC-9 失败处理

- 任一 `FAIL`：打回实施子代理一次。
- 二次 `FAIL`：报 Lead `FAILED`，终止批次；不要改验收标准。
