# P3-11 入包集合差异率 · 进度

状态：DONE（2026-11-07，独立验收 AC-1..AC-7 + 修复复验 D1..D3 PASS）

## 范围

详设 §11.2 / 综述 §15.7。`rate = 1 - |TopK_on ∩ TopK_off| / K`，用于 P3 退出条件
「开/关 GAT 的入包集合差异率 > 5%」。台账验收命令：`moshi eval run --flags gat=on,gat=off`。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/core/ops/pack-diff.ts`（新） | `comparePacks`（集合语义、`K=max(两组实际条数)`、都空记 0）、`packDiffRows`（逐题对齐，条数不一致抛错）、`summarizePackDiff`（逐题平均、阈值 5% 严格大于）、`formatPackDiff`（总体 + 只列有差异的题） |
| `src/app/cli/commands/eval.ts` | `parseGatFlags`：只接受成对 `gat=<off\|shadow\|on>` 且含 `off`；`--flags` 路径拉起 sidecar、注入 `score`，同一批题跑两组，**off 先跑**（on 会写回置信，先跑会污染 off 基线）；与 `--in-place` 互斥；两组任一门禁失败 → 退出 1 |
| `tests/unit/packDiff.test.ts`（新） | 12 条：集合语义/条数不同取大者/去重与空集、逐题对齐与错位报错、平均值与阈值严格大于、报告格式、`parseGatFlags` 合法/非法、`runGoldenSet` 两组组合出差异率；修复补 3 条（off 先跑顺序、`--in-place` 互斥、`--flags` 缺值退出 2） |

## 决策

- **K 取两组实际入包条数的较大者**：详设只写"实际入包条数"；两组可能不同（token 预算/模型 δ 都会改条数），取较大者保证 `rate ∈ [0,1]` 且交换两组不变。
- **总体用逐题平均**：不同题入包条数差异很大，按题等权比按条数加权更贴近"每道题有没有变"。
- **阈值严格大于 5%**：概设 §12 写「差异率 > 5%」，等于阈值不判通过。
- **off 先跑**：`on` 档按 P3-08 会写回置信，先跑 on 会改变后续 off 的基线；固定 off 在前，差异只反映模型对本次打包的影响。
- **`--flags` 与 `--in-place` 互斥**：on 档写库，跑在用户库上等于污染生产数据（与 eval 默认临时副本纪律一致）。

## 验收

- AC-1 `rate = 1 - overlap/K`，K=max(两组实际去重条数)，两组都空记 0；
- AC-2 逐题对齐；两组结果条数不一致直接报错；
- AC-3 同一批 golden 题跑 on/off 两组能算出逐题差异与总体差异率（`runGoldenSet` 组合验证）；
- AC-4 总体取逐题平均，阈值 5% 严格大于才算达标（未达标退出 1，供台账 §2 的 `&&` 判定）；报告输出总体结论与逐题明细；
- AC-5 `parseGatFlags` 拒绝缺 off、重复、非法值；`--flags` 缺值退出 2；`--flags` 与 `--in-place` 互斥；
- AC-6 `off` 组先跑（on 档写回置信不影响 off 基线）；
- AC-7 `pnpm verify` / `pnpm build` 全绿。

## 读数

| 命令 | 结果 |
| --- | --- |
| `vitest run tests/unit/packDiff.test.ts` | 12 passed |
| `pnpm verify` | 128 files / 1552 passed（修复后） |
| `pnpm build` | exit 0 |

## 验收后修复（2026-11-07）

- **D1 文档渲染**：§11.2 的「实现口径」段误插在指标表格行之间，`消解待办量`/`隔离率` 两行被截断成普通段落；已移到表格之后。
- **D2 缺值静默**：`--flags` 作为末参数缺值时被当成"没传 flags"退回普通评估；改为退出 2 并提示用法。补 CLI 单测。
- **D3 覆盖缺口**：补 `orderedGatModes`（off 先跑）与 `--in-place` 互斥的 runCli 级单测。
- **差异率纳入退出码**：原实现只打印不失败，台账 §2 的 `moshi eval gate && moshi eval run --flags ...` 无法用 `&&` 判「> 5%」；改为 `gateFailed || !summary.pass → 1`。详设 §11.2 同步。
