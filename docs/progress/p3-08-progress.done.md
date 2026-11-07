# P3-08 δ 门控与重跑裁决（进度）

状态：DONE（2026-11-07，独立验收 AC-1..AC-8 + 修复复验 AC-R1..R4 PASS）
依据：任务详述 P3-08；详设 §7.5（第 5 步是 K3 的代码化）。
前置：P3-07（shadow 接线与埋点）。

## 范围

- `src/core/read/gate-delta.ts`（新增）
  - `gateOne(confidence, {delta, overturnProb}, cap)`：§7.5 步骤 1–3（clamp / [0,1] / overturn 守卫）
  - `applyNeuralDeltas(db, facts, edges, opts)`：步骤 4–6（用 cand 重跑裁决、按 `canonical_key` 整组判翻转、存活者 `setConfidence` + audit）
- `src/core/read/search.ts`
  - `SearchRuntime.deltaCap`（`model.delta_cap` 注入，默认 0.15）
  - `gat_mode='on'` 且有模型分 → 走门控路径；`stage_ms_json.model_applied` / `model_rejected`
  - `shadow`/`off` 行为不变（不落库、不改排序）
- `src/app/mcp/query.ts`：注入 `deltaCap`
- `tests/unit/gateDelta.test.ts`（9 用例）；`tests/unit/gatShadow.test.ts` 增 2 个 `on` 模式用例

## 不做

- 双门槛 gate 命令（P3-09）
- 熔断（P3-10）
- δ 落库的批量事务合并（当前逐条 `setConfidence`，top_k 规模下可接受）

## 验收读数

| 命令 | 读数 |
| --- | --- |
| `vitest run tests/unit/gateDelta.test.ts` | 10 passed |
| `vitest run tests/unit/gatShadow.test.ts` | 7 passed |
| `pnpm verify` | 125 files / 1512 passed |
| `pnpm build` | exit 0 |

## 关键分支

| 分支 | 覆盖 |
| --- | --- |
| δ 超 cap | clamp（不拒绝） |
| `overturn_prob>0.5` 且 δ<0 | `overturn_guard` 拒绝 |
| 无变化 | `unchanged` 不落库 |
| 互斥组胜者换人 | `mutex_flip` 整组回退，DB 不变 |
| 互斥组未翻转 | 生效，`disputedBy` 保持 |
| 模型给候选外节点打分 | 忽略 |

## 验收后修复（2026-11-07 20:07）

1. **[低-中] on 模式门控异常会让查询失败**：`search.ts` 门控分支包 try/catch，异常退回普通裁决 +
   `degraded` 补 `no_model`（模型的问题不能让查询失败）。
2. **落库非原子**：`gate-delta.ts` 的 `setConfidence` 循环改 `withTransaction`，中途失败整批回滚。

回归测试：`gateDelta.test.ts` 增「中途失败整批回滚」；新增 `gatDeltaFallback.test.ts`（`vi.mock` 令门控抛错，断言查询照常返回）。
