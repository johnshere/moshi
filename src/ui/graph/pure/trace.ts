/**
 * `moshi-trace/1` → 边视觉属性（P2-25；详设 §4.7 契约 / §10.3.2 流动语义）。
 *
 * 与 `encoding.ts` / `activity.ts` 同层：纯函数，没有 DOM / three / sigma / fetch，
 * 根 `vitest`（node 环境）直接测。这里**不 import 后端 `core/read/trace.ts`**：
 * 那份实现带 sqlite / db 依赖，拉进前端 bundle 只会把 Node 侧代码打进去；trace 的
 * 形状本身是 HTTP JSON（`/api/trace/:query_id`），结构类型在这里重述一遍更稳。
 *
 * 三条口径（来自 §10.3.2，改之前先读）：
 * 1. `aFlow` 是 hop 分档流速：hop0（直接命中）**静止** 0，hop1 快 0.6，hop2+ 慢 0.3。
 *    0.6 沿用 `flowSpeedForActivity` 的"满速"系数，不是新拍的数字。
 * 2. `aMass` 是 PPR 沿边扩散份额，0–1，驱动亮度；**非 PPR 来源（直击节点本身）没有边**。
 * 3. `aHop` 是**原始跳数** 0/1/2，驱动相位偏移（hop 越大越滞后）；渲染侧不做归一化，
 *    模型侧 1 跳→0.5 / 2 跳→1.0 的归一化在 `core` 特征里，两者不要混用。
 *
 * 同一条边被多次经过：取**最小 hop**、**累加 mass**（再夹回 0–1）。这样 2 跳路径里
 * 复用的 1 跳边不会因为第二次经过而变慢，只会因为证据更重而更亮。
 */
import { clamp01, type VisualState } from './encoding.js';

// ── `/api/trace` 载荷的结构类型（§4.7 字段名逐字对齐）──────────────────

export interface TracePathEdge {
  src: string;
  dst: string;
  etype: string;
  /** 这条边的 PPR 扩散份额 0–1（§4.7 `edge_mass` 的逐边形态） */
  mass: number;
}

export interface TraceResult {
  fact_id: string;
  /** 0 = 直击（向量 / BM25 直接召回，没沿边）；1 / 2 = PPR 跳数 */
  hop: number;
  path: TracePathEdge[];
  edge_mass: number[];
  /** 在 fuseRank 里的名次（不在融合结果里为 null） */
  fused_rank: number | null;
  rank_symbolic: number;
  rank_final: number;
}

export interface TraceRecord {
  schema: string;
  query_id: string;
  /** ms 时间戳 */
  ts: number;
  /** 扩展字段（§4.7 未列）：`local` | `global`，全局查询的 trace 为空 */
  route: string;
  model_mode: string;
  model_version: string | null;
  source: string;
  seeds: string[];
  results: TraceResult[];
}

/** hop 分档：0 = 直击、1 = 一跳、2 = 两跳及以上（渲染只区分这三档） */
export type HopBand = 0 | 1 | 2;

export const FLOW_DIRECT = 0;
/** 满速档（= `flowSpeedForActivity(1)` 的 0.6），hop1 用它 */
export const FLOW_HOP1 = 0.6;
/** 半速档，hop2+ 用；表达"更远、证据更弱、更慢"且相位更滞后 */
export const FLOW_HOP2 = 0.3;
/** 相位偏移：每多一跳，流动点沿 u 方向滞后 1/3 个 dash 周期 */
export const HOP_PHASE_OFFSET = 0.33;

export function hopBand(hop: number): HopBand {
  if (!Number.isFinite(hop) || hop <= 0) return 0;
  return hop === 1 ? 1 : 2;
}

/** hop → `aFlow`：0 / 0.6 / 0.3（§10.3.2 表） */
export function flowForHop(hop: number): number {
  const band = hopBand(hop);
  if (band === 0) return FLOW_DIRECT;
  return band === 1 ? FLOW_HOP1 : FLOW_HOP2;
}

// ── 边属性 ──────────────────────────────────────────────────────────

export interface EdgeRef {
  src: string;
  dst: string;
  etype: string;
}

/** 一条边的证据属性（未命中 trace 的边为 `null`，即完全沉默） */
export interface TraceEdgeAttr {
  /** 原始跳数（渲染用 0/1/2 三档着色与相位） */
  hop: HopBand;
  /** PPR 扩散份额 0–1（驱动亮度） */
  mass: number;
  /** hop 分档流速 0 / 0.6 / 0.3 */
  flow: number;
  /**
   * 流动方向是否需要翻转：0 = 沿边几何的 src→dst，1 = 反向。
   *
   * `/api/graph` 的边没有"路径方向"字段，而 trace 的 path 是**证据传播方向**（种子→
   * 1 跳→2 跳）。若库里的边恰好反着存（`dst→src`），不翻转就会看到流在往回走——
   * 那正好是 §10.3.2 明令禁止的"用 etype 语义方向代替 hop 递进"。
   */
  dir: 0 | 1;
}

export interface TraceEdgeReadout {
  /** 每条证据边的 `aFlow`（仅 hop>0 的边；数组顺序与 `aMass` / `aHop` 对齐） */
  aFlow: number[];
  aMass: number[];
  aHop: number[];
  count: number;
}

/** 边引用 → 查找键；`\u0000` 不会出现在 id / etype 里，避免拼接碰撞 */
export function edgeRefKey(src: string, dst: string, etype: string): string {
  return `${src}\u0000${dst}\u0000${etype}`;
}

function pathEdgeHop(pathIndex: number): HopBand {
  // path 是按证据传播顺序排的：path[0] 的边是种子→1 跳，path[1] 的边是 1 跳→2 跳
  return hopBand(pathIndex + 1);
}

function pathEdgeMass(result: TraceResult, pathIndex: number): number {
  const edge = result.path[pathIndex];
  if (edge !== undefined && Number.isFinite(edge.mass)) return clamp01(edge.mass);
  const fromArray = Array.isArray(result.edge_mass) ? result.edge_mass[pathIndex] : undefined;
  return Number.isFinite(fromArray) ? clamp01(fromArray as number) : 0;
}

/**
 * 把一次 trace 折叠成"有向边 → 属性"。key 是 `(src, dst, etype)` 的有向串：
 * 同一对端点不同 etype 的边是两条不同的边（与 `activity.edgeKey` 的无向口径不同——
 * 那边是"活跃边"的视觉替身，这边是证据路径的逐边质量）。
 */
function collectTraceEdges(trace: TraceRecord | null): Map<string, { hop: HopBand; mass: number }> {
  const out = new Map<string, { hop: HopBand; mass: number }>();
  if (trace === null) return out;
  if (!Array.isArray(trace.results)) return out;
  for (const result of trace.results) {
    if (result === null || result === undefined || !Array.isArray(result.path)) continue;
    for (let i = 0; i < result.path.length; i += 1) {
      const edge = result.path[i];
      if (edge === null || edge === undefined || typeof edge.src !== 'string' || typeof edge.dst !== 'string') continue;
      const hop = pathEdgeHop(i);
      const mass = pathEdgeMass(result, i);
      const key = edgeRefKey(edge.src, edge.dst, typeof edge.etype === 'string' ? edge.etype : '');
      const prev = out.get(key);
      if (prev === undefined) {
        out.set(key, { hop, mass });
      } else {
        // 多次经过：min hop（不因第二次经过而"变远"）+ 累加 mass（证据更重）
        out.set(key, { hop: hopBand(Math.min(prev.hop, hop)), mass: clamp01(prev.mass + mass) });
      }
    }
  }
  return out;
}

function attrOf(hit: { hop: HopBand; mass: number }, dir: 0 | 1): TraceEdgeAttr {
  return { hop: hit.hop, mass: clamp01(hit.mass), flow: flowForHop(hit.hop), dir };
}

/**
 * 与 `edges` 逐条对齐的 trace 属性：`null` 表示这条边不在证据链里（保持沉默）。
 *
 * 方向匹配先试正向，再试反向（见 `TraceEdgeAttr.dir`）；两端都命中时取正向——
 * 一条边同时被两个方向经过说明数据里本来就并列存了反向边，优先"画得出来"的那个。
 * `trace === null` 或字段残缺时一律返回全 `null`，调用方据此回到"无证据链"。
 */
export function traceEdgeAttrsFor(
  edges: readonly EdgeRef[],
  trace: TraceRecord | null,
): (TraceEdgeAttr | null)[] {
  const byKey = collectTraceEdges(trace);
  return edges.map((edge) => {
    const forward = byKey.get(edgeRefKey(edge.src, edge.dst, edge.etype));
    if (forward !== undefined) return attrOf(forward, 0);
    const backward = byKey.get(edgeRefKey(edge.dst, edge.src, edge.etype));
    if (backward !== undefined) return attrOf(backward, 1);
    return null;
  });
}

/** 只读发布：把证据边属性压成三组数组（供 `window.__moshiGraph` 脚本验收） */
export function traceEdgeReadout(attrs: readonly (TraceEdgeAttr | null)[]): TraceEdgeReadout {
  const aFlow: number[] = [];
  const aMass: number[] = [];
  const aHop: number[] = [];
  for (const attr of attrs) {
    if (attr === null) continue;
    aFlow.push(attr.flow);
    aMass.push(attr.mass);
    aHop.push(attr.hop);
  }
  return { aFlow, aMass, aHop, count: aFlow.length };
}

// ── 节点跳数 / 视觉状态 ─────────────────────────────────────────────

/** 节点 id → 跳数（种子与直击结果 = 0；PPR 结果按 hop 递进）。同节点取最小 hop */
export function traceNodeHops(trace: TraceRecord | null): Map<string, HopBand> {
  const out = new Map<string, HopBand>();
  if (trace === null) return out;
  if (!Array.isArray(trace.seeds)) return out;
  for (const seed of trace.seeds) {
    if (typeof seed === 'string' && seed !== '') out.set(seed, 0);
  }
  if (!Array.isArray(trace.results)) return out;
  for (const result of trace.results) {
    if (result === null || result === undefined || typeof result.fact_id !== 'string') continue;
    const hop = hopBand(result.hop);
    const prev = out.get(result.fact_id);
    if (prev === undefined || hop < prev) out.set(result.fact_id, hop);
  }
  return out;
}

/**
 * 节点在证据链里的视觉状态：hop0 = 活跃（亮 + 光晕 + 标签），hop>0 = 次级。
 *
 * 返回 `null` 表示"这条节点不在证据链里"，由调用方回落到活跃集（点选）的判定。
 * 两个来源取**较亮**的一个（active > secondary > dormant）：点选与证据链是两件事，
 * 同时发生时不该互相覆盖。
 */
export function traceNodeState(
  hops: ReadonlyMap<string, number> | null,
  id: string,
): VisualState | null {
  const hop = hops?.get(id);
  if (hop === undefined) return null;
  return hopBand(hop) === 0 ? 'active' : 'secondary';
}

/** 两个视觉状态取较亮者（`active` > `secondary` > `dormant`） */
export function brighterState(a: VisualState, b: VisualState): VisualState {
  const rank = (s: VisualState): number => (s === 'active' ? 2 : s === 'secondary' ? 1 : 0);
  return rank(a) >= rank(b) ? a : b;
}

// ── HUD / 验收读数 ──────────────────────────────────────────────────

/** `window.__moshiGraph.trace` 的形状：数量够验收脚本判断三态是否同图 */
export interface TraceSummary {
  query_id: string;
  ts: number;
  route: string;
  source: string;
  model_mode: string;
  model_version: string | null;
  seeds: number;
  /** 直击节点数（hop=0） */
  direct: number;
  hop1: number;
  hop2: number;
  /** 证据边条数（trace 里去重后的有向边） */
  edges: number;
}

export function traceSummary(trace: TraceRecord | null): TraceSummary | null {
  if (trace === null) return null;
  const hops = traceNodeHops(trace);
  let direct = 0;
  let hop1 = 0;
  let hop2 = 0;
  for (const hop of hops.values()) {
    if (hop === 0) direct += 1;
    else if (hop === 1) hop1 += 1;
    else hop2 += 1;
  }
  return {
    query_id: trace.query_id,
    ts: trace.ts,
    route: trace.route,
    source: trace.source,
    model_mode: trace.model_mode,
    model_version: trace.model_version,
    seeds: Array.isArray(trace.seeds) ? trace.seeds.length : 0,
    direct,
    hop1,
    hop2,
    edges: collectTraceEdges(trace).size,
  };
}
