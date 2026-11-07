# P3-07 shadow mode 与埋点（进度）

状态：DONE（2026-11-07，独立验收 AC-1..AC-8 + AC-6 修复复验 AC-6-R1..R4 PASS）
依据：任务详述 P3-07；详设 §4.7 / §7.5 / §7.6。
前置：P3-04（`/score` 端点）。

## 范围

- `src/core/read/subgraph-payload.ts`（新增）
  - `buildPayloadFromSubgraph(db, sub, queryVector)`：`Subgraph → moshi-subgraph/2 payload`
  - 训练导出（P3-06）与读取链共用，特征组装只留一份
- `src/core/read/search.ts`
  - `SearchRuntime.score?: ModelScoreFn`（结构化类型，core 不 import `SidecarClient`）
  - `gat_mode != off` 且注入 `score` 时：组 payload → `/score` → **只记录**
  - 埋点：`stageMs.subgraph_nodes` / `stageMs.model_ms`；`fused_json` 每条带 `model_delta` / `overturn_prob`
  - 降级：score 返回 `scores=null` → `no_sidecar`/`no_model`；抛错 → `no_model`；查询永不失败
  - trace 的 `model_version` 取打分返回（`traceMeta(rt, resolvedVersion)`）
- `src/app/mcp/deps.ts`：`McpDeps.score` + `scoreViaSidecar`
- `src/app/mcp/query.ts` / `src/app/http/server.ts`：装配注入
- `tests/unit/gatShadow.test.ts`（5 用例）；`tests/unit/search.test.ts` 的 stageMs 单调断言排除观测字段

## 不做

- δ 应用、重跑裁决（P3-08）
- 双门槛 gate 命令（P3-09）
- 熔断（P3-10）
- 缓存命中行的模型分（缓存返回旧包，不重新打分）

## 验收读数

| 命令 | 读数 |
| --- | --- |
| `vitest run tests/unit/gatShadow.test.ts` | 5 passed |
| `vitest run tests/unit/search.test.ts` | 16 passed |
| `pnpm verify` | 122 files / 1499 passed |
| `pnpm build` | exit 0 |

## 验收后修复（2026-11-07 19:52）

- **[低] core 仍 import `infra/sidecar`**：`src/core/ops/status.ts` 的 `import type { SidecarStatus }`
  改为本文件的结构化类型 `SidecarStatusView`（`state/mode/embedModel` 字面量类型与 `StatusModel` 对齐），
  `SidecarClient.status()` 仍按结构兼容；`grep -rn "infra/sidecar" src/core` → 0 行。
