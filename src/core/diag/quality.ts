/**
 * 图质量六项里需要应用层计算的部分（P2-18 / 详设 §2.10）。
 *
 * 纯函数：模块度只吃社区规模 + 度数 + 内部边数；近似重复比只吃候选对的向量。
 * SQL 取原始量，这里只做公式，保证 HTTP 与 CLI 口径一致、单测能钉死数值。
 */
import type { DiagCommunityStat } from '../../infra/sqlite/diagRepo.js';

/** 保留 4 位小数：自检页展示用，避免浮点尾差让快照抖动 */
export function round4(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10000) / 10000;
}

/**
 * 模块度 Q = Σ_c [ L_c/m − (k_c/2m)² ]。
 *
 * 只在"两端都有社区"的活跃边子图上算（m = community_edge_count）；
 * 没有活跃边时模块度无定义，返回 null（前端显示"—"）。
 */
export function computeModularity(input: {
  communities: readonly DiagCommunityStat[];
  edge_count: number;
}): number | null {
  const m = input.edge_count;
  if (m <= 0) return null;
  let q = 0;
  for (const community of input.communities) {
    q += community.internal_edges / m - (community.degree / (2 * m)) ** 2;
  }
  return round4(q);
}

/** 余弦相似度；向量缺失/维度不一致由调用方判为"不可测" */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface NearDupVectorPair {
  a: Float32Array | null;
  b: Float32Array | null;
}

/**
 * 近似重复比 = 相似度 ≥ 阈值 的候选对 / 可测候选对。
 *
 * 任何一对缺向量都返回 null（不拿"只测了一半"冒充全量结论）；
 * 候选对为空则返回 0（确实没有"同 key 不同值"的对）。
 */
export function computeNearDupRatio(
  pairs: readonly NearDupVectorPair[],
  threshold = 0.95,
): number | null {
  if (pairs.length === 0) return 0;
  let measured = 0;
  let near = 0;
  for (const pair of pairs) {
    const { a, b } = pair;
    if (a === null || b === null || a.length !== b.length) return null;
    measured += 1;
    if (cosineSimilarity(a, b) >= threshold) near += 1;
  }
  return measured === 0 ? 0 : round4(near / measured);
}
