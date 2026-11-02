/**
 * 顶点属性组装（纯函数，可单测）。
 *
 * 详设 §10.3 要求边用 `LineSegments` + 自定义 `ShaderMaterial`，**顶点属性 `aType`
 * 驱动色相**。色相不在 CPU 上算成 rgb 塞进 attribute，而是把"边的类型下标"作为
 * `aType` 交给 shader，shader 再从不多的几个 uniform 里取色——这样换色板只改 uniform，
 * 不用重建 buffer。
 *
 * 之外的三个属性：
 * - `aConf`：`edge.confidence`，shader 用它调亮度（GL 的线宽不可编程，见台账 §5.2 决策）
 * - `aFlow`：访问活跃度归一化后的流动速度，0 即完全静止
 * - `position`：两端点坐标，每条边 2 个顶点
 */
import { etypeIndex, flowSpeedForActivity } from './encoding.js';

export interface NodeLike {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface EdgeLike {
  src: string;
  dst: string;
  etype: string;
  confidence: number;
}

export interface EdgeBuffers {
  /** 每条边 2 个顶点 × 3 分量 */
  positions: Float32Array;
  /**
   * 每条边 2 个顶点 × 2 分量，`uv.x` 取 0（源端）和 1（宿端）。
   * `LineSegments` 没有 uv，这里补一个"沿边参数"当 uv 用：shader 里
   * `uv.x += t` 就是流动点的全部实现，不需要额外几何体。
   */
  uvs: Float32Array;
  /** 每条边 2 个顶点，值为 `ETYPE_ORDER` 下标 */
  aType: Float32Array;
  aConf: Float32Array;
  aFlow: Float32Array;
  /** 真正写进 buffer 的边数（端点缺失的边被丢掉） */
  edgeCount: number;
}

/**
 * 组装边的顶点属性。两端只要有一端不在节点集里就丢弃——
 * 这和 `/api/graph` 的"边只取两端都在返回集里的"是同一条规矩，前端再兜一层。
 */
export function buildEdgeBuffers(
  nodes: readonly NodeLike[],
  edges: readonly EdgeLike[],
  flowOf: (nodeId: string) => number = () => 0,
): EdgeBuffers {
  const byId = new Map<string, NodeLike>();
  for (const n of nodes) byId.set(n.id, n);

  const pos: number[] = [];
  const uv: number[] = [];
  const type: number[] = [];
  const conf: number[] = [];
  const flow: number[] = [];

  for (const e of edges) {
    const a = byId.get(e.src);
    const b = byId.get(e.dst);
    if (a === undefined || b === undefined) continue;
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    uv.push(0, 0, 1, 0);
    const t = etypeIndex(e.etype);
    type.push(t, t);
    const c = Number.isFinite(e.confidence) ? e.confidence : 0;
    conf.push(c, c);
    const f = flowSpeedForActivity(Math.max(flowOf(e.src), flowOf(e.dst)));
    flow.push(f, f);
  }

  return {
    positions: new Float32Array(pos),
    uvs: new Float32Array(uv),
    aType: new Float32Array(type),
    aConf: new Float32Array(conf),
    aFlow: new Float32Array(flow),
    edgeCount: flow.length / 2,
  };
}

/** 社区的球心与半径：用该社区节点的包围球（包络不能比簇本身还小） */
export interface CommunityBounds {
  communityId: number;
  center: [number, number, number];
  radius: number;
}

/**
 * `yOf` 让调用方决定「用哪个 Y 算包围球」。
 *
 * 默认取 `node.y`（布局坐标），但渲染时节点的 Y 不是布局 Y，而是视觉编码算出来的
 * 层高 `layerY(strength)`（详设 §10.3 视觉编码表：+60 / 0 / −60 / −100）。
 * 两者不在同一个平面上——布局 Y 恒为 0，直接用它算包络会让球心落在 y=0，
 * 而簇实际分布在四层上（P2-02 返工 H4）。
 */
export function communityBounds<N extends NodeLike & { community_id: number | null }>(
  nodes: readonly N[],
  yOf: (node: N) => number = (node) => node.y,
): CommunityBounds[] {
  const acc = new Map<number, { n: number; cx: number; cy: number; cz: number }>();
  for (const node of nodes) {
    if (node.community_id === null || node.community_id === undefined) continue;
    const a = acc.get(node.community_id) ?? { n: 0, cx: 0, cy: 0, cz: 0 };
    a.n += 1;
    a.cx += node.x;
    a.cy += yOf(node);
    a.cz += node.z;
    acc.set(node.community_id, a);
  }

  const out: CommunityBounds[] = [];
  for (const [communityId, a] of [...acc.entries()].sort((x, y) => x[0] - y[0])) {
    const cx = a.cx / a.n;
    const cy = a.cy / a.n;
    const cz = a.cz / a.n;
    let r2 = 0;
    for (const node of nodes) {
      if (node.community_id !== communityId) continue;
      const dx = node.x - cx;
      const dy = yOf(node) - cy;
      const dz = node.z - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    // 单节点社区没有半径可言，给一个不小于节点直径的下限
    out.push({ communityId, center: [cx, cy, cz], radius: Math.max(Math.sqrt(r2), 12) });
  }
  return out;
}
