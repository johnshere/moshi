/**
 * PPR 图扩散（详设 §6.4.3）。
 *
 * 只在**候选子图内**跑（概设 §4.5 硬约束）：从种子 fact_id 出发 BFS 2 跳
 * 收集节点（上限 ppr_max_nodes=400，边只走活跃 valid_to IS NULL），在收集到的
 * 节点上做 Personalized PageRank。返回 p 的 top-k（缺省 20，排除种子；读路径按
 * 召回超取倍数放大，见 search.ts RECALL_OVERFETCH）。
 *
 * 性能预算 7ms：超时返回**当前结果**（已迭代部分收敛的 p）+ `timedOut:true`，
 * 由上层标 `degraded:["no_ppr"]`。绝不抛错中断整条查询链。
 */
import type { Db } from '../../../infra/sqlite/db.js';
import { neighbors } from '../../../infra/sqlite/edgeRepo.js';
import type { Etype } from '../../../domain/enums.js';

/** 边类型 → 扩散权重（详设 §6.4.3） */
export const EDGE_WEIGHT: Readonly<Record<Etype, number>> = {
  depends_on: 1.0,
  mutually_exclusive: 1.0,
  logic: 0.8,
  supersedes: 0.6,
  co_occur: 0.4,
  derived_from: 0.0, // 派生边不作为扩散通道（进 BFS 但权重为 0，等同不扩散）
};

export interface PprOptions {
  maxNodes?: number;
  maxIter?: number;
  timeoutMs?: number;
  d?: number;
  eps?: number;
  now?: () => number;
  /** 返回条数上限（默认 20）。读路径按召回超取倍数放大，过滤后再截断。 */
  k?: number;
}

export interface PprResult {
  /** 非种子节点，按 p 降序，最多 k 条（默认 20） */
  ids: string[];
  scores: number[];
  /** 超预算：调用方应标 degraded:["no_ppr"]（结果仍可用） */
  timedOut: boolean;
  /** 实际收集的子图大小（0 = 无邻居可扩散，结果为空） */
  nodes: number;
}

const DEFAULT = { maxNodes: 400, maxIter: 20, timeoutMs: 7, d: 0.85, eps: 1e-4, k: 20 };

export function recallPpr(db: Db, seedIds: readonly string[], opts: PprOptions = {}): PprResult {
  const maxNodes = opts.maxNodes ?? DEFAULT.maxNodes;
  const maxIter = opts.maxIter ?? DEFAULT.maxIter;
  const timeoutMs = opts.timeoutMs ?? DEFAULT.timeoutMs;
  const d = opts.d ?? DEFAULT.d;
  const eps = opts.eps ?? DEFAULT.eps;
  const k = opts.k ?? DEFAULT.k;
  const now = opts.now ?? Date.now;

  const t0 = now();
  const timedOutCheck = (): boolean => now() - t0 > timeoutMs;

  if (seedIds.length === 0) return { ids: [], scores: [], timedOut: false, nodes: 0 };

  let timedOut = false;

  // 超时返回当前已收集的子图（无扩散结果）：ids 空 + timedOut=true，
  // 上层据此标 degraded:["no_ppr"]，结果由其他召回路兜底（§6.4.3）。
  const partialResult = (): PprResult => ({ ids: [], scores: [], timedOut: true, nodes: order.length });

  // ── 1) BFS 2 跳收集候选子图（节点序：种子在前 → BFS 序，稳定可复现）──
  const order: string[] = [...seedIds];
  const index = new Map<string, number>();
  seedIds.forEach((id, i) => index.set(id, i));

  let frontier = [...seedIds];
  for (let hop = 0; hop < 2; hop += 1) {
    if (timedOutCheck()) {
      timedOut = true;
      break;
    }
    const next: string[] = [];
    for (const id of frontier) {
      if (timedOutCheck()) {
        timedOut = true;
        break;
      }
      for (const e of neighbors(db, id)) {
        // 边权重为 0 的通道不扩散（derived_from）
        if (EDGE_WEIGHT[e.etype] <= 0) continue;
        const other = e.src === id ? e.dst : e.src;
        if (index.has(other)) continue;
        if (order.length >= maxNodes) break;
        index.set(other, order.length);
        order.push(other);
        next.push(other);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const n = order.length;
  if (n <= seedIds.length) return { ids: [], scores: [], timedOut, nodes: n };

  // ── 2) 稀疏邻接：A[i][j] = weight（双向）──
  // 用 Map<i, Map<j, w>> 累加（同节点对可能多条边，取最大权重）
  const adj = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i += 1) {
    if (timedOutCheck()) return partialResult();
    const id = order[i]!;
    for (const e of neighbors(db, id)) {
      const w = EDGE_WEIGHT[e.etype];
      if (w <= 0) continue;
      const j = index.get(e.src === id ? e.dst : e.src);
      if (j === undefined || j === i) continue;
      const row = adj.get(i) ?? new Map();
      const cur = row.get(j) ?? 0;
      if (w > cur) row.set(j, w);
      adj.set(i, row);
    }
  }

  // ── 3) 初始化 p：均匀分布，seed 权重 3 倍后归一 ──
  const p = new Float64Array(n).fill(1);
  for (let i = 0; i < seedIds.length; i += 1) p[i] = 3;
  const total = p.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i += 1) p[i] = p[i]! / total;

  // A 行归一（M[i][j] = w_ij / Σ_k w_ik）
  const rowSum = new Float64Array(n);
  for (const [i, row] of adj) {
    let s = 0;
    for (const w of row.values()) s += w;
    rowSum[i] = s;
  }

  // ── 4) 迭代：p_new = (1-d)/N + d * M^T · p ──
  const base = (1 - d) / n;
  const pNew = new Float64Array(n);
  for (let iter = 0; iter < maxIter; iter += 1) {
    if (timedOutCheck()) {
      timedOut = true;
      break;
    }
    pNew.fill(base);
    for (const [i, row] of adj) {
      const pi = p[i]!;
      if (pi === 0) continue;
      const s = rowSum[i]!;
      if (s === 0) continue;
      for (const [j, w] of row) pNew[j] = pNew[j]! + (d * pi * w) / s;
    }
    // 收敛判定：||p_new - p||₁ < eps
    let diff = 0;
    for (let i = 0; i < n; i += 1) diff += Math.abs(pNew[i]! - p[i]!);
    p.set(pNew);
    if (diff < eps) break;
  }

  // ── 5) top-k（排除种子；k 缺省 20，读路径按超取放大）──
  const nonSeed: { id: string; score: number }[] = [];
  for (let i = seedIds.length; i < n; i += 1) {
    if (p[i]! > 0) nonSeed.push({ id: order[i]!, score: p[i]! });
  }
  nonSeed.sort((a, b) => b.score - a.score);
  const top = nonSeed.slice(0, k);
  return { ids: top.map((x) => x.id), scores: top.map((x) => x.score), timedOut, nodes: n };
}
