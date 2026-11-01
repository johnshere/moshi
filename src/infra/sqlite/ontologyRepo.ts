/**
 * ontology 仓储（详设 §2.2 / §8.5；台账 P1-14、P1-08）。
 *
 * `ontology(kind='predicate')` 是互斥判定的依据：只有 single-valued 谓词下
 * 同一 canonical_key 的多条事实才构成互斥候选（D9）。统计口径（json_extract
 * 分组）是 SQL 细节，收在这里；判定阈值留在 core。
 */
import type { Db } from './db.js';
import type { Cardinality } from '../../domain/enums.js';

export interface PredicateStatRow {
  name: string;
  keys: number;
  singleRatio: number;
  valueOccurrences: number;
}

export interface UpsertPredicateStat {
  name: string;
  cardinality: Cardinality;
  sampleCount: number;
  distinctValues: number;
  singleRatio: number;
  registeredAt: string;
}

/**
 * 按谓词统计基数性线索。只在 active/disputed 事实内统计（失效行会稀释 single_ratio）。
 * `keys` = 该谓词下不同 canonical_key 数；`single_ratio` = 只有一个取值的 key 占比。
 */
export function selectPredicateStats(db: Db): PredicateStatRow[] {
  const rows = db
    .prepare(
      `WITH per_key AS (
         SELECT json_extract(attrs, '$.frozen.predicate') AS pred,
                canonical_key,
                COUNT(DISTINCT value_hash) AS v
         FROM fact
         WHERE epistemic_status IN ('active','disputed')
           AND json_extract(attrs, '$.frozen.predicate') IS NOT NULL
         GROUP BY pred, canonical_key
       )
       SELECT pred AS name,
              COUNT(*) AS keys,
              SUM(CASE WHEN v = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS single_ratio,
              SUM(v) AS value_occurrences
       FROM per_key GROUP BY pred
       ORDER BY pred ASC`,
    )
    .all() as { name: string; keys: number; single_ratio: number; value_occurrences: number }[];
  return rows.map((r) => ({
    name: r.name,
    keys: r.keys,
    singleRatio: r.single_ratio,
    valueOccurrences: r.value_occurrences,
  }));
}

/** 谓词的已登记基数性；未登记返回 null（调用方据此不判互斥） */
export function getPredicateCardinality(db: Db, predicate: string): Cardinality | null {
  const row = db
    .prepare("SELECT cardinality FROM ontology WHERE kind = 'predicate' AND name = ?")
    .get(predicate) as { cardinality: Cardinality | null } | undefined;
  return row?.cardinality ?? null;
}

/** 写回判定结果；registered_at 只在首次插入时生效（冲突更新保留原值） */
export function upsertPredicateStat(db: Db, input: UpsertPredicateStat): void {
  db.prepare(
    `INSERT INTO ontology (kind, name, value_type, cardinality, sample_count, distinct_values, single_ratio, registered_at, promoted)
     VALUES ('predicate', ?, NULL, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(kind, name) DO UPDATE SET
       cardinality = excluded.cardinality,
       sample_count = excluded.sample_count,
       distinct_values = excluded.distinct_values,
       single_ratio = excluded.single_ratio,
       promoted = 1`,
  ).run(input.name, input.cardinality, input.sampleCount, input.distinctValues, input.singleRatio, input.registeredAt);
}
