/**
 * 子图构建与预算裁剪（详设 §6.6）。
 *
 * 从融合结果取前 8 条做种子，BFS 2 跳扩展（上限 64 节点），边上限 192
 * （两端都在集合内优先）。邻居扩展优先级（硬顺序）：
 * `mutually_exclusive > depends_on > supersedes > logic > co_occur > derived_from`，
 * 同级按 edge.confidence 降序。节点排序全序：
 * `(isSeed desc, fusedRank asc, degree desc, id asc)`——稳定性硬要求（§6.6 原话），
 * 同一输入两次运行产出必须一致。
 *
 * 本模块只产节点/边集合；§4.5 的 394 维特征拼接（embedding/one-hot）是
 * 子图 JSON 组装层的事（P2/P3 GAT 用），不在这里做。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { neighbors } from '../../infra/sqlite/edgeRepo.js';
import { getFact } from '../../infra/sqlite/factRepo.js';
import type { Etype } from '../../domain/enums.js';

export interface SubgraphNode {
  fact_id: string;
  /** 融合排名（0 = 种子第一名）；非种子为 null */
  fusedRank: number | null;
  degree: number;
  isSeed: boolean;
}

export interface SubgraphEdge {
  src: string;
  dst: string;
  etype: Etype;
  weight: number;
  confidence: number;
}

export interface Subgraph {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

const MAX_NODES = 64;
const MAX_EDGES = 192;
const SEED_LIMIT = 8;

/** 邻居扩展优先级（§6.6 硬顺序） */
const ETYPE_ORDER: readonly Etype[] = ['mutually_exclusive', 'depends_on', 'supersedes', 'logic', 'co_occur', 'derived_from'];
const ETYPE_RANK = new Map<Etype, number>(ETYPE_ORDER.map((e, i) => [e, i]));

export function buildSubgraph(db: Db, fusedIds: readonly string[], opts: { maxNodes?: number; maxEdges?: number; seedLimit?: number } = {}): Subgraph {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const maxEdges = opts.maxEdges ?? MAX_EDGES;
  const seedLimit = opts.seedLimit ?? SEED_LIMIT;

  const seeds = fusedIds.slice(0, seedLimit);
  const rankOf = new Map<string, number>(fusedIds.map((id, i) => [id, i]));

  // ── 1) BFS 2 跳收集节点（种子在前，上限 maxNodes）──
  const order: string[] = [...seeds];
  const inSet = new Set<string>(seeds);
  const seenEdge = new Set<string>();
  const edges: SubgraphEdge[] = [];

  let frontier = [...seeds];
  for (let hop = 0; hop < 2; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      // 邻居按 (etype 优先级, confidence 降序) 排序后扩展
      const ns = neighbors(db, id, { limit: 400 })
        .sort((a, b) => ETYPE_RANK.get(a.etype)! - ETYPE_RANK.get(b.etype)! || (b.confidence ?? 0) - (a.confidence ?? 0));
      for (const e of ns) {
        const other = e.src === id ? e.dst : e.src;
        // 边候选记录（去重：同 (min,max,etype) 只留一条）
        const key = [e.src, e.dst].sort().join('|') + `|${e.etype}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          edges.push({ src: e.src, dst: e.dst, etype: e.etype, weight: e.weight, confidence: e.confidence ?? 0.9 });
        }
        if (inSet.has(other)) continue;
        if (order.length >= maxNodes) break;
        inSet.add(other);
        order.push(other);
        next.push(other);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // ── 2) 边裁剪：两端都在集合内优先，上限 maxEdges ──
  const inside: SubgraphEdge[] = [];
  const outside: SubgraphEdge[] = [];
  for (const e of edges) {
    (inSet.has(e.src) && inSet.has(e.dst) ? inside : outside).push(e);
  }
  const picked = inside.concat(outside).slice(0, maxEdges);

  // ── 3) 节点全序排序：(isSeed desc, fusedRank asc, degree desc, id asc) ──
  const degCache = new Map<string, number>();
  const degreeOf = (id: string): number => {
    let d = degCache.get(id);
    if (d === undefined) {
      const f = getFact(db, id);
      d = f?.degree ?? 0;
      degCache.set(id, d);
    }
    return d;
  };

  const nodes: SubgraphNode[] = order
    .map((fact_id) => ({
      fact_id,
      fusedRank: rankOf.has(fact_id) ? rankOf.get(fact_id)! : null,
      degree: degreeOf(fact_id),
      isSeed: rankOf.has(fact_id),
    }))
    .sort((a, b) => {
      if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
      const ra = a.fusedRank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.fusedRank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      if (a.degree !== b.degree) return b.degree - a.degree;
      return a.fact_id < b.fact_id ? -1 : 1;
    });

  return { nodes, edges: picked };
}
