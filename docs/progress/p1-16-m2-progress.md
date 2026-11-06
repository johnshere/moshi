# P1-16 m2 进度（实施子代理维护）

- 状态：DONE（独立验收 PASS，Lead 已 commit）
- 设计：`docs/progress/m2-batch-20261107/p1-16-design.md`
- 验收：`docs/progress/m2-batch-20261107/p1-16-acceptance.md`

## 实施记录

- 改 `src/core/ops/eval.ts`：新增 `GOLDEN_TYPES`、`MIN_GOLDEN_PER_TYPE=8`、`GoldenValidation`、`validateGoldenSet(items)`（四类计数 + 每类 <8 报警 + 未知题型报警；不抛异常）。`loadGolden`、`runGoldenSet` 未动。
- 改 `src/app/cli/commands/eval.ts`：新增 `--allow-partial`（仅跳过完整性校验）；`loadGolden` 与完整性校验整体前移到 `ensureDataDirs`/开库之前（题集不完整时不写 query_log），不完整 → stderr 逐条列出 → exit 2；校验通过 → stdout 打印 `golden 题型：…`；usage 文案补 `--allow-partial`。门禁（temporal/refusal 失败 → exit 1）未动。
- 改 `tests/unit/eval.test.ts`：
  - 新增 `validateGoldenSet` 4 例：四类各 8 → ok/counts；temporal=7 → not ok；缺 multi_hop → not ok；未知 type → problems 含「未知题型」。
  - 原门禁用例、临时副本用例的 4 次 `runCli(['eval','run',...])` 加 `--allow-partial`（题集只有 1–2 条，否则被完整性校验拦下）。
  - 新增 CLI 负控/正例：8 single_hop + 8 refusal 的题集 → 不带 `--allow-partial` exit 2 且 stderr 列 multi_hop/temporal、无评估输出、用户库 query_log 不变；带 `--allow-partial` → 16/16、exit 0、无 `golden 题型` 行。
- 未改：台账/总进度/设计/验收文档、`loadGolden` 跳过非法行行为、`runGoldenSet` 判题、P1-20 多跳口径、`~/.moshi` 下任何文件（golden 只读复制）。

## 证据

### 基线（改动前）

`pnpm exec vitest run tests/unit/eval.test.ts` → Test Files 1 passed，Tests 5 passed，exit 0。

### 目标单测（改动后）

```powershell
pnpm exec vitest run tests/unit/eval.test.ts
```

→ Test Files 1 passed，**Tests 10 passed**，exit 0。

### AC-1 静态

```powershell
pnpm typecheck
```

→ exit 0（无输出错误）。

### AC-2 m2 重跑（golden v1）

```powershell
pnpm exec tsx src/app/main.ts eval run --golden v1
```

```
golden 题型：single_hop=10 multi_hop=10 temporal=10 refusal=10
golden 评估（C:\Users\john\.moshi\golden\golden.v1.jsonl；数据面 临时副本；向量路 关）：30/40 通过（跳过 0 行非法）
single_hop: 10/10  multi_hop: 0/10  temporal: 10/10  refusal: 10/10
  FAIL g-m01 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m02 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m03 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m04 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m05 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m06 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m07 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m08 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m09 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m10 [multi_hop] recall@K=1.00；依赖链 0 条
EXIT=0
```

四类各 10；temporal 10/10、refusal 10/10；multi_hop 0/10 不阻断；exit 0。

### AC-3 默认 golden.jsonl

```powershell
pnpm exec tsx src/app/main.ts eval run
```

```
golden 题型：single_hop=10 multi_hop=10 temporal=10 refusal=10
golden 评估（C:\Users\john\.moshi\golden\golden.jsonl；数据面 临时副本；向量路 关）：30/40 通过（跳过 0 行非法）
single_hop: 10/10  multi_hop: 0/10  temporal: 10/10  refusal: 10/10
  FAIL g-m01 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m02 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m03 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m04 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m05 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m06 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m07 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m08 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m09 [multi_hop] recall@K=1.00；依赖链 0 条
  FAIL g-m10 [multi_hop] recall@K=1.00；依赖链 0 条
EXIT=0
```

### AC-4 负控（多跳/时态整类缺失）

`temp/verify-p1-16/partial.jsonl` = 现有 golden 的 `g-s01..s08`（8 single_hop）+ `g-r01..r08`（8 refusal）。

```powershell
pnpm exec tsx src/app/main.ts eval run --golden J:/Workspace/Codes/moshi/temp/verify-p1-16/partial.jsonl
```

```
golden set 不完整：J:/Workspace/Codes/moshi/temp/verify-p1-16/partial.jsonl
  - multi_hop 只有 0 条（要求 ≥8）
  - temporal 只有 0 条（要求 ≥8）
EXIT=2
```

无任何评估/查询输出；真实库 query_log 运行前后均为 174 行（校验在开库前，没写 query_log）。

```powershell
pnpm exec tsx src/app/main.ts eval run --golden J:/Workspace/Codes/moshi/temp/verify-p1-16/partial.jsonl --allow-partial
```

```
golden 评估（J:/Workspace/Codes/moshi/temp/verify-p1-16/partial.jsonl；数据面 临时副本；向量路 关）：16/16 通过（跳过 0 行非法）
single_hop: 8/8  multi_hop: 0/0  temporal: 0/0  refusal: 8/8
EXIT=0
```

### AC-5 门禁仍只由 temporal/refusal 触发

`temp/verify-p1-16/gate.jsonl` = 1 条会命中的 single_hop（g-s01）+ 1 条用同一 query 的 refusal（应失败）：

```powershell
pnpm exec tsx src/app/main.ts eval run --golden J:/Workspace/Codes/moshi/temp/verify-p1-16/gate.jsonl --allow-partial
```

```
golden 评估（J:/Workspace/Codes/moshi/temp/verify-p1-16/gate.jsonl；数据面 临时副本；向量路 关）：1/2 通过（跳过 0 行非法）
single_hop: 1/1  multi_hop: 0/0  temporal: 0/0  refusal: 0/1
  FAIL g_gate_refusal [refusal] confidence_summary=high；evidence=2
EXIT=1
```

### AC-7 全量验证与构建

```powershell
pnpm verify
pnpm build
git diff --check
```

- `pnpm verify`：**Test Files 115 passed | 1 skipped (116)，Tests 1401 passed | 2 skipped (1403)**，exit 0。
- `pnpm build`：tsc + vite build 成功（copied ui assets），exit 0。
- `git diff --check`：无输出，exit 0。

### 代码范围

`git diff --stat`：

```
 src/app/cli/commands/eval.ts |  31 +++++++--
 src/core/ops/eval.ts         |  44 ++++++++++++
 tests/unit/eval.test.ts      | 104 ++++++++++++++++++++++++++--
```

另有 `docs/progress/m2-batch-20261107-progress.md` 的修改在开工前（01:47 基线 `git status`）就已存在，非本子代理改动、未触碰。

## 独立验收（verify-p1-16，2026-11-07 01:58）

- 结论：**PASS，AC-1..AC-9 全过**；未改仓库文件。
- AC-1：`tests/unit/eval.test.ts` 10 passed；含 4 个 validate 用例 + 原 loadGolden + 原门禁。
- AC-2/3：`--golden v1` 与默认 golden 均四类各 10、temporal/refusal 10/10、multi 0/10 不阻断、exit 0。
- AC-4：自建 16 条 partial → exit 2、stderr 列 multi_hop/temporal、stdout 空、真实 query_log 174→174；`--allow-partial` → 16/16、exit 0。
- AC-5：1 命中 single + 1 refusal 失败 + `--allow-partial` → exit 1（非 2）。
- AC-6：源码 diff 仅 3 个允许文件；`loadGolden` 逻辑未动、`runGoldenSet` 零改动；`allow-partial`/`validateGoldenSet` 接线到位。
- AC-7：typecheck 0、verify 1401 passed/2 skipped、build 0、`git diff --check` 0。
- AC-8：进度文件内容齐全；瑕疵已由 Lead 修正 verify 计数口径。

## 未决/风险

- 无阻塞。两点提示：
  1. `--allow-partial` 只跳过四类完整性校验，不跳过 temporal/refusal 门禁（AC-5 已证）。
  2. 完整性校验只查题型数量，不查 `expect_facts` 是否存在于库（属 P1-20 口径，未越界）。
