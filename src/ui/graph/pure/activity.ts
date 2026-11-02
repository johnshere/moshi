/**
 * 活跃集计算（P2-03 / 详设 §10.3.1 双态视觉的参数部分）：命中 → 命中节点 + 1-hop 邻居。
 *
 * 与 `encoding.ts` 同层：没有 DOM、没有 three / sigma，根 `vitest` 直接测。
 *
 * 三条规矩：
 * 1. **事件源只有两个**（D-89）：`useSelection.focusId` 与 `fact.access_count` 上升沿。
 *    这里只负责"给定一个命中 id，算出这一小块该亮哪些节点/边"——不取数、不轮询、
 *    不碰 `/api/graph`。
 * 2. **规模先截断再返回**：活跃节点 ≤ `ACTIVE_NODE_CAP`、活跃边 ≤ `ACTIVE_EDGE_CAP`
 *    （详设 §10.3.1 并发上限），截断顺序按 importance / confidence 降序，保证留下的是
 *    "重要的一圈"，而不是数组里先出现的那些。
 * 3. **没有命中就是沉默**：`buildActivity` 返回 `null`，调用方据此回到全沉默态，
 *    不允许"默认高亮一批"（那等于没有高亮）。
 */
import { ACTIVE_EDGE_CAP, ACTIVE_NODE_CAP, type VisualState } from './encoding.js';

/** 活跃集计算需要的最小节点信息（`GraphNode` 的子集，避免 import `api.ts`） */
export interface ActivityNodeInput {
  id: string;
  importance: number;
}

/** 活跃集计算需要的最小边信息（`GraphEdge` 的子集） */
export interface ActivityEdgeInput {
  src: string;
  dst: string;
  confidence: number;
}

export interface ActivitySnapshot {
  /** 命中的节点 id（活跃态） */
  hitId: string;
  /** 命中发生的时刻（ms，调用方时钟），衰减与"跳跃"都按它算 */
  hitAt: number;
  /** 状态表：命中节点 = active，1-hop 邻居 = secondary；沉默节点不在这里 */
  states: Map<string, VisualState>;
  /** 活跃边（两端都在状态表里）的无向 key 集合，见 `edgeKey` */
  edges: Set<string>;
  /** 进入活跃态的节点数（含命中的那个） */
  activeNodes: number;
  /** 进入活跃态的边数 */
  activeEdges: number;
  /** 因为超过 `ACTIVE_NODE_CAP` 被丢掉的邻居数（验收要看得到"我截了"） */
  truncatedNodes: number;
  /** 因为超过 `ACTIVE_EDGE_CAP` 被丢掉的边数 */
  truncatedEdges: number;
}

/**
 * 边的无向 key。`/api/graph` 的边没有 id，且同一对端点可能有多条边（`co_occur` 与
 * `depends_on` 并存），所以这里只按端点对索引：一条边的两种 etype 视为同一条"活跃边"，
 * 视觉上本来就只差颜色。
 */
export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * 命中一个节点，算出活跃集快照。命中 id 不在本页数据里时返回 `null`。
 *
 * 1-hop 邻居按 importance 降序取前 `ACTIVE_NODE_CAP - 1` 个（命中自己占一个名额）；
 * 活跃边在节点集确定后再筛，按 confidence 降序取前 `ACTIVE_EDGE_CAP` 条。
 */
export function buildActivity(
  nodes: readonly ActivityNodeInput[],
  edges: readonly ActivityEdgeInput[],
  hitId: string | null,
  hitAt: number,
): ActivitySnapshot | null {
  if (hitId === null) return null;
  let hit: ActivityNodeInput | undefined;
  for (const node of nodes) {
    if (node.id === hitId) {
      hit = node;
      break;
    }
  }
  if (hit === undefined) return null;

  // 邻接表：一次 O(E) 扫完，命中时不再重复扫全表
  const neighbours = new Map<string, { id: string; importance: number }[]>();
  const push = (a: string, b: string, importance: number): void => {
    const list = neighbours.get(a);
    if (list === undefined) neighbours.set(a, [{ id: b, importance }]);
    else list.push({ id: b, importance });
  };
  const importanceById = new Map<string, number>();
  for (const node of nodes) importanceById.set(node.id, node.importance);
  for (const edge of edges) {
    const si = importanceById.get(edge.src);
    const di = importanceById.get(edge.dst);
    if (si === undefined || di === undefined) continue;
    push(edge.src, edge.dst, di);
    push(edge.dst, edge.src, si);
  }

  const states = new Map<string, VisualState>();
  states.set(hit.id, 'active');
  const ring = (neighbours.get(hit.id) ?? []).slice().sort((a, b) => b.importance - a.importance);
  const room = Math.max(ACTIVE_NODE_CAP - 1, 0);
  let truncatedNodes = 0;
  for (const item of ring) {
    if (states.has(item.id)) continue;
    if (states.size - 1 >= room) {
      truncatedNodes += 1;
      continue;
    }
    states.set(item.id, 'secondary');
  }

  const candidates: { key: string; confidence: number }[] = [];
  for (const edge of edges) {
    if (!states.has(edge.src) || !states.has(edge.dst)) continue;
    candidates.push({ key: edgeKey(edge.src, edge.dst), confidence: edge.confidence });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const activeEdges = new Set<string>();
  const truncatedEdges = Math.max(candidates.length - ACTIVE_EDGE_CAP, 0);
  for (const item of candidates) {
    if (activeEdges.size >= ACTIVE_EDGE_CAP) break;
    activeEdges.add(item.key);
  }

  return {
    hitId: hit.id,
    hitAt,
    states,
    edges: activeEdges,
    activeNodes: states.size,
    activeEdges: activeEdges.size,
    truncatedNodes,
    truncatedEdges,
  };
}

/** 某个节点此刻的视觉状态：不在快照里就是沉默 */
export function stateOf(snapshot: ActivitySnapshot | null, id: string): VisualState {
  return snapshot === null ? 'dormant' : (snapshot.states.get(id) ?? 'dormant');
}

/** 快照是否已过期（`decayWeight` 到 0 的同一时刻） */
export function isExpired(snapshot: ActivitySnapshot | null, now: number, ttlMs: number): boolean {
  if (snapshot === null) return true;
  return now - snapshot.hitAt >= ttlMs;
}

/**
 * "跳跃"观感的延迟：`hop` 越大越晚亮。命中节点 0ms、1-hop 180ms（`WAVE_STEP_MS`）。
 *
 * 不做路径传播（那需要 BFS 分层与多次重排），只做一跳错峰——观感上已经是"从被点的
 * 那一点扩散出去"，而实现只是给每个节点加一个偏移量。
 */
export function waveOffsetMs(hop: number, stepMs: number): number {
  return Math.max(hop, 0) * stepMs;
}

/**
 * 事件源②：从"上一份数据"到"这一份数据"里挑出**访问计数增长最多**的那个节点。
 *
 * 为什么要在这里挑而不是在渲染器里挑（D-89 的收口）：
 * - 渲染器只该做"给定焦点，画什么"，不该自己攒历史、定义"什么算一次调用"；
 * - 一次刷新可能有多个节点的 `access_count` 上涨（Agent 一轮用了好几块记忆），
 *   全点亮等于没点亮——只取增量最大者当"这次调用的主角"，其余的下次刷新再轮到；
 * - 并列时取 importance 高的：同等频次下，重要的那条更可能是用户想确认的。
 *
 * 首屏没有"上一份"，返回 `null`（否则刚打开页面就会亮一片，违背"默认沉默"）。
 * 节点在上一份里不存在（新写入的事实）不算上升沿——新节点没有"被调用"的历史。
 */
export interface AccessCounter {
  id: string;
  access_count: number;
  importance: number;
}

export function pickAccessRise(
  prev: readonly AccessCounter[] | null,
  next: readonly AccessCounter[],
): string | null {
  if (prev === null) return null;
  const before = new Map<string, number>();
  for (const node of prev) before.set(node.id, node.access_count);

  let bestId: string | null = null;
  let bestDelta = 0;
  let bestImportance = Number.NEGATIVE_INFINITY;
  for (const node of next) {
    const old = before.get(node.id);
    if (old === undefined) continue;
    const delta = node.access_count - old;
    if (delta <= 0) continue;
    if (delta > bestDelta || (delta === bestDelta && node.importance > bestImportance)) {
      bestId = node.id;
      bestDelta = delta;
      bestImportance = node.importance;
    }
  }
  return bestId;
}