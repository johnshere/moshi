/**
 * 训练样本构造（详设 §7.4；台账 P3-05）。
 *
 * 两个头、两种标签，**来源不能互换**：
 *
 * | 头 | 标签来源 | 为什么 |
 * | --- | --- | --- |
 * | `overturn` | `adjudication.outcome` | 世界产生的非循环信号：规则押注的事实后来被新观测推翻/证实 |
 * | `rank` | `feedback.verdict` | Agent 自己的判断——循环，只够训 `delta`，训 `overturn` 是自我蒸馏 |
 *
 * 因此反馈**永远**只产出 `label_kind='rank'`；这条约束写死在 `buildTrainingSamples` 里，
 * 不提供任何开关（详设 §7.3「只有 overturn 头能在冷启动期训练」）。
 *
 * 幂等：样本 id 由来源行 id 派生（`ts_adj_<aj>` / `ts_fb_<fb>`），重复跑不会复制样本，
 * `--since` 回填因此可以随便重跑。
 */
import type { AdjOutcome, SampleSource, Verdict } from '../../domain/enums.js';
import type { Db } from '../../infra/sqlite/db.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import {
  insertSampleOnce,
  listDecidedAdjudications,
  listFeedbackForRank,
  sampleExists,
  type TrainingSampleInput,
} from '../../infra/sqlite/trainingSampleRepo.js';

/** `overturned=1`：规则错了，这是模型要预测的正类 */
const OVERTURN_LABEL: Record<AdjOutcome, number> = { overturned: 1.0, upheld: 0.0 };

/**
 * `rank` 的相对分：adopt=1 / correct=0.5 / reject=0。
 *
 * `correct` 不是"中性"而是"方向对、内容需修"——比 adopt 低、比 reject 高。
 * 训练侧用的是同一 query 内的 pairwise margin（详设 §7.4），绝对值的中间档只影响
 * 单点 BCE 那一支，取 0.5 是保守值，没有更细的证据前不要细分。
 */
const RANK_LABEL: Record<Verdict, number> = { adopt: 1.0, correct: 0.5, reject: 0.0 };

export interface SampleBuildStats {
  /** 扫到的来源行数 */
  scanned: number;
  /** 本次新写入（dryRun 时为"本会写入"） */
  created: number;
}

export interface BuildSamplesResult {
  since: string | null;
  dryRun: boolean;
  adjudication: SampleBuildStats;
  feedback: SampleBuildStats;
  /** 两种来源合计 */
  created: number;
}

export interface BuildSamplesOptions {
  /** 只处理 `outcome_at`/`ts` 严格晚于它的来源行（详设 §7.4 原 SQL 的 `> ?`） */
  since?: string;
  dryRun?: boolean;
}

/** 来源行 id → 样本 id。前缀不同，避免两种来源的 ULID 撞车。 */
export function adjudicationSampleId(adjudicationId: string): string {
  return `ts_adj_${adjudicationId}`;
}

export function feedbackSampleId(feedbackId: string): string {
  return `ts_fb_${feedbackId}`;
}

export function buildTrainingSamples(db: Db, opts: BuildSamplesOptions = {}): BuildSamplesResult {
  const dryRun = opts.dryRun === true;
  const since = opts.since;
  const candidates: TrainingSampleInput[] = [];

  const adjudications = listDecidedAdjudications(db, since);
  for (const row of adjudications) {
    candidates.push({
      id: adjudicationSampleId(row.id),
      queryId: row.queryId,
      factIds: row.factIds,
      labelKind: 'overturn',
      label: OVERTURN_LABEL[row.outcome],
      source: 'adjudication',
      createdAt: row.outcomeAt,
    });
  }

  const feedbackRows = listFeedbackForRank(db, since);
  for (const row of feedbackRows) {
    candidates.push({
      id: feedbackSampleId(row.id),
      queryId: row.queryId,
      factIds: [row.factId],
      labelKind: 'rank',
      label: RANK_LABEL[row.verdict],
      source: 'feedback',
      createdAt: row.ts,
    });
  }

  const counts: Record<SampleSource, number> = { adjudication: 0, feedback: 0, execution: 0 };
  const write = (): void => {
    for (const sample of candidates) {
      const isNew = dryRun ? !sampleExists(db, sample.id) : insertSampleOnce(db, sample);
      if (isNew) counts[sample.source] += 1;
    }
  };
  // dryRun 只读；正常路径单事务写入——半途失败不能留下"一部分样本"
  if (dryRun) write();
  else withTransaction(db, write);

  return {
    since: since ?? null,
    dryRun,
    adjudication: { scanned: adjudications.length, created: counts.adjudication },
    feedback: { scanned: feedbackRows.length, created: counts.feedback },
    created: counts.adjudication + counts.feedback,
  };
}
