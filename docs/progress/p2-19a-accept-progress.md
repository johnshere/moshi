# P2-19A 验收：tools/accept-p2.ts 自动化 §2 验收链 — 进度

- 任务：task-26（P2-19A 验收自动化）
- 状态：DONE
- 依据：台账 §4 P2-19-A「§2 P2 验收命令能跑通」；详设 §10.8（搜索/预览延迟）、§12（Phase 2 退出条件）
- 开工：2026-11-04 22:48（Asia/Shanghai）

## 开工核查

- `tools/seed-graph.ts` 只有 CLI 入口（`seed()` 未导出，模块顶层直接 `seed(parseArgs(process.argv))`）→ 按任务卡允许的替代方式，用 `spawnSync` 调 `tsx tools/seed-graph.ts`（`stdio:'inherit'`，避免管道 EPERM），未改 seed-graph。
- `buildHttpApp({db,cfg,token})` 可直接 `inject`，无需起真实端口；`/api/graph` 上限 5000，返回 `{nodes,edges,meta}`；`/api/facts?q=` 用 LIKE（content/canonical_key）；`/api/archive/export` 返回 `{exported,written,unchanged,proposed,dir,elapsed_ms}`；`/api/archive/topics` 列表含 `topic_id/slug`。
- `harvest(db)` 公共入口可直调；annotation 队列用 `annotationRepo.insert(channel:'annotate')` 播种，重复入队即模拟「游标丢失重放」。
- 服务器库/归档都在 `temp/accept-p2/<stamp>/home` 下；`~/.moshi` 完全未触碰。

## 实现

- 新增 `tools/accept-p2-lib.ts`（纯函数）：`AcceptStep` / `AcceptReport`、`percentile`（最近秩；空数组 0）、`summarize`、`decideVerdict`、`buildReport`、`formatStepLine`。
- 新增 `tools/accept-p2.ts`：6 步验收链，每步独立 try/catch（一步 FAIL 不中断其余，最终统一退出码）：
  1. `seed`：shell 调 seed-graph（5000 facts / 15000 edges），断言下限；
  2. `graph`：`GET /api/graph?limit=5000`，记录 `node_count/edge_count/payload_bytes/graph_ms`，断言 node≥5000（**只记录耗时，不做帧率断言**）；
  3. `search`：`GET /api/facts?q=种子&limit=50` ×20，最近秩 P50/P95，断言 P95 < 80ms；
  4. `archive-preview`：`POST /api/archive/export {all:true}` 产 24 篇，再 `GET /api/archive/topics/:slug` ×20，断言 P95 < 300ms；
  5. `export-idempotent`：二次导出 `written=0 && unchanged>0` 且文件 mtime 不变；再改该主题 1 条事实（confidence +0.05）导出 → `written=1` 且 mtime 变化；
  6. `harvest-idempotent`：同一份 20 条 annotate 会话跑两遍（第二遍换 dedupKey 重放），断言 fact/edge 计数完全一致、第二遍 `created=0`。
- 输出：控制台逐行 `PASS/FAIL`；报告 `temp/accept-p2/report-<stamp>.json`（`schema:"moshi-accept-p2/1"`）；成功且非 `--keep` 时清理本次数据目录，只保留报告。

## 验收

### 纯函数单测

```
pnpm vitest run tests/unit/accept-p2.test.ts
 ✓ tests/unit/accept-p2.test.ts (9 tests)
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

（覆盖：空数组、单样本、p=0/0.5/0.95/1 边界、越界夹取且不改输入、20 样本最近秩、summarize、FAIL 传播、报告 schema、格式化行。）

### 类型检查

`pnpm typecheck` 通过（tools/tests 在 tsconfig include 内）。

### 真跑（5000/15000 种子）

```
PASS 1/6 seed facts=5000 edges=15000 seed_ms=3042
PASS 2/6 graph node_count=5000 edge_count=15000 payload_bytes=2890459 graph_ms=163.78
PASS 3/6 search p50_ms=5.1 p95_ms=6.43 requests=20
PASS 4/6 archive-preview slug=topic-0 exported=24 written=24 p50_ms=0.49 p95_ms=0.58
PASS 5/6 export-idempotent second_written=0 second_unchanged=24 mtime_stable=true changed_written=1 changed_mtime_changed=true
PASS 6/6 harvest-idempotent replayed=20 facts_after_first=5020 facts_after_second=5020 edges_after_first=15000 edges_after_second=15000 second_created=0 second_refreshed=20

[accept-p2] 6/6 PASS · 0 FAIL
[accept-p2] report: J:\Workspace\Codes\moshi\temp\accept-p2\report-2026-11-04T14-51-38-225Z.json
[accept-p2] data: (已清理，--keep 可保留)
[exit] 0
```

报告关键片段：

```json
{"schema":"moshi-accept-p2/1","at":"2026-11-04T14:51:43.375Z",
 "steps":[
  {"name":"graph","ok":true,"ms":179,"detail":{"node_count":5000,"edge_count":15000,"payload_bytes":2890459,"graph_ms":163.78}},
  {"name":"search","ok":true,"ms":111,"detail":{"p50_ms":5.10,"p95_ms":6.43,"requests":20}},
  {"name":"export-idempotent","ok":true,"ms":948,"detail":{"second_written":0,"second_unchanged":24,"mtime_stable":true,"changed_written":1,"changed_mtime_changed":true}},
  {"name":"harvest-idempotent","ok":true,"ms":217,"detail":{"facts_after_first":5020,"facts_after_second":5020,"second_created":0}}],
 "summary":{"passed":6,"total":6,"failed":0}}
```

## 决策与遗留

- D-P2-19A-26-1：`seed-graph` 未导出可调用函数，按其现有 CLI 契约 shell 调用；**建议 Lead 后续给 seed-graph 加 `export function seedGraph(...)`**，可去掉子进程依赖（本卡按纪律不改 tools/seed-graph.ts）。
- D-P2-19A-26-2：P95 用最近秩（20 样本时 P95 = 第 19 慢），不做插值；空样本返回 0。
- D-P2-19A-26-3：报告文件保留在 `temp/accept-p2/report-*.json`，数据目录默认清理；`--keep` 保留数据便于复现。
- D-P2-19A-26-4：步骤间不短路——seed FAIL 时后续步骤会各自 FAIL 并写明原因，报告仍完整产出（便于一次看清缺哪环）。
- I-1：`graph` 步骤只记录 `graph_ms`，30fps 仍必须浏览器/人眼验收（任务卡明确不做帧率断言）。
- I-2：`archive-preview` 延迟是 `inject` 墙钟（含 JSON 序列化），与浏览器网络路径略有差异；阈值 300ms 留有余量（实测 <1ms）。
- 建议 package.json：`"accept:p2": "tsx tools/accept-p2.ts"`（`--keep` 通过 `pnpm accept:p2 -- --keep` 传）。
