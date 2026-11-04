# P2-18 进度 — 诊断页 / `doctor` / DiagPanel

- 任务：task-5（台账 §4 P2-18）
- 状态：**实现与自测完成**（2026-11-04），待 Lead 接线 + verify/build/commit
- 约束遵守：未改 `docs/任务台账.md`；未跑 `pnpm build` / `pnpm verify`；未 git commit；未改 `src/app/cli/index.ts`、`src/app/http/server.ts`（接线由 Lead 做）；未改 `/api/graph`（D-89）

## 产出文件

| 文件 | 内容 |
| --- | --- |
| `src/infra/sqlite/diagRepo.ts` | 全部诊断 SQL：DB 信息（integrity/user_version/size/wal）、索引输入、I1–I10 原始输入、归档台账、图质量输入、meta 心跳 |
| `src/core/diag/types.ts` | 详设 §11.4 响应类型（逐字段） |
| `src/core/diag/invariants.ts` | `evaluateInvariants` / `invariantFailures` / `invariantsAllGreen` |
| `src/core/diag/quality.ts` | 模块度、近似重复比、cosine、round4 |
| `src/core/diag/report.ts` | `buildDiagReport`（索引状态 ok/off/stale/missing 口径） |
| `src/core/diag/collect.ts` | `collectDiagReport`（DB → §11.4 报告） |
| `src/app/http/routes/diag.ts` | `diagRoutes`：`GET /api/diag`、`GET /api/diag/quality`（`cache-control: no-store`） |
| `src/app/cli/commands/doctor.ts` | `doctorCommand`（`--fix` 仅 degree + FTS） |
| `src/ui/settings/DiagPanel.tsx` | 自包含展示组件（读 `/api/diag`，未挂路由） |
| `tests/unit/diag.test.ts` | 11 个用例：响应契约、I1–I10 真假、--fix 边界、质量指标、meta 心跳 |

## 关键决策

- **D-P2-18-1 I9 口径**：`fact_fts` 行数必须等于 `fact` 行数；向量路若已标记 `vector_disabled` 则要求 `fact_vec` 不存在/不可数（不假装索引过），否则 `fact_vec` 行数必须等于 `fact` 行数。
- **D-P2-18-2 `--fix` 边界**：只重建派生数据。FTS 先用 `syncMissingFts` 补缺失行（不重建已有行），行数仍不符才 `rebuildFts`；degree 用 `rebuildDegree` 对账；不动 content/attrs/audit/confidence。
- **D-P2-18-3 退出码**（详设 §4.8）：不变量失败 → 3；DB integrity 异常 → 1；不变量绿但向量索引非 ok（无 sqlite-vec / 未建）→ 4「降级但可用」；全绿 → 0。
- **D-P2-18-4 心跳字段**：`last_harvest_at` 当前代码库无写入方 → `null`（P2-17 调度器遗留）；`last_eval` 读 `meta.last_eval` 并校验 `{at:string,passed,total,blocking_failures:number}`，形状不对给 `null`。
- **D-P2-18-5 DiagPanel 编译**：`src/ui/tsconfig.json` 的 include 目前不含 `settings/**`，因此组件用单文件 `tsc` 校验通过；需 Lead 把 `settings/**` 加进 include，否则 `typecheck:ui` 不覆盖它。
- **D-P2-18-6 质量指标**：无数据给 `null`（不伪造 0）；`near_dup_ratio` 无向量时 `null`、有向量但无候选对为 0；`key_entity_coverage` 按详设 SQL 口径。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 通过（期间出现过两处并行任务 WIP 报错：`server.ts` TraceStore、`scheduler.ts` 未用变量，均由对应队友修复，非本任务文件） |
| `pnpm typecheck:ui` | ✅ 通过；另用单文件 `tsc`（strict/noUnused/verbatimModuleSyntax）验证 `DiagPanel.tsx` 通过 |
| `pnpm vitest run tests/unit/diag.test.ts` | ✅ 11 passed |
| `pnpm vitest run tests/unit/graph-api.test.ts` | ✅ 13 passed（未改契约） |
| `pnpm lint:lifecycle` | ✅ 102 文件 |
| `pnpm lint:deps` | ✅ 150 模块 / 645 依赖 |
| `pnpm lint:writes` | ✅ 102 文件 |

## 真实 `doctor` 输出（种子库 `.dsh/temp/p2-18/home/.moshi`，120 facts / 60 edges）

1）首次运行（seed 绕过 FTS，且未跑 embedding）：

```
默识 doctor 自检（I1–I10 + 图质量六项）
DB       完整性 ok · user_version 5 · 0.49 MB（WAL 0.00 MB）
索引     FTS stale · 向量 stale · degree 不一致 0
不变量   I1 ✅ · I2 ✅ · I3 ✅ · I4 ✅ · I5 ✅ · I6 ✅ · I7 ✅ · I8 ✅ · I9 ❌ · I10 ✅
结论     不变量失败：I9
exit=3
```

2）人为制造 degree 漂移后（派生数据被破坏）：

```
索引     FTS stale · 向量 stale · degree 不一致 5
不变量   I1 ✅ · I2 ✅ · I3 ✅ · I4 ✅ · I5 ✅ · I6 ✅ · I7 ❌ · I8 ✅ · I9 ❌ · I10 ✅
结论     不变量失败：I7, I9
exit=3
```

3）`moshi doctor --fix`：

```
修复：degree 重建 120 行 · FTS 补齐 120 行
索引     FTS ok · 向量 stale · degree 不一致 0
不变量   I1 ✅ · I2 ✅ · I3 ✅ · I4 ✅ · I5 ✅ · I6 ✅ · I7 ✅ · I8 ✅ · I9 ❌ · I10 ✅
结论     不变量失败：I9
exit=3
```

（`--fix` 后 FTS 与 degree 恢复；向量索引需 sidecar 编码，不属 `--fix` 安全修复范围。）

4）补齐向量索引（模拟 sidecar 完成编码）后全绿：

```
索引     FTS ok · 向量 ok · degree 不一致 0
不变量   I1 ✅ · I2 ✅ · I3 ✅ · I4 ✅ · I5 ✅ · I6 ✅ · I7 ✅ · I8 ✅ · I9 ✅ · I10 ✅
结论     全部通过
exit=0
```

## Lead 需要加的三行接线

1. `src/app/http/server.ts`：
   ```ts
   import { diagRoutes } from './routes/diag.js';
   // buildHttpApp 内、其他路由注册处：
   await app.register(diagRoutes, { prefix: '/api/diag', db: deps.db, cfg: deps.cfg });
   ```
2. `src/app/cli/index.ts`：`import { doctorCommand } from './commands/doctor.js';` 并加入 `COMMANDS`。
3. `src/ui/tsconfig.json`：include 增加 `"settings/**/*.ts"`、`"settings/**/*.tsx"`（否则 DiagPanel 不参与 `typecheck:ui`）。

## 遗留

- 向量索引重建不在 `doctor --fix` 范围（需 embedding sidecar）；无 sqlite-vec 环境下会自动标记 `vector_disabled`，doctor 走 exit 4「降级但可用」。
- `last_harvest_at` 无写入方、`last_eval` 依赖 `meta.last_eval`，均属 P2-17 调度/评测遗留。
- 未跑 `pnpm build` / `pnpm verify`（Lead 统一执行）；`/api/diag` 浏览器验收待 Lead 接线后在 daemon 上做。
