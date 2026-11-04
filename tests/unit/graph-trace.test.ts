/**
 * 证据链 → 边属性映射测试（P2-25，详设 §4.7 / §10.3.2）。
 *
 * 这层是"为什么返回这些事实"能画出来的唯一依据，算错了肉眼很难发现：hop 分档错
 * 会把 2 跳画成 1 跳的快流，mass 忘了累加会让"证据更重"的边反而更暗，方向没翻转
 * 则流动逆着证据传播方向走。三件事钉死：
 * 1. aFlow 分档边界（0 / 0.6 / 0.3）与 hop 递进；
 * 2. 同一条边多次经过 = 取最小 hop + 累加 mass（夹回 0–1）；
 * 3. 无 trace / 字段残缺 = 全部沉默，不抛错（缺 trace 是合法状态）。
 */
import { describe, expect, it } from 'vitest';
import {
  FLOW_HOP1,
  FLOW_HOP2,
  brighterState,
  edgeRefKey,
  flowForHop,
  hopBand,
  traceEdgeAttrsFor,
  traceEdgeReadout,
  traceNodeHops,
  traceNodeState,
  traceSummary,
  type EdgeRef,
  type TraceRecord,
} from '../../src/ui/graph/pure/trace.js';

const EDGES: EdgeRef[] = [
  { src: 'f1', dst: 'f2', etype: 'depends_on' },
  { src: 'f2', dst: 'f3', etype: 'logic' },
  { src: 'f3', dst: 'f4', etype: 'co_occur' },
];

function makeTrace(partial: Partial<TraceRecord> = {}): TraceRecord {
  return {
    schema: 'moshi-trace/1',
    query_id: 'q-001',
    ts: 1_700_000_000_000,
    route: 'local',
    model_mode: 'off',
    model_version: null,
    source: 'symbolic',
    seeds: ['f1'],
    results: [
      {
        fact_id: 'f1',
        hop: 0,
        path: [],
        edge_mass: [],
        fused_rank: 1,
        rank_symbolic: 1,
        rank_final: 1,
      },
      {
        fact_id: 'f2',
        hop: 1,
        path: [{ src: 'f1', dst: 'f2', etype: 'depends_on', mass: 0.6 }],
        edge_mass: [0.6],
        fused_rank: 2,
        rank_symbolic: 2,
        rank_final: 2,
      },
      {
        fact_id: 'f3',
        hop: 2,
        path: [
          { src: 'f1', dst: 'f2', etype: 'depends_on', mass: 0.6 },
          { src: 'f2', dst: 'f3', etype: 'logic', mass: 0.211281 },
        ],
        edge_mass: [0.6, 0.211281],
        fused_rank: 3,
        rank_symbolic: 3,
        rank_final: 3,
      },
    ],
    ...partial,
  };
}

describe('hop 分档：0 / 0.6 / 0.3', () => {
  it('hop 0 = 静止，hop 1 = 快流，hop 2+ = 慢流', () => {
    expect(flowForHop(0)).toBe(0);
    expect(flowForHop(1)).toBe(FLOW_HOP1);
    expect(flowForHop(2)).toBe(FLOW_HOP2);
    expect(flowForHop(3)).toBe(FLOW_HOP2);
  });

  it('非法 hop（负数 / NaN / Infinity）一律按直击处理，不让脏数据点亮边', () => {
    expect(hopBand(-1)).toBe(0);
    expect(hopBand(Number.NaN)).toBe(0);
    expect(hopBand(Number.POSITIVE_INFINITY)).toBe(0);
    expect(flowForHop(Number.NaN)).toBe(0);
  });
});

describe('traceEdgeAttrsFor：逐边 hop / mass / flow / dir', () => {
  const trace = makeTrace();
  const attrs = traceEdgeAttrsFor(EDGES, trace);

  it('直击节点没有入射边（hop0 只亮节点）', () => {
    // 证据链里 f1 是 hop0，没有任何 path 指回它；f1→f2 是 hop1 的边
    expect(attrs).toHaveLength(3);
    expect(attrs[0]?.hop).toBe(1);
  });

  it('hop 递进：种子→1 跳的边 aFlow=0.6，1 跳→2 跳的边 aFlow=0.3', () => {
    expect(attrs[0]).toMatchObject({ hop: 1, flow: FLOW_HOP1, dir: 0 });
    expect(attrs[1]).toMatchObject({ hop: 2, flow: FLOW_HOP2, dir: 0 });
  });

  it('同一条边被 hop1 与 hop2 两次经过：取最小 hop、mass 累加并夹到 1', () => {
    // f1→f2 在 f2(hop1) 与 f3(hop2) 的 path 里各出现一次，0.6 + 0.6 = 1.2 → 夹回 1
    expect(attrs[0]?.mass).toBe(1);
    // 只出现一次的边保留原 mass
    expect(attrs[1]?.mass).toBeCloseTo(0.211281, 6);
  });

  it('不存在的边保持 null（= 完全沉默，aFlow 0）', () => {
    expect(attrs[2]).toBeNull();
  });

  it('边的几何方向与 path 相反时 dir=1（流动方向由 hop 递进决定，不由 etype 猜）', () => {
    const reversed: EdgeRef[] = [{ src: 'f2', dst: 'f1', etype: 'depends_on' }];
    const [attr] = traceEdgeAttrsFor(reversed, trace);
    expect(attr).toMatchObject({ hop: 1, flow: FLOW_HOP1, dir: 1 });
  });

  it('方向不匹配 / etype 不匹配都不命中（不把 co_occur 的两端硬连上）', () => {
    const wrongType: EdgeRef[] = [{ src: 'f1', dst: 'f2', etype: 'logic' }];
    expect(traceEdgeAttrsFor(wrongType, trace)[0]).toBeNull();
  });

  it('mass 按 path 逐边取；path.mass 缺失时回落 edge_mass', () => {
    const fallback = makeTrace({
      results: [
        {
          fact_id: 'f2',
          hop: 1,
          path: [{ src: 'f1', dst: 'f2', etype: 'depends_on', mass: Number.NaN }],
          edge_mass: [0.42],
          fused_rank: 1,
          rank_symbolic: 1,
          rank_final: 1,
        },
      ],
    });
    const [attr] = traceEdgeAttrsFor([EDGES[0]!], fallback);
    expect(attr?.mass).toBeCloseTo(0.42, 6);
  });
});

describe('traceNodeHops / traceNodeState：直击与跳数', () => {
  it('种子与 hop0 结果都是 0；同节点取最小 hop', () => {
    const hops = traceNodeHops(makeTrace());
    expect(hops.get('f1')).toBe(0);
    expect(hops.get('f2')).toBe(1);
    expect(hops.get('f3')).toBe(2);
    expect(traceNodeState(hops, 'f1')).toBe('active');
    expect(traceNodeState(hops, 'f2')).toBe('secondary');
    expect(traceNodeState(hops, 'missing')).toBeNull();
  });

  it('两个来源取较亮者：active > secondary > dormant', () => {
    expect(brighterState('dormant', 'active')).toBe('active');
    expect(brighterState('secondary', 'active')).toBe('active');
    expect(brighterState('dormant', 'secondary')).toBe('secondary');
  });
});

describe('traceSummary：HUD / __moshiGraph 读数', () => {
  it('统计直击 / 1 跳 / 2+ 跳节点数与去重后的证据边数', () => {
    const summary = traceSummary(makeTrace());
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      query_id: 'q-001',
      route: 'local',
      source: 'symbolic',
      model_mode: 'off',
      seeds: 1,
      direct: 1,
      hop1: 1,
      hop2: 1,
      // f1→f2 出现两次但入口去重；f2→f3 一条 → 2 条证据边
      edges: 2,
    });
  });

  it('traceEdgeReadout 只发布证据边（hop>0），三组数组等长', () => {
    const readout = traceEdgeReadout(traceEdgeAttrsFor(EDGES, makeTrace()));
    expect(readout.count).toBe(2);
    expect(readout.aFlow).toEqual([FLOW_HOP1, FLOW_HOP2]);
    expect(readout.aHop).toEqual([1, 2]);
    expect(readout.aMass).toHaveLength(2);
  });
});

describe('无 trace / 脏 trace：一律沉默且不抛错', () => {
  it('trace=null 时所有边都是 null，读数 count=0，摘要 null', () => {
    const attrs = traceEdgeAttrsFor(EDGES, null);
    expect(attrs.every((a) => a === null)).toBe(true);
    expect(traceEdgeReadout(attrs).count).toBe(0);
    expect(traceNodeHops(null).size).toBe(0);
    expect(traceSummary(null)).toBeNull();
    expect(traceNodeState(null, 'f1')).toBeNull();
  });

  it('results 字段残缺（手工构造的脏 JSON）不抛错', () => {
    const dirty = {
      schema: 'moshi-trace/1',
      query_id: 'q-dirty',
      ts: 0,
      route: 'local',
      model_mode: 'off',
      model_version: null,
      source: 'symbolic',
      seeds: ['f1'],
      results: [
        null,
        {},
        { fact_id: 'f2', hop: 1, path: [null, { src: 'f1' }], edge_mass: null },
      ],
    } as unknown as TraceRecord;
    expect(() => traceEdgeAttrsFor(EDGES, dirty)).not.toThrow();
    expect(traceEdgeAttrsFor(EDGES, dirty).every((a) => a === null)).toBe(true);
    expect(() => traceNodeHops(dirty)).not.toThrow();
    expect(traceSummary(dirty)?.direct).toBe(1);
  });
});

describe('edgeRefKey：有向且无拼接碰撞', () => {
  it('交换端点得到不同 key（流动方向是证据传播方向，不能无向化）', () => {
    expect(edgeRefKey('a', 'b', 'depends_on')).not.toBe(edgeRefKey('b', 'a', 'depends_on'));
  });

  it('不同 etype 得到不同 key', () => {
    expect(edgeRefKey('a', 'b', 'logic')).not.toBe(edgeRefKey('a', 'b', 'co_occur'));
  });
});
