/**
 * schema infer（详设 §8.5；台账 P1-14）。
 *
 * 统计谓词基数性并写回 `ontology(kind='predicate')`，判定表：
 *   single_ratio ≥ 0.90 且 key_count ≥ 20           → single-valued
 *   single_ratio < 0.30 且 value_occurrences > 50   → series
 *   其余                                              → set
 *   key_count < 20                                    → 不判定（observe，保留旧值）
 *
 * 这是互斥爆炸的解药（D9）：single-valued 谓词下同一 canonical_key 的多条事实
 * 才是互斥候选；判定阈值是抽样噪声平衡点，不要随手改。
 * 只在 active/disputed 事实内统计；写回时保留 registered_at，promoted=1。
 */
import type { Db } from '../../infra/sqlite/db.js';
import type { Cardinality } from '../../domain/enums.js';
import { selectPredicateStats, upsertPredicateStat } from '../../infra/sqlite/ontologyRepo.js';
import { nowIso } from '../../domain/time.js';

export type PredicateCardinality = Cardinality;

export interface PredicateRow {
  name: string;
  keys: number;
  single_ratio: number;
  value_occurrences: number;
  cardinality: PredicateCardinality | null;
  action: 'keep' | 'promote' | 'observe';
}

export interface SchemaInferResult {
  predicates: PredicateRow[];
  attr_keys: never[];
}

const SINGLE_RATIO_MIN = 0.9;
const KEY_COUNT_MIN = 20;
const SERIES_RATIO_MAX = 0.3;
const SERIES_OCCURRENCES_MIN = 50;

export function runSchemaInfer(db: Db, opts: { now?: string; dryRun?: boolean } = {}): SchemaInferResult {
  const now = opts.now ?? nowIso();
  const rows = selectPredicateStats(db);

  const predicates: PredicateRow[] = rows.map((r) => {
    if (r.keys < KEY_COUNT_MIN) {
      return { name: r.name, keys: r.keys, single_ratio: r.singleRatio, value_occurrences: r.valueOccurrences, cardinality: null, action: 'observe' };
    }
    let cardinality: PredicateCardinality;
    let action: 'keep' | 'promote';
    if (r.singleRatio >= SINGLE_RATIO_MIN) {
      cardinality = 'single-valued';
      action = 'keep';
    } else if (r.singleRatio < SERIES_RATIO_MAX && r.valueOccurrences > SERIES_OCCURRENCES_MIN) {
      cardinality = 'series';
      action = 'promote';
    } else {
      cardinality = 'set';
      action = 'promote';
    }
    return { name: r.name, keys: r.keys, single_ratio: r.singleRatio, value_occurrences: r.valueOccurrences, cardinality, action };
  });

  // 写回 ontology（registered_at 只在首次插入生效，promoted=1；observe 不写回）
  // dryRun 只跳过写库，判定结果照常返回（CLI `--dry-run` / 预览用）
  if (opts.dryRun !== true) {
    for (const p of predicates) {
      if (p.cardinality === null) continue;
      upsertPredicateStat(db, {
        name: p.name,
        cardinality: p.cardinality,
        sampleCount: p.keys,
        distinctValues: p.value_occurrences,
        singleRatio: p.single_ratio,
        registeredAt: now,
      });
    }
  }

  return { predicates, attr_keys: [] };
}
