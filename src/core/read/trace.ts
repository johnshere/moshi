/**
 * 证据链回放（P2-24，详设 §4.7 schema `moshi-trace/1`）。
 *
 * 一次查询除了「答案」还留下「怎么走到答案」：种子是谁、每条入包事实从种子出发
 * 走了几跳、沿哪几条边、边上带多少 PPR 扩散质量。前端 `/ui/graph` 用这份 trace
 * 做证据链动画（P2-25），所以字段名必须与详设 §4.7 逐字对齐，**不能自造**。
 *
 * 三条纪律：
 * 1. **纯内存、不落库**：TraceStore 是容量 64 的 ring buffer（§4.7 / D-118 不加
 *    SSE/WebSocket，靠前端轮询 `GET /api/trace/:query_id`）。查询日志已落
 *    `query_log`，trace 只服务「刚发生的那次查询」，重启即丢是刻意的。
 * 2. **采集尽力而为**：`collectTrace` 只读已建好的子图边 + PPR 种子邻边，
 *    绝不因为 trace 采集失败而中断读取链；调用方用 try/catch 兜住（search.ts）。
 * 3. **不伪造边**：路径重建不出来时（入包节点只经裁决/邻居兜底进来），hop 记 2
 *    但 path/edge_mass 留空——宁可缺，不可编。
 *
 * edge_mass 的口径（§4.7）：PPR 沿边 `i→j` 的扩散份额 `p_i * w_ij / rowSum_i`，
 * 归一到 0–1；非 PPR 来源恒 0。`p_i` 优先取 PPR 返回的精确值（种子按
 * `3 / (3S + (N-S))` 初始化值、top-20 取 `scores`），取不到时用沿路径流入份额
 * 近似——**这是本模块唯一的近似**，其它（跳数、边序列）都是精确重建。
 *
 * 本层不碰裸 SQL（K2）：邻边走 `infra/sqlite/edgeRepo.neighbors`，与 ppr.ts 同路。
 */
import type { Etype } from '../../domain/enums.js';
import type { Db } from '../../infra/sqlite/db.js';
import { neighbors } from '../../infra/sqlite/edgeRepo.js';
import { EDGE_WEIGHT, type PprResult } from './recall/ppr.js';
import type { SubgraphEdge } from './subgraph.js';

/** trace schema 版本（§4.7 原样，改动必须升版本） */
export const TRACE_SCHEMA = 'moshi-trace/1' as const;

/** ring buffer 容量（§4.7：最近 64 次查询） */
export const TRACE_CAPACITY = 64;

/** 路径上的一条边；mass 与 result.edge_mass 同序同值（§4.7 示例两处都给） */
export interface TraceEdge {
  src: string;
  dst: string;
  etype: Etype;
  /** PPR 扩散份额 p_i*w_ij/rowSum_i，0–1；非 PPR 来源为 0 */
  mass: number;
}

export interface TraceResult {
  fact_id: string;
  /** 0 = 直击命中（向量/BM25 直接召回，未沿边）；≥1 = 从种子出发的跳数 */
  hop: number;
  path: TraceEdge[];
  /** 与 path 逐项同值的扁平平铺，前端画 aFlow 用（§4.7） */
  edge_mass: number[];
  /** 融合（§6.5）排名，1-based；未进融合为 null */
  fused_rank: number | null;
  /** 符号排序：证据包内 1-based 位置；模型未生效时 == rank_final */
  rank_symbolic: number;
  /** 最终排序；模型未生效时 == rank_symbolic（§4.7 硬约束） */
  rank_final: number;
}

export interface TraceRecord {
  schema: typeof TRACE_SCHEMA;
  query_id: string;
  /** epoch 毫秒（不是 ISO——§4.7 示例就是数字） */
  ts: number;
  /** 扩展字段：§4.7 只规定 local 链路，global 也记一条空 results 的 trace，
   *  前端据此把「这个话题概览是怎么来的」也回放成一次查询（P2-25 需要）。 */
  route: 'local' | 'global';
  model_mode: 'off' | 'shadow' | 'on';
  /** 模型版本（P3 接入 GAT 后填）；无模型恒 null */
  model_version: string | null;
  source: 'symbolic' | 'gat';
  /** 检索起点：向量 ∪ BM25 直击命中（PPR 种子 ⊆ 直击，故不单列） */
  seeds: string[];
  results: TraceResult[];
}

/** 采集注入点：search.ts 只依赖 put，TraceStore 是默认实现 */
export interface TraceSink {
  put(record: TraceRecord): void;
}

export interface TraceStoreOptions {
  /** 容量；缺省 64。非法值回落 64 */
  capacity?: number;
}

/**
 * 最近 N 次查询的 ring buffer（纯内存，无 db 句柄）。
 *
 * 用 Map 的插入序当 FIFO：put 已存在的 query_id 先删再插（重放同一次查询仍按
 * 「最近」算）；超容淘汰最旧。list() 旧→新，recent() 新→旧。
 */
export class TraceStore implements TraceSink {
  private readonly capacity: number;
  private readonly records = new Map<string, TraceRecord>();

  constructor(opts: TraceStoreOptions = {}) {
    const cap = Math.floor(opts.capacity ?? TRACE_CAPACITY);
    this.capacity = Number.isFinite(cap) && cap >= 1 ? cap : TRACE_CAPACITY;
  }

  get size(): number {
    return this.records.size;
  }

  put(record: TraceRecord): void {
    if (this.records.has(record.query_id)) this.records.delete(record.query_id);
    this.records.set(record.query_id, record);
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) break;
      this.records.delete(oldest.value);
    }
  }

  get(queryId: string): TraceRecord | null {
    return this.records.get(queryId) ?? null;
  }

  /** 旧 → 新（调试/测试用；HTTP 列表走 recent） */
  list(): TraceRecord[] {
    return [...this.records.values()];
  }

  /** 新 → 旧，最多 limit 条；limit 夹在 1..capacity */
  recent(limit: number = 20): TraceRecord[] {
    const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), this.capacity) : 20;
    return [...this.records.values()].slice(-n).reverse();
  }

  reset(): void {
    this.records.clear();
  }
}

export interface TraceResultInput {
  fact_id: string;
  hop: number;
  path?: readonly TraceEdge[];
  fused_rank?: number | null;
  rank_symbolic: number;
  /** 模型生效时由 GAT 排序给出；未生效时忽略（强制 = rank_symbolic） */
  rank_final?: number;
}

export interface TraceInput {
  queryId: string;
  ts: number;
  route?: 'local' | 'global';
  modelMode?: 'off' | 'shadow' | 'on';
  modelVersion?: string | null;
  seeds?: readonly string[];
  results?: readonly TraceResultInput[];
}

function clampMass(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(1, Math.max(0, value));
  // 6 位小数：JSON 里干净，且与前端 aMass 的精度需求匹配
  return Math.round(clamped * 1e6) / 1e6;
}

/**
 * 组装一条 trace（纯函数，无 db/IO）：规范化 path/edge_mass、去重 seeds，
 * 并强制「模型未生效 ⇒ source=symbolic 且 rank_symbolic == rank_final」。
 */
export function buildTrace(input: TraceInput): TraceRecord {
  const modelMode = input.modelMode ?? 'off';
  // Phase 2 只有符号通路（P3 才接 GAT）；'shadow' 不参与排序，故也不算生效
  const modelEffective = modelMode === 'on';
  const results: TraceResult[] = (input.results ?? []).map((r) => {
    const hop = Number.isFinite(r.hop) ? Math.max(0, Math.trunc(r.hop)) : 0;
    const path: TraceEdge[] =
      hop === 0
        ? []
        : (r.path ?? []).map((e) => ({ src: e.src, dst: e.dst, etype: e.etype, mass: clampMass(e.mass) }));
    return {
      fact_id: r.fact_id,
      hop,
      path,
      edge_mass: path.map((e) => e.mass),
      fused_rank: r.fused_rank ?? null,
      rank_symbolic: r.rank_symbolic,
      rank_final: modelEffective ? (r.rank_final ?? r.rank_symbolic) : r.rank_symbolic,
    };
  });
  return {
    schema: TRACE_SCHEMA,
    query_id: input.queryId,
    ts: input.ts,
    route: input.route ?? 'local',
    model_mode: modelMode,
    model_version: input.modelVersion ?? null,
    source: modelEffective ? 'gat' : 'symbolic',
    seeds: [...new Set(input.seeds ?? [])],
    results,
  };
}

interface AdjEntry {
  to: string;
  etype: Etype;
  /** PPR 扩散权重（EDGE_WEIGHT，不是 edge.weight 列） */
  w: number;
}

type Adjacency = Map<string, Map<string, AdjEntry>>;

function buildAdjacency(
  db: Db,
  subEdges: readonly SubgraphEdge[],
  pprSeeds: readonly string[],
): Adjacency {
  const adj: Adjacency = new Map();
  const add = (src: string, dst: string, etype: Etype, w: number): void => {
    if (src === dst) return;
    const pairs: ReadonlyArray<readonly [string, string]> = [
      [src, dst],
      [dst, src],
    ];
    for (const [a, b] of pairs) {
      let row = adj.get(a);
      if (row === undefined) {
        row = new Map();
        adj.set(a, row);
      }
      const cur = row.get(b);
      // 同节点对多条边：取最大扩散权重（与 ppr.ts 的邻接口径一致）
      if (cur === undefined || w > cur.w) row.set(b, { to: b, etype, w });
    }
  };

  // 子图边（§6.6 已建好）：正常查询里路径都在这上面
  for (const e of subEdges) add(e.src, e.dst, e.etype, EDGE_WEIGHT[e.etype]);

  // 子图只从融合前 8 名展开；PPR 种子若排在其后，它的邻边不在 sub.edges 里，
  // hop=1 的路径会重建不出来。补一层种子邻边（≤3 次 neighbors，代价可忽略）。
  for (const seed of pprSeeds) {
    for (const e of neighbors(db, seed)) add(e.src, e.dst, e.etype, EDGE_WEIGHT[e.etype]);
  }
  return adj;
}

interface Walk {
  prev: string | null;
  edge: TraceEdge | null;
  depth: number;
  /** 路径权重乘积，同跳数时取最大（确定性见下方排序） */
  score: number;
}

/**
 * 从 startIds 出发找 target 的最短路径（≤maxHop 跳），同跳数取权重乘积最大，
 * 再按邻居字典序打破平局 → 同一输入两次运行结果必须一致（§6.6 的稳定性要求）。
 * 返回边的方向按「扩散方向」排列（seed → … → target），不是 DB 里边的原始朝向。
 */
function findPath(
  adj: Adjacency,
  startIds: readonly string[],
  target: string,
  maxHop: number,
): TraceEdge[] | null {
  if (startIds.length === 0) return null;
  if (startIds.includes(target)) return [];

  const best = new Map<string, Walk>();
  for (const s of startIds) best.set(s, { prev: null, edge: null, depth: 0, score: 1 });

  let frontier = [...new Set(startIds)];
  for (let depth = 1; depth <= maxHop; depth += 1) {
    const next: string[] = [];
    for (const cur of frontier) {
      const walk = best.get(cur);
      if (walk === undefined) continue;
      const row = adj.get(cur);
      if (row === undefined) continue;
      const entries = [...row.values()].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
      for (const entry of entries) {
        const score = walk.score * (entry.w > 0 ? entry.w : 1e-9);
        const edge: TraceEdge = { src: cur, dst: entry.to, etype: entry.etype, mass: 0 };
        const curBest = best.get(entry.to);
        if (curBest === undefined) {
          best.set(entry.to, { prev: cur, edge, depth, score });
          next.push(entry.to);
        } else if (curBest.depth === depth && score > curBest.score) {
          best.set(entry.to, { prev: cur, edge, depth, score });
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  const hit = best.get(target);
  if (hit === undefined || hit.depth === 0) return null;
  const path: TraceEdge[] = [];
  let node = target;
  for (;;) {
    const walk = best.get(node);
    if (walk === undefined || walk.edge === null) break;
    path.push(walk.edge);
    if (walk.prev === null) break;
    node = walk.prev;
  }
  path.reverse();
  return path;
}

interface PprMassContext {
  /** 种子初始化概率 3/(3S+(N-S))；无 PPR 子图时为 0 */
  seedP: number;
  seedSet: ReadonlySet<string>;
  scoreOf: ReadonlyMap<string, number>;
  rowSumOf: (node: string) => number;
}

function massContext(
  ppr: PprResult | null,
  pprSeeds: readonly string[],
  adj: Adjacency,
): PprMassContext {
  const s = pprSeeds.length;
  const n = ppr?.nodes ?? 0;
  const seedP = n > 0 && s > 0 ? 3 / (3 * s + (n - s)) : 0;
  const seedSet = new Set(pprSeeds);
  const scoreOf = new Map<string, number>();
  if (ppr !== null) {
    ppr.ids.forEach((id, i) => {
      const score = ppr.scores[i];
      if (score !== undefined) scoreOf.set(id, score);
    });
  }
  const rowSumOf = (node: string): number => {
    const row = adj.get(node);
    if (row === undefined) return 0;
    let sum = 0;
    for (const e of row.values()) sum += e.w;
    return sum;
  };
  return { seedP, seedSet, scoreOf, rowSumOf };
}

/** 给一条 PPR 路径逐边填 mass（原地改）。首边起点是种子（p 精确），
 *  中间节点优先用 PPR 精确分数，取不到时用流入份额近似（模块头已声明）。 */
function fillPprMasses(path: readonly TraceEdge[], ctx: PprMassContext): void {
  let incoming: number | null = null;
  for (const edge of path) {
    const p = ctx.seedSet.has(edge.src)
      ? ctx.seedP
      : (ctx.scoreOf.get(edge.src) ?? incoming ?? ctx.seedP);
    const rowSum = ctx.rowSumOf(edge.src);
    const w = EDGE_WEIGHT[edge.etype];
    edge.mass = rowSum > 0 ? clampMass((p * w) / rowSum) : 0;
    incoming = edge.mass;
  }
}

export interface PackedTraceSeed {
  fact_id: string;
  /** 证据包内 1-based 位置（== evidence.m_id） */
  rank: number;
  /** 融合排名（1-based）；未进融合为 null */
  fused_rank: number | null;
}

export interface TraceCollectInput {
  db: Db;
  queryId: string;
  ts: number;
  route?: 'local' | 'global';
  modelMode?: 'off' | 'shadow' | 'on';
  modelVersion?: string | null;
  /** 直击命中的并集（向量 ∪ BM25）：hop=0 的来源，也是路径搜索的起点集合 */
  directIds: readonly string[];
  /** PPR 种子（扩散起点，⊆ directIds；没有 PPR 时为空数组） */
  pprSeeds: readonly string[];
  /** PPR 结果；未跑/超时/无邻居传 null */
  ppr: PprResult | null;
  /** §6.6 已建好的子图边（不额外扫库，除非 ppr 种子不在子图里） */
  subEdges: readonly SubgraphEdge[];
  /** 入包结果（按证据包顺序） */
  packed: readonly PackedTraceSeed[];
}

/**
 * 从一次局部查询的现场采集 trace（只读 db 的邻边，不写任何东西）。
 * 采集本身不抛错：路径重建不出来时降级为空 path（见模块头第 3 条）。
 */
export function collectTrace(input: TraceCollectInput): TraceRecord {
  const directSet = new Set(input.directIds);
  const pprSet = new Set(input.ppr?.ids ?? []);
  const adj = buildAdjacency(input.db, input.subEdges, input.pprSeeds);
  const ctx = massContext(input.ppr, input.pprSeeds, adj);

  const results: TraceResultInput[] = input.packed.map((item) => {
    if (directSet.has(item.fact_id)) {
      return {
        fact_id: item.fact_id,
        hop: 0,
        path: [],
        fused_rank: item.fused_rank,
        rank_symbolic: item.rank,
      };
    }

    const isPpr = pprSet.has(item.fact_id);
    let path: TraceEdge[] | null = null;
    let fromPpr = false;
    if (isPpr) {
      path = findPath(adj, input.pprSeeds, item.fact_id, 2);
      fromPpr = path !== null;
    }
    if (path === null) path = findPath(adj, input.directIds, item.fact_id, 2);
    if (path === null || path.length === 0) {
      // 入包节点只经裁决/邻居兜底进来（不在召回并集里）：不伪造边
      return {
        fact_id: item.fact_id,
        hop: 2,
        path: [],
        fused_rank: item.fused_rank,
        rank_symbolic: item.rank,
      };
    }
    // 只有真正从 PPR 种子走出来的路径才带扩散质量；非 PPR 来源恒 0（§4.7）
    if (fromPpr) fillPprMasses(path, ctx);
    return {
      fact_id: item.fact_id,
      hop: path.length,
      path,
      fused_rank: item.fused_rank,
      rank_symbolic: item.rank,
    };
  });

  return buildTrace({
    queryId: input.queryId,
    ts: input.ts,
    route: input.route ?? 'local',
    modelMode: input.modelMode ?? 'off',
    modelVersion: input.modelVersion ?? null,
    seeds: input.directIds,
    results,
  });
}
