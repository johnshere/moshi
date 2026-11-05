/**
 * 不变量 I1–I10 的布尔判定（P2-18 / 详设 §2.4）。
 *
 * 纯函数：只吃 `diagRepo` 采到的原始计数，不碰数据库。这样单测可以精确构造
 * "哪一项坏掉"，也保证 doctor / HTTP 两处用同一套口径，不会一个说绿一个说红。
 */
import type { InvariantId, InvariantMap } from './types.js';
import { INVARIANT_IDS } from './types.js';

export interface InvariantInputs {
  content_audit_rows: number;
  frozen_trigger: boolean;
  duplicate_identities: number;
  duplicate_active_edges: number;
  active_status_violations: number;
  invalidated_without_valid_to: number;
  degree_mismatch: number;
  supersedes_violations: number;
  fts_rows: number | null;
  vec_rows: number | null;
  fact_rows: number;
  vector_disabled: boolean;
  confidence_audit_sample: { checked: number; missing: number };
}

/**
 * I9 的口径：FTS 行数必须与 fact 行数一致；向量路若被标记降级（sqlite-vec
 * 缺席 / 无 sidecar），只要求"没有假装索引过"，不要求行数相等。
 * `fact_vec` 在但 0 行 = 从未编码过（扩展在、sidecar 不在）：同样没有假装索引，
 * 按降级处理（退出码 4 由 indexes.vec='stale' 给出），不算不变量失败。
 */
function indexRowsConsistent(input: InvariantInputs): boolean {
  if (input.fts_rows === null || input.fts_rows !== input.fact_rows) return false;
  if (input.vector_disabled) return input.vec_rows === null;
  if (input.vec_rows === 0) return true;
  return input.vec_rows !== null && input.vec_rows === input.fact_rows;
}

export function evaluateInvariants(input: InvariantInputs): InvariantMap {
  return {
    I1: input.content_audit_rows === 0,
    I2: input.frozen_trigger,
    I3: input.duplicate_identities === 0,
    I4: input.duplicate_active_edges === 0,
    I5: input.active_status_violations === 0,
    I6: input.invalidated_without_valid_to === 0,
    I7: input.degree_mismatch === 0,
    I8: input.supersedes_violations === 0,
    I9: indexRowsConsistent(input),
    I10: input.confidence_audit_sample.checked === 0 || input.confidence_audit_sample.missing === 0,
  };
}

export function invariantFailures(invariants: InvariantMap): InvariantId[] {
  return INVARIANT_IDS.filter((id) => !invariants[id]);
}

export function invariantsAllGreen(invariants: InvariantMap): boolean {
  return invariantFailures(invariants).length === 0;
}
