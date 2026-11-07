# P3-06 训练脚本与权重导出（进度）

状态：DONE（2026-11-07，独立验收 AC-1..AC-10 + 修复复验 AC-R1..AC-R4 PASS）
依据：任务详述 P3-06；详设 §7.4。
前置：P3-03（`model.py`）、P3-05（`training_sample` 样本）。

## 范围

- `src/core/lifecycle/train-export.ts`
  - `exportTrainingPayloads(db, opts)`：样本 → `buildSubgraph` → `buildSubgraphPayload`（`moshi-subgraph/2`）
  - `focus_fact_id`（标签锚点，D-160）；`queryVectors` 注入式编码（CLI 用 sidecar `/encode`）
  - `toJsonl`：一行一条
- `src/infra/sqlite/trainingSampleRepo.ts`：新增 `getQueryText(db, queryId)`
- `src/app/cli/commands/samples.ts`：新增 `samples export [--out] [--since] [--limit] [--no-query-vectors]`
- `sidecar/train.py`
  - `load_records` / `split_by_time`（按时间 8:1:1，不随机切）
  - 损失 `BCE(overturn@锚点) + λ·pairwise(δ@锚点)`，λ 仅当 train 侧 rank ≥ 2000 才从 0 线性爬到 0.3
  - AdamW `lr=1e-3` / `wd=1e-4`，有效 batch 32，epoch 30，val AUC 早停 patience 5，`seed=42` + `use_deterministic_algorithms`
  - 导出 `{state_dict, config, meta}`，`meta.model_version = gat-v1@<git_sha>`
- `sidecar/tests/test_train.py`（12 用例）、`tests/unit/train-export.test.ts`（4 用例）

## 不做

- 不接 `core/read` 打分（P3-07 shadow）
- 不做模型选择/超参搜索（详设只给一套配置）
- 不做增量训练（每次从全量 JSONL 重训）

## 验收读数

| 命令 | 读数 |
| --- | --- |
| `pytest sidecar/tests/ -q` | 64 passed |
| `vitest run tests/unit/train-export.test.ts` | 4 passed |
| `pnpm verify` | 122 files / 1494 passed |
| `pnpm build` | exit 0 |
| 端到端（临时库 4 样本 → export → train → `/score`） | JSONL 4 行；`.pt` 产出；`/score` 返回 `model_version=gat-v1@4088e99`、2 节点打分 |
| `samples export` CLI（默认路径 / `--no-query-vectors` / 走 sidecar） | 均 exit 0；白名单外的 `--out` 被拒（exit 1，预期） |

## 验收后修复（2026-11-07 20:05）

1. **[中] null-query pairwise 错配**：`_pairwise_loss` 原把 `query_id=null` 全并成一组，
   不同查询的 adopt/reject 会被错配成对；现改为 null-query 样本不参与 pairwise。
2. **[低] `use_deterministic_algorithms` 的 try/except 形同虚设**：该开关 op 执行期才抛，
   去掉静默兜底，明确报错优于产出不可复现权重。
3. **[低] 无 AUC 时白跑满 epoch**：val 单类且非空时退回 `-val_bce` 作为早停指标，
   并仍能选中权重。

## 已知边界

- `query_vector` 覆盖率取决于 `query_log` 是否有对应 `query_id` 且 sidecar 可用；覆盖率写入导出统计（`queryWithText` / `queryWithVector`）。
- 早停优先用 val AUC；val 集**单类且非空**时退回 `-val_bce`（`val_auc=null` 属预期）；val 集没有任何 overturn 样本时无可评估信号，跑满 epochs。
