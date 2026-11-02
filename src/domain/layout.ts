/**
 * 布局坐标计算（P2-01 / 详设 §10.4 / 决议 D16）。
 *
 * 这一层是**纯函数**：节点 + 边 + 上次坐标 + 力参数 → 坐标。不碰库、不碰文件、
 * 不开线程——worker（`app/jobs/`）只是包在它外面的一层薄壳。这么切是为了让两条
 * 验收能被精确断言："同一份数据两次算出来逐位相同"、"新增 10 个节点后老节点
 * 位移 < 15"。如果算法长在 worker 里，这两条就只能靠跑真进程碰运气。
 *
 * 两条铁律（台账 §4 P2-01「坑」）：
 *
 * 1. **初始抖动只能用 `hash(fact_id)`**，本文件不许出现 `Math.random()`。否则每次
 *    重算布局都不同，用户的空间记忆被摧毁（概设 §8.5.1 反目标 2）。
 * 2. **力导向由我们同步驱动**：`stop()` 之后自己 `tick(n)`，不用 d3 自带的定时器。
 *    异步步进跑多少 tick 取决于机器快慢，同一份数据会算出不同结果。
 *
 * 决定论另外两处也在这里封死：节点/边先按 id 排序（输入顺序不影响结果）；d3 内部
 * 的随机数（重合节点的 jiggle，`jiggle.js`）通过 `randomSource` 换成固定种子的
 * mulberry32。
 */
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type D3Simulation,
  type LayoutSimNode,
} from 'd3-force-3d';
import { sha256Hex } from './hash.js';

export interface LayoutParams {
  /** 边弹簧强度（详设 §10.4：0.3） */
  linkStrength: number;
  /** 边自然长度；详设没给，取 d3 默认 30（见台账 §5.2 D-73） */
  linkDistance: number;
  /** 斥力（详设 §10.4：-30） */
  chargeStrength: number;
  /** 向原点的向心力（详设 §10.4：0.02） */
  centerStrength: number;
  /** 向社区质心的锚定力 k（详设 §10.4：0.15） */
  communityStrength: number;
  /** 新事实相对社区质心的初始偏移半径（详设 §10.4：5） */
  jitterRadius: number;
  /** 归一化后的坐标范围，`extent=100` 即 [-100,100]³（详设 §10.4） */
  extent: number;
  /** 迭代次数：全量 300 / 增量 60（详设 §10.4） */
  ticks: number;
}

export interface LayoutNodeInput {
  id: string;
  /** 社区 id；真实库里目前全为 NULL（台账 B-2），按「全局质心」退化 */
  communityId: number | null;
}

export interface LayoutLinkInput {
  source: string;
  target: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface LayoutCoord extends Vec3 {
  id: string;
}

export interface LayoutInput {
  nodes: readonly LayoutNodeInput[];
  links: readonly LayoutLinkInput[];
  /** 上次布局结果；不在里面的节点算「新事实」，需要新落位 */
  previous: readonly LayoutCoord[];
  /**
   * 冷启动：忽略旧坐标，所有节点都从「社区质心 + hash 抖动」起步。
   *
   * 全量重算必须走这条（`moshi layout --full`）。如果全量也拿旧坐标当起点，
   * 结果就依赖"上一次算到哪了"——同一个库跑两遍 `--full` 会得到两套坐标，
   * 验收第 1 条（两次计算逐位相同）也就不成立了。增量则相反，必须沿用旧坐标，
   * 否则老节点每轮都在动，用户的空间记忆立刻失效。
   */
  coldStart?: boolean;
}

export interface LayoutComputation {
  coords: LayoutCoord[];
  /** 已有坐标节点的平均位移，量纲与 `displacement_threshold` 一致（归一化后空间） */
  avgDisplacement: number;
  maxDisplacement: number;
  /** 本次没有旧坐标、需要新落位的节点数 */
  placed: number;
}

/** d3 内部抖动用的固定种子。与 fact_id 无关——每事实的偏移由 `factSeed` 决定 */
const SIM_SEED = 0x9e3779b9;

interface SimNode extends LayoutSimNode {
  id: string;
  communityId: number | null;
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** mulberry32：32 位状态的小 PRNG，同种子同序列，不依赖平台 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `hash(fact_id)` 取前 8 位十六进制当种子（详设 §10.4「种子 = hash(fact_id)」） */
export function factSeed(factId: string): number {
  return Number.parseInt(sha256Hex(factId).slice(0, 8), 16) >>> 0;
}

/**
 * 新事实的初始偏移：半径 `radius` 的**球内均匀**采样。
 *
 * 为什么是 cbrt 而不是直接乘 random：均匀分布在球内时体积 ∝ r³，
 * 不取 cbrt 会让点全挤在球心（半径外圈几乎抽不到）。
 */
export function hashJitter(
  factId: string,
  radius: number,
): { x: number; y: number; z: number } {
  const rnd = mulberry32(factSeed(factId));
  const u = rnd();
  const v = rnd();
  const w = rnd();
  const r = radius * Math.cbrt(u);
  const theta = 2 * Math.PI * v;
  const cosPhi = 2 * w - 1;
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  return {
    x: r * sinPhi * Math.cos(theta),
    y: r * cosPhi,
    z: r * sinPhi * Math.sin(theta),
  };
}

/** 已有坐标按社区求质心；没有旧坐标的社区不建条目（调用方退到全局质心） */
function centroidsOf(
  nodes: readonly LayoutNodeInput[],
  previous: ReadonlyMap<string, LayoutCoord>,
): { byCommunity: Map<number, Vec3>; global: Vec3 | null } {
  const acc = new Map<number, { x: number; y: number; z: number; n: number }>();
  let gx = 0;
  let gy = 0;
  let gz = 0;
  let gn = 0;
  for (const n of nodes) {
    const p = previous.get(n.id);
    if (p === undefined) continue;
    gx += p.x;
    gy += p.y;
    gz += p.z;
    gn += 1;
    if (n.communityId === null) continue;
    const cur = acc.get(n.communityId);
    if (cur === undefined) acc.set(n.communityId, { x: p.x, y: p.y, z: p.z, n: 1 });
    else {
      cur.x += p.x;
      cur.y += p.y;
      cur.z += p.z;
      cur.n += 1;
    }
  }
  const byCommunity = new Map<number, Vec3>();
  for (const [id, s] of acc) {
    byCommunity.set(id, { x: s.x / s.n, y: s.y / s.n, z: s.z / s.n });
  }
  const global = gn === 0 ? null : { x: gx / gn, y: gy / gn, z: gz / gn };
  return { byCommunity, global };
}

/**
 * 归一化到 [-100,100]³（`extent` 给 100）。
 *
 * 三个轴用**同一个**缩放比：按各自轴分别拉满会把图形拉变形，节点的相对距离
 * 就不再是力导向算出来的距离了。跨度最大的那个轴决定缩放比，其余轴落在区间内。
 */
function normalize(coords: LayoutCoord[], extent: number): void {
  if (coords.length === 0) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of coords) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(span > 0)) {
    for (const c of coords) {
      c.x = 0;
      c.y = 0;
      c.z = 0;
    }
    return;
  }
  const scale = (2 * extent) / span;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  for (const c of coords) {
    c.x = (c.x - cx) * scale;
    c.y = (c.y - cy) * scale;
    c.z = (c.z - cz) * scale;
  }
}

function compareId(a: { id: string }, b: { id: string }): number {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** 纯计算入口：输入全部给全，输出坐标 + 位移统计 */
export function computeLayout(input: LayoutInput, params: LayoutParams): LayoutComputation {
  // 输入顺序不影响结果：先按 id 排序（SQL 侧也 ORDER BY，这里是第二道保险）
  const ordered = [...input.nodes].sort(compareId);
  const previous = new Map<string, LayoutCoord>();
  for (const c of input.previous) previous.set(c.id, c);
  // 冷启动时旧坐标只用于"位移统计"，不参与落位/锚点（见 LayoutInput.coldStart）
  const coldStart = input.coldStart === true;
  const startFrom = coldStart ? new Map<string, LayoutCoord>() : previous;

  const { byCommunity, global } = centroidsOf(ordered, startFrom);
  const centroidOf = (communityId: number | null): Vec3 =>
    (communityId === null ? undefined : byCommunity.get(communityId)) ?? global ?? ORIGIN;

  const nodes: SimNode[] = ordered.map((n) => {
    const old = startFrom.get(n.id);
    if (old !== undefined) {
      return { id: n.id, communityId: n.communityId, x: old.x, y: old.y, z: old.z };
    }
    const base = centroidOf(n.communityId);
    const d = hashJitter(n.id, params.jitterRadius);
    return {
      id: n.id,
      communityId: n.communityId,
      x: base.x + d.x,
      y: base.y + d.y,
      z: base.z + d.z,
    };
  });

  const known = new Set(ordered.map((n) => n.id));
  const seen = new Set<string>();
  const pairKey = (l: LayoutLinkInput): string => `${l.source}\u0000${l.target}`;
  const links: LayoutLinkInput[] = [];
  for (const l of [...input.links].sort((a, b) => {
    const ka = pairKey(a);
    const kb = pairKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  })) {
    if (l.source === l.target) continue;
    if (!known.has(l.source) || !known.has(l.target)) continue;
    const key = pairKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: l.source, target: l.target });
  }

  const anchors = nodes.map((node) => centroidOf(node.communityId));
  // 第二参是 numDimensions（d3-force-3d 语义，clamp 1..3），不是 tick 数：写 1 会让
  // simulation.js 里 `if (nDim > 1) node.y += node.vy` 全不成立，y/z 永不积分，
  // 3D 图退化成一条直线（forceY/forceZ 的社区锚定也随之全废）。
  const sim: D3Simulation<SimNode> = forceSimulation<SimNode>(nodes, 3).stop();
  // 固定随机源：d3 的 jiggle 用它，默认是种子写死的 lcg；换成我们自己的 mulberry32，
  // 这样"d3 的版本里 lcg 怎么实现"就不再影响结果。
  sim.randomSource(mulberry32(SIM_SEED));
  sim.force(
    'link',
    forceLink<SimNode>(links)
      .id((d) => d.id)
      .strength(params.linkStrength)
      .distance(params.linkDistance),
  );
  sim.force('charge', forceManyBody<SimNode>().strength(params.chargeStrength));
  sim.force('center', forceCenter<SimNode>(0, 0, 0).strength(params.centerStrength));
  // 社区锚定：每个节点吸自己的质心（community_id 为 NULL → 全局质心）
  const axisTarget = (d: SimNode, axis: 'x' | 'y' | 'z'): number => anchors[d.index ?? 0]?.[axis] ?? 0;
  sim.force('anchorX', forceX<SimNode>((d) => axisTarget(d, 'x')).strength(params.communityStrength));
  sim.force('anchorY', forceY<SimNode>((d) => axisTarget(d, 'y')).strength(params.communityStrength));
  sim.force('anchorZ', forceZ<SimNode>((d) => axisTarget(d, 'z')).strength(params.communityStrength));

  sim.tick(params.ticks);

  const coords: LayoutCoord[] = nodes.map((n) => ({
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
    z: n.z ?? 0,
  }));
  normalize(coords, params.extent);

  let sum = 0;
  let max = 0;
  let compared = 0;
  let placed = 0;
  for (const c of coords) {
    const old = previous.get(c.id);
    if (old === undefined) {
      placed += 1;
      continue;
    }
    const d = Math.hypot(c.x - old.x, c.y - old.y, c.z - old.z);
    sum += d;
    if (d > max) max = d;
    compared += 1;
  }

  return {
    coords,
    avgDisplacement: compared === 0 ? 0 : sum / compared,
    maxDisplacement: max,
    placed,
  };
}

