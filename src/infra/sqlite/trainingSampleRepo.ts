/**
 * 训练样本仓储（详设 §7.4；台账 P3-05）。
 *
 * 样本 id 由调用方按**来源行**确定性生成（`ts_adj_<aj>` / `ts_fb_<fb>`），
 * 插入用 `INSERT OR IGNORE`。详设 §7.4 的 SQL 用 `randomblob(13)` 生成 id，
 * 每跑一次就会复制一份同样的样本——而样本构造必然会重跑（新裁决随时出现、
 * `--since` 回填），重跑幂等比 id 随机更重要。
 *
 * 查询侧只暴露"已裁决的裁决"与"反馈行"两种原料，标签映射留在 core（`train-samples.ts`），
 * 这里不做任何"这条反馈该进哪个头"的判断。
 */
import type { AdjOutcome, LabelKind, SampleSource, Verdict } from '../../domain/enums.js';
import type { Db } from './db.js';

export interface TrainingSampleInput {
  id: string;
  queryId: string | null;
  /** 子图/裁决涉及的 fact id（顺序原样保留，用于回溯子图节点顺序） */
  factIds: readonly string[];
  labelKind: LabelKind;
  label: number;
  weight?: number;
  source: SampleSource;
  createdAt: string;
}

export interface TrainingSampleRow extends TrainingSampleInput {
  usedAt: string | null;
}

/** 写入一条样本。返回 false 表示 id 已存在（幂等命中）。 */
export function insertSampleOnce(db: Db, sample: TrainingSampleInput): boolean {
  const info = db
    .prepare(
      `INSERT INTO training_sample (id, query_id, fact_ids, label_kind, label, weight, source, created_at)
       VALUES (@id, @queryId, @factIds, @labelKind, @label, @weight, @source, @createdAt)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run({
      id: sample.id,
      queryId: sample.queryId,
      factIds: JSON.stringify(sample.factIds),
      labelKind: sample.labelKind,
      label: sample.label,
      weight: sample.weight ?? 1.0,
      source: sample.source,
      createdAt: sample.createdAt,
    });
  return info.changes > 0;
}

export function sampleExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 AS x FROM training_sample WHERE id = ?').get(id) !== undefined;
}

export interface SampleFilter {
  source?: SampleSource;
  labelKind?: LabelKind;
  /** 只要未被训练消费的样本 */
  unusedOnly?: boolean;
}

export function countSamples(db: Db, filter: SampleFilter = {}): number {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.source !== undefined) {
    where.push('source = ?');
    args.push(filter.source);
  }
  if (filter.labelKind !== undefined) {
    where.push('label_kind = ?');
    args.push(filter.labelKind);
  }
  if (filter.unusedOnly === true) where.push('used_at IS NULL');
  const sql = `SELECT COUNT(*) AS n FROM training_sample${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const row = db.prepare(sql).get(...args) as { n: number };
  return row.n;
}

/** 按 (source, label_kind) 分组计数——`moshi samples build` 的输出口径 */
export function countSamplesByKind(db: Db): { source: SampleSource; labelKind: LabelKind; n: number }[] {
  const rows = db
    .prepare(
      `SELECT source, label_kind AS labelKind, COUNT(*) AS n
         FROM training_sample
        GROUP BY source, label_kind
        ORDER BY source, label_kind`,
    )
    .all() as { source: SampleSource; labelKind: LabelKind; n: number }[];
  return rows;
}

function parseFactIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function listSamples(db: Db, filter: SampleFilter = {}): TrainingSampleRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.source !== undefined) {
    where.push('source = ?');
    args.push(filter.source);
  }
  if (filter.labelKind !== undefined) {
    where.push('label_kind = ?');
    args.push(filter.labelKind);
  }
  if (filter.unusedOnly === true) where.push('used_at IS NULL');
  const sql = `SELECT * FROM training_sample${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at ASC, id ASC`;
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r['id']),
    queryId: (r['query_id'] as string | null) ?? null,
    factIds: parseFactIds(String(r['fact_ids'])),
    labelKind: String(r['label_kind']) as LabelKind,
    label: Number(r['label']),
    weight: Number(r['weight']),
    source: String(r['source']) as SampleSource,
    createdAt: String(r['created_at']),
    usedAt: (r['used_at'] as string | null) ?? null,
  }));
}

// ============ 原料 1：已回填 outcome 的裁决（非循环标签） ============

export interface DecidedAdjudicationRow {
  id: string;
  queryId: string | null;
  factIds: string[];
  outcome: AdjOutcome;
  outcomeAt: string;
}

/**
 * `outcome_at > since`（详设 §7.4 原 SQL 的严格大于）。
 * `since` 省略时不加时间条件——首次全量回填。
 */
export function listDecidedAdjudications(db: Db, since?: string): DecidedAdjudicationRow[] {
  const sql = `SELECT id, query_id, fact_ids, outcome, outcome_at
                 FROM adjudication
                WHERE outcome IS NOT NULL${since === undefined ? '' : ' AND outcome_at > ?'}
                ORDER BY outcome_at ASC, id ASC`;
  const rows = (since === undefined ? db.prepare(sql).all() : db.prepare(sql).all(since)) as {
    id: string;
    query_id: string | null;
    fact_ids: string;
    outcome: AdjOutcome;
    outcome_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    queryId: r.query_id,
    factIds: parseFactIds(r.fact_ids),
    outcome: r.outcome,
    outcomeAt: r.outcome_at,
  }));
}

// ============ 原料 2：反馈（只够训 rank 头，训 overturn 是自我蒸馏） ============

export interface FeedbackForRankRow {
  id: string;
  queryId: string | null;
  factId: string;
  verdict: Verdict;
  ts: string;
}

export function listFeedbackForRank(db: Db, since?: string): FeedbackForRankRow[] {
  const sql = `SELECT id, query_id, fact_id, verdict, ts
                 FROM feedback
                WHERE 1 = 1${since === undefined ? '' : ' AND ts > ?'}
                ORDER BY ts ASC, id ASC`;
  const rows = (since === undefined ? db.prepare(sql).all() : db.prepare(sql).all(since)) as {
    id: string;
    query_id: string | null;
    fact_id: string;
    verdict: Verdict;
    ts: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    queryId: r.query_id,
    factId: r.fact_id,
    verdict: r.verdict,
    ts: r.ts,
  }));
}
