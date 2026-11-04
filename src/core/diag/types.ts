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
  /** 有人工改动痕迹的条数（human_edited 为 1 或 2） */
  human_edited: number;
  /** human_edited=1：有待合并提案、等人工三选一的条数（P2-19A 补） */
  proposed_pending: number;
  /** status 为 merged / split 的条数（合并/分裂只标记不删，P2-19A 补） */
  merged_or_split: number;
}

export interface DiagQualityJson {
  orphan_ratio: number | null;
  modularity: number | null;
  stale_chains: number;
  near_dup_ratio: number | null;
  key_entity_coverage: number | null;
  scope_leak: number;
  /**
   * 布局新鲜度：最近一次写入事实（fact.updated_at）比最近一次布局
   * （layout.computed_at）晚多少小时。正数 = 有写入尚未上屏；无布局记录为 null。
   */
  layout_freshness: number | null;
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
