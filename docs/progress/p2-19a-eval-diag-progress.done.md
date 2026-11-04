# P2-19A-13b eval 触发与诊断补项 — 进度

- 任务：task-23（P2-19A-13b：eval 触发、`/api/diag` 补项、facts depth）
- 状态：DONE
- 依据：台账 §4 P2-19-A；详设 §4.3 REST（facts detail `depth≤3`、diag、eval）；概设 §8.1 设置页「跑 golden set」、§10.5 自检页
- 开工：2026-11-04 22:40（Asia/Shanghai）

## 开工核查

- `src/app/http/routes/diag.ts`：`GET /`、`GET /quality` 已实现，`cache-control: no-store`。
- `src/core/diag/collect.ts` 的 `last_eval` 读取链路已存在（`parseEvalJson(readLastEvalRaw(db))`），但全仓无写入方 → 恒 `null`。
- `DiagReport.archive` 已有 `proposed_pending` / `merged_or_split`，`quality.layout_freshness` 已有；缺 `resolve` / `schema` 两块。
- `src/app/cli/commands/eval.ts`（P1-16）已实现 golden set 评测，run 逻辑与 CLI 抽离干净，适合抽 core 复用。
- `src/app/http/routes/facts.ts` detail 已一次取 `traceDepends` 三跳，只需按 `depth` 截断。
- `src/app/http/server.ts` 尚未注册 eval 路由（Lead 负责）。

## 实现

### 1. `POST /api/eval/run` + `meta.last_eval`

- 新增 `src/core/ops/eval.ts`（纯逻辑）：`GoldenItem` / `EvalOutcome` / `EvalPackView` / `EvalQueryFn`、`loadGolden`、`evaluateItem`、`runGoldenSet`、`formatByType`、`resolveGoldenFile`、`EVAL_TOP_K=8`、`EVAL_GATE_TYPES=['temporal','refusal']`。
- 重写 `src/app/cli/commands/eval.ts`：保留原导出名与 run 行为（临时副本 / `--in-place` / `--vector` / 输出文案 / 门禁 exit 1），循环改调 core。
- 新增 `src/app/http/routes/eval.ts`：`POST /run`，进程内 `running` 互斥；成功写 `meta.last_eval = {at,passed,total,blocking_failures}`；响应 `{ok, at, passed, total, blocking_failures, elapsed_ms}`。
- 口径决策：
  - 无 golden set → **200** `{ok:false, reason:'no_golden_set', ...}`（不是 409：属「未配置」而非并发冲突）。
  - 并发触发 → **409** `E_CONFLICT` / `detail.reason='eval_running'`。
  - HTTP 版**不**做临时库副本、不启 sidecar（`encode` 缺省）：直接在当前库上跑并写 meta；CLI 行为不变。

### 2. `/api/diag` 三块补项 + DiagPanel

- `src/core/diag/types.ts`：新增 `DiagResolveJson {pending}`、`DiagSchemaJson {pending_promotions}`，`DiagReport` 增 `resolve`、`schema`。
- `src/infra/sqlite/diagRepo.ts`：新增 `readResolvePending`（与 resolve 队列同口径：`alias.source='vector' AND confidence BETWEEN RESOLVE_MIN_SIM AND RESOLVE_MAX_SIM`，常量从 `inboxRepo` 复用）、`readPendingPromotions`（`COUNT(*) FROM ontology WHERE promoted=0`）。
- `src/core/diag/collect.ts` / `report.ts`：`collectDiagReport` 组装并透传 `resolve` / `schema`。
- `src/ui/settings/DiagPanel.tsx`：接口补 `archive.proposed_pending/merged_or_split`、`quality.layout_freshness`、`resolve.pending`、`schema.pending_promotions`；质量表增「布局滞后（h）」；新增「待办 / 结构」卡片；归档卡片增「待合并提案」「已合并/分裂」。
- 注意：`pending_promotions` **以 DB 计数为准**（不做 `meta.pending_promotions` 双写，避免两处真相）。

### 3. `GET /api/facts/:id?depth=1|2|3`

- `src/app/http/routes/facts.ts`：`parseDepth`（缺省 1；`/^[1-3]$/`；数组或其他值 → 400 `E_INPUT` / `detail.reason='depth_invalid'`）；detail 调 `traceDepends(db,id,{hops:depth})`；响应新增 `depth`，既有 `depends.upstream/downstream` 字段名不变、不删字段。

## 验收

### 测试

```
pnpm vitest run tests/unit/eval-api.test.ts tests/unit/diag.test.ts tests/unit/facts-http.test.ts
 ✓ tests/unit/diag.test.ts (15 tests) 541ms
 ✓ tests/unit/eval-api.test.ts (5 tests) 380ms
 ✓ tests/unit/facts-http.test.ts (5 tests) 322ms
 Test Files  3 passed (3)
      Tests  25 passed (25)
```

回归（CLI eval 抽 core 后行为不变）：

```
pnpm vitest run tests/unit/eval.test.ts tests/unit/http.test.ts
 ✓ tests/unit/http.test.ts (23 tests) 1075ms
 ✓ tests/unit/eval.test.ts (5 tests) 238ms
 Test Files  2 passed (2)
      Tests  28 passed (28)
```

### 类型检查

- `pnpm typecheck:ui` → 通过。
- `pnpm typecheck` → 我的文件无报错；唯一报错是并发任务 WIP 的 `tests/unit/privacy-purge.test.ts`（`OpenResult is not assignable to Database` 等 5 条），非本卡改动，已如实报告 Lead。

### 真实 inject 证据（临时脚本，已删除）

```
diag before: {"last_eval":null,"resolve":{"pending":0},"schema":{"pending_promotions":1}}
POST /api/eval/run: 200 {"ok":true,"at":"2026-11-04T14:46:53.636Z","passed":2,"total":2,"blocking_failures":0,"elapsed_ms":6}
diag after: {"last_eval":{"at":"2026-11-04T14:46:53.636Z","passed":2,"total":2,"blocking_failures":0},"resolve":{"pending":0},"schema":{"pending_promotions":1}}
depth default: {"depth":1,"upstream":1,"downstream":1}
depth=2: {"depth":2,"upstream":2,"downstream":1}
depth=3: {"depth":3,"upstream":2,"downstream":1}
depth=4: 400 {"error":"E_INPUT","message":"depth 必须是 1..3 的整数，收到「4」","detail":{"reason":"depth_invalid"}}
concurrent #1: 200 {"ok":true,...,"passed":40,"total":40,...,"elapsed_ms":31}
concurrent #2: 409 {"error":"E_CONFLICT","message":"golden set 评估正在运行，稍后再试","detail":{"reason":"eval_running"}}
no golden: 200 {"ok":false,"reason":"no_golden_set",...}
```

## 决策与遗留

- D-P2-19A-13b-1：HTTP eval 不做临时副本（CLI 仍保留），避免请求内拷贝整库；写 `meta.last_eval` 只在本库。
- D-P2-19A-13b-2：无 golden set 用 200 `no_golden_set`（未配置 ≠ 冲突）。
- D-P2-19A-13b-3：`schema.pending_promotions` 只以 `ontology.promoted=0` 计数，不读 `meta.pending_promotions`。
- D-P2-19A-13b-4：`depth` 复用 `traceDepends(...,{hops})`，不新写 SQL；响应只增 `depth` 字段。
- 接线（Lead）：`src/app/http/server.ts` 顶部 import `evalRoutes`，并在 `diagRoutes` 注册后（L92 后）加
  `await app.register(evalRoutes, { prefix: '/api/eval', db: deps.db, cfg: deps.cfg });`
- I-1：HTTP eval 无向量/交叉编码器参与（`encode` 缺省），纯符号评测；与 CLI `--vector` 路径的差异已在报告注明。
- I-2：并发互斥是进程内布尔（单实例 Fastify）；多进程部署需换文件锁/DB 锁，本阶段无多实例。
