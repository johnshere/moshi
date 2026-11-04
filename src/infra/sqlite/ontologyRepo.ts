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

/** 可参与 schema 校验的 ontology 行（etype 行不参与 attrs 校验） */
export type OntologyKeyKind = 'predicate' | 'attr_key';

export interface OntologyKeyRow {
  kind: OntologyKeyKind;
  name: string;
  /** DDL 词汇：string|number|bool|time|enum|json；NULL = 未定类型 */
  valueType: string | null;
  cardinality: Cardinality | null;
  sampleCount: number;
  /** 1 = 已登记（schema 校验会约束它）；0 = 待晋升线索 */
  promoted: boolean;
}

interface OntologyKeyRecord {
  kind: OntologyKeyKind;
  name: string;
  value_type: string | null;
  cardinality: Cardinality | null;
  sample_count: number;
  promoted: number;
}

/** 列出 predicate / attr_key 的 ontology 行（含待晋升的 promoted=0 行） */
export function listOntologyKeys(db: Db): OntologyKeyRow[] {
  const rows = db
    .prepare(
      `SELECT kind, name, value_type, cardinality, sample_count, promoted
         FROM ontology
        WHERE kind IN ('predicate', 'attr_key')
        ORDER BY kind ASC, name ASC`,
    )
    .all() as OntologyKeyRecord[];
  return rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    valueType: r.value_type,
    cardinality: r.cardinality,
    sampleCount: r.sample_count,
    promoted: r.promoted === 1,
  }));
}

/** 已登记（promoted=1）的键定义，写通路校验用 */
export function loadRegisteredKeys(
  db: Db,
): { kind: OntologyKeyKind; name: string; valueType: string | null; cardinality: Cardinality | null }[] {
  return listOntologyKeys(db)
    .filter((row) => row.promoted)
    .map((row) => ({
      kind: row.kind,
      name: row.name,
      valueType: row.valueType,
      cardinality: row.cardinality,
    }));
}

export interface PendingKeyInsert {
  kind: OntologyKeyKind;
  name: string;
  valueType: string | null;
}

/**
 * 记一次「未登记键」的观测（待晋升线索，不建新表）。
 *
 * - 首次出现：插 promoted=0 行（schema 校验不会约束它，符合「未登记放行」）。
 * - 再次出现：`sample_count + 1`，value_type 不覆盖已推断出的值。
 * - 若该键后来被 infer 晋升（promoted=1），这里不会把 promoted 打回 0。
 */
export function recordPendingKeys(db: Db, entries: readonly PendingKeyInsert[], now: string): void {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO ontology (kind, name, value_type, cardinality, sample_count, distinct_values, single_ratio, registered_at, promoted)
     VALUES (?, ?, ?, NULL, 1, 0, NULL, ?, 0)
     ON CONFLICT(kind, name) DO UPDATE SET
       sample_count = sample_count + 1,
       value_type = COALESCE(value_type, excluded.value_type)`,
  );
  for (const entry of entries) stmt.run(entry.kind, entry.name, entry.valueType, now);
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
