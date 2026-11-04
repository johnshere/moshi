/**
 * 自检页的对外类型（P2-18 / 详设 §11.4）。
 *
 * 这些类型既是 `GET /api/diag` 的响应契约，也是 `moshi doctor` 与
 * `DiagPanel` 的共用口径——三处必须逐字段一致，改字段先改这里。
 */

export type InvariantId =
  | 'I1'
  | 'I2'
  | 'I3'
  | 'I4'
  | 'I5'
  | 'I6'
  | 'I7'
  | 'I8'
  | 'I9'
  | 'I10';

export const INVARIANT_IDS: readonly InvariantId[] = [
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'I6',
  'I7',
  'I8',
  'I9',
  'I10',
];

export type InvariantMap = Record<InvariantId, boolean>;

export interface DiagDbJson {
  integrity: string;
  user_version: number;
  size_mb: number | null;
  wal_mb: number | null;
}

export type IndexState = 'ok' | 'off' | 'stale' | 'missing';

export interface DiagIndexesJson {
  fts: IndexState;
  vec: IndexState;
  degree_mismatch: number;
}

export interface DiagModelJson {
  embed: string;
  gat: 'off' | 'shadow' | 'on';
  /** GAT 权重文件是否存在（存在不代表已启用） */
  weights: boolean;
}

export interface DiagArchiveJson {
  topics: number;
  dirty: number;
  human_edited: number;
}

export interface DiagQualityJson {
  orphan_ratio: number | null;
  modularity: number | null;
  stale_chains: number;
  near_dup_ratio: number | null;
  key_entity_coverage: number | null;
  scope_leak: number;
}

export interface DiagEvalJson {
  at: string;
  passed: number;
  total: number;
  blocking_failures: number;
}

export interface DiagReport {
  db: DiagDbJson;
  indexes: DiagIndexesJson;
  invariants: InvariantMap;
  model: DiagModelJson;
  archive: DiagArchiveJson;
  quality: DiagQualityJson;
  last_harvest_at: string | null;
  last_eval: DiagEvalJson | null;
}
