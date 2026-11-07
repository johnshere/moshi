# P3-05 训练样本构造（进度）

状态：DONE（2026-11-07，独立验收 AC-1..AC-10 PASS）
依据：任务详述 P3-05；详设 §7.4。
前置：P0-11（`training_sample` 表）、P3-A9（`adjudication.outcome` 真实写入方）。

## 范围

- `src/infra/sqlite/trainingSampleRepo.ts`
  - `insertSampleOnce`（`ON CONFLICT(id) DO NOTHING`，幂等）
  - 原料查询：`listDecidedAdjudications`（`outcome IS NOT NULL`，`outcome_at > since`）、
    `listFeedbackForRank`（`ts > since`）
  - 统计：`countSamples` / `countSamplesByKind` / `sampleExists`
- `src/core/lifecycle/train-samples.ts`
  - `adjudication.outcome` → `label_kind='overturn'`，label `overturned=1 / upheld=0`，`created_at=outcome_at`
  - `feedback.verdict` → `label_kind='rank'`，label `adopt=1 / correct=0.5 / reject=0`，`fact_ids=[fact_id]`
  - **feedback 永不产出 overturn 样本**（循环标签不能训 `overturn` 头，详设 §7.3）
  - 样本 id 确定化：`ts_adj_<aj>` / `ts_fb_<fb>`（D-157），重跑不复制
  - `dryRun` 只读；正常路径单事务
- `src/app/cli/commands/samples.ts` + `index.ts` 注册：`moshi samples build [--since <iso>] [--dry-run]`
  （生产接线点）

## 不做

- 不训练、不导出权重（P3-06）
- 不消费 `used_at`（训练侧 P3-06 回写）
- 不接 `execution` 来源（当前无生产者）

## 验收读数

| 命令 | 读数 |
| --- | --- |
| `vitest run tests/unit/train-samples.test.ts` | 7 passed（AC-1..AC-7） |
| `pnpm verify` | 120 files / 1488 passed + 2 skipped（共 1490） |
| `pnpm build` | exit 0 |
| CLI 冒烟（`init --no-daemon` 临时库 → `samples build --dry-run`） | exit 0；`created:0 counts:[]`（空库正确）；未知子命令 exit 2 |

独立验收补充实测：`samples build` 无子命令 / 未知子命令 / `--since not-a-date` 均 exit 2；`since == ts` 的边界行被排除（严格 `>`）；幂等重跑 `first.created=2, second.created=0`。
