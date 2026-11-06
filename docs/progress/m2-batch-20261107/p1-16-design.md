# P1-16 m2 设计：golden 四类完整性断言 + 负控

> 实施子代理读本文件 + `p1-16-acceptance.md`。工作区 `J:\Workspace\Codes\moshi`。
> 只改 `src/core/ops/eval.ts`、`src/app/cli/commands/eval.ts`、`tests/unit/eval.test.ts`（必要时加新测试）；不改台账/总进度/验收文档。
> 完成后写 `docs/progress/p1-16-m2-progress.md` 并报告 Lead。

## 1. 现状与缺口

- `loadGolden`（`src/core/ops/eval.ts:52-71`）只跳过非法 JSON 行，不检查题型数量。
- `EVAL_GATE_TYPES` 只有 `temporal` / `refusal`；没有“四类齐全、每类 ≥8”的断言。
- m2 实际 `~/.moshi/golden/golden.jsonl` 与 `golden.v1.jsonl` 都是 40 条、四类各 10；数据面已满足，但运行器不会在题集退化成 2 条时报警。
- 现有单测故意用 2 条/1 条 golden（`tests/unit/eval.test.ts:85-120`），所以断言不能塞进 `loadGolden`，否则这些测试会被打断。

## 2. 设计

### 2.1 校验函数（core）

在 `src/core/ops/eval.ts` 增加：

```ts
export const GOLDEN_TYPES = ['single_hop', 'multi_hop', 'temporal', 'refusal'] as const;
export const MIN_GOLDEN_PER_TYPE = 8;

export interface GoldenValidation {
  ok: boolean;
  counts: Record<GoldenType, number>;
  problems: string[];       // 人类可读，逐条
}

export function validateGoldenSet(items: readonly GoldenItem[]): GoldenValidation;
```

规则：

- 统计四类各多少；未知 `type` 计入 `problems`（`未知题型 X`）。
- 每类 `< MIN_GOLDEN_PER_TYPE` → `problems.push('single_hop 只有 7 条（要求 ≥8）')`。
- 类型齐全但条目为 0 也报；`problems` 为空才 `ok=true`。
- 不修改 `loadGolden`；不抛异常（让 CLI 决定退出码）。

### 2.2 CLI 接线

`src/app/cli/commands/eval.ts`：

- 增加参数 `--allow-partial`（仅测试/局部 golden 用）。
- `loadGolden` 后：
  - 若 `items.length === 0` 保持现有“空集”错误（exit 2）。
  - 若未传 `--allow-partial`：调用 `validateGoldenSet(items)`；`!ok` 时向 stderr 打印：
    ```
    golden set 不完整：<file>
      - multi_hop 只有 0 条（要求 ≥8）
      - ...
    ```
    并 `return 2`。**在开库/查询前失败**，不写 query_log。
  - `ok` 时 stdout 增加一行：
    ```
    golden 题型：single_hop=10 multi_hop=10 temporal=10 refusal=10
    ```
- `--allow-partial` 时跳过校验，仍跑原有门禁（temporal/refusal 失败 exit 1）。usage 文案加该参数。
- 退出码约定：题集不完整 = `2`；门禁失败 = `1`；正常 = `0`（与现有区分一致）。

### 2.3 单测

`tests/unit/eval.test.ts`：

1. `loadGolden` 原用例保留（2 条 + 1 非法行）。
2. 新增 `validateGoldenSet`：
   - 32 条（四类各 8）→ `ok=true`，counts 正确；
   - 31 条且 `temporal=7` → `ok=false`，problems 含 `temporal`；
   - 缺 `multi_hop` → problems 含 `multi_hop`；
   - 未知 `type: 'foo'` → problems 含“未知题型”。
3. 门禁用例（8-120 行）的两次 `runCli(['eval','run'], ...)` 加 `--allow-partial`，保持原断言（否则 2 条 golden 会被完整性校验拦下）。
4. 新增 CLI 负控：
   - 临时 home + 临时 golden（8 条 single_hop + 8 条 refusal，缺 multi/temporal）：
     - 不带 `--allow-partial` → `code=2`，stderr 含 `multi_hop`；
     - 带 `--allow-partial` → `code=0`（single/refusal 都过）。
   - 说明：负控在查询前失败，所以不需要为缺失类型准备事实；`--allow-partial` 的正例需要事实，复用现有 `addFact('f_8080')` 和 refusal 题。
5. 保持 `eval-api.test.ts` 不动；`runCli` 选项若不受影响则不传。

### 2.4 m2 重跑

实施完成后在 **M2 本机** 跑：

```powershell
pnpm exec tsx src/app/main.ts eval run --golden v1
```

期望：四类各 10、`temporal`/`refusal` 10/10、exit 0；multi_hop 0/10 不阻断（P1-16 只要求题型完整 + 门禁）。把完整输出写进 `docs/progress/p1-16-m2-progress.md`。

## 3. 范围

- 不改 `loadGolden` 的跳过非法行行为。
- 不改 `runGoldenSet` 的判题口径。
- 不改 P1-20 的通过率口径（多跳红仍按 D-47/B-1 记录）。
- 不动 `~/.moshi/golden/golden.jsonl` / `golden.v1.jsonl` 内容（只读）。
- 不改台账状态；Lead 在验收通过后写 `WIP.m1，DONE.m2`。
- 不 commit；Lead 提交。

## 4. 风险

- 现有测试用 1–2 条 golden，必须加 `--allow-partial`，否则 verify 会红。
- `validateGoldenSet` 只校验题型数量，不校验 fact_id 是否存在于库；不要顺手加 DB 校验（会越界到 P1-20）。
- `--golden` 既接受 `v1` 也接受路径；负控用路径，别改 `resolveGoldenFile`。
- 退出码 2 不要与门禁 1 混淆；验收会分别检查。
