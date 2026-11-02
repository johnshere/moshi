/**
 * 活跃集计算测试（P2-03 / 详设 §10.3.1）。
 *
 * 活跃集是"默认沉默"能成立的前提：只要算错了（漏掉 1-hop、不截断、无向边算两条），
 * 要么点亮一大片把默认态毁掉，要么该亮的没亮、点选像没反应。三件事钉死：
 * 1. 命中 → 1-hop 邻居记 secondary，命中自己 active，其余不进表；
 * 2. 超上限按 importance / confidence 降序截断，并如实报截了多少；
 * 3. 无命中和"命中不在本页"都返回 null（= 全沉默）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildActivity,
  edgeKey,
  isExpired,
  pickAccessRise,
  stateOf,
  waveOffsetMs,
  type AccessCounter,
  type ActivityEdgeInput,
  type ActivityNodeInput,
} from '../../src/ui/graph/pure/activity.js';
import { ACTIVE_EDGE_CAP, ACTIVE_NODE_CAP, WAVE_STEP_MS } from '../../src/ui/graph/pure/encoding.js';

function nodes(n: number): ActivityNodeInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, importance: 1 - i / (n + 1) }));
}

describe('edgeKey：无向、与端点顺序无关', () => {
  it('交换端点得到同一个 key', () => {
    expect(edgeKey('a', 'b')).toBe(edgeKey('b', 'a'));
  });

  it('不同端点对得到不同 key（不会因拼接口碰撞）', () => {
    expect(edgeKey('a', 'bc')).not.toBe(edgeKey('ab', 'c'));
  });
});

describe('buildActivity：命中 + 1-hop', () => {
  const ns = nodes(4);
  const es: ActivityEdgeInput[] = [
    { src: 'n0', dst: 'n1', confidence: 0.9 },
    { src: 'n1', dst: 'n2', confidence: 0.5 },
    { src: 'n3', dst: 'n3', confidence: 1 },
  ];

  it('命中节点 active，直接邻居 secondary，二跳不亮', () => {
    const snap = buildActivity(ns, es, 'n0', 1000);
    expect(snap).not.toBeNull();
    expect(snap!.hitId).toBe('n0');
    expect(snap!.states.get('n0')).toBe('active');
    expect(snap!.states.get('n1')).toBe('secondary');
    expect(snap!.states.has('n2')).toBe(false);
    expect(snap!.activeNodes).toBe(2);
  });

  it('活跃边只收两端都在表里的，且同一对端点只算一条', () => {
    const dup: ActivityEdgeInput[] = [
      { src: 'n0', dst: 'n1', confidence: 0.9 },
      { src: 'n1', dst: 'n0', confidence: 0.4 },
      { src: 'n1', dst: 'n2', confidence: 0.8 },
    ];
    const snap = buildActivity(ns, dup, 'n0', 0)!;
    expect(snap.activeEdges).toBe(1);
    expect(snap.edges.has(edgeKey('n0', 'n1'))).toBe(true);
  });

  it('没有命中 / 命中不在本页 → null（全沉默）', () => {
    expect(buildActivity(ns, es, null, 0)).toBeNull();
    expect(buildActivity(ns, es, 'missing', 0)).toBeNull();
  });

  it('邻居重复出现（多条边）只占一个名额', () => {
    const multi: ActivityEdgeInput[] = [
      { src: 'n0', dst: 'n1', confidence: 0.2 },
      { src: 'n0', dst: 'n1', confidence: 0.9 },
      { src: 'n0', dst: 'n2', confidence: 0.3 },
    ];
    const snap = buildActivity(ns, multi, 'n0', 0)!;
    expect(snap.activeNodes).toBe(3);
  });
});

describe('规模上限：先截断再返回，并报被截掉的量', () => {
  it(`活跃节点 ≤ ${ACTIVE_NODE_CAP}，按 importance 留重要的`, () => {
    const total = ACTIVE_NODE_CAP + 20;
    const ns = nodes(total);
    // 星形：中心连到其余所有节点
    const es: ActivityEdgeInput[] = ns
      .slice(1)
      .map((n, i) => ({ src: 'n0', dst: n.id, confidence: 1 - i / total }));
    const snap = buildActivity(ns, es, 'n0', 0)!;
    expect(snap.activeNodes).toBe(ACTIVE_NODE_CAP);
    expect(snap.truncatedNodes).toBe(20);
    // importance 最高的是 n1（nodes() 递减），必然留下
    expect(snap.states.has('n1')).toBe(true);
  });

  it(`活跃边 ≤ ${ACTIVE_EDGE_CAP}，并报截断数`, () => {
    // 完图：ACTIVE_NODE_CAP 个节点两两相连，边数远大于上限
    const ns = nodes(ACTIVE_NODE_CAP);
    const es: ActivityEdgeInput[] = [];
    for (let i = 0; i < ns.length; i += 1) {
      for (let j = i + 1; j < ns.length; j += 1) {
        es.push({ src: ns[i]!.id, dst: ns[j]!.id, confidence: 1 - j / (ns.length * 2) });
      }
    }
    const snap = buildActivity(ns, es, 'n0', 0)!;
    expect(snap.activeEdges).toBe(ACTIVE_EDGE_CAP);
    expect(snap.activeEdges).toBe(snap.edges.size);
    expect(snap.truncatedEdges).toBe(es.length - ACTIVE_EDGE_CAP);
  });
});

describe('stateOf / isExpired / waveOffsetMs', () => {
  it('不在快照里就是沉默，null 快照全是沉默', () => {
    const snap = buildActivity([{ id: 'a', importance: 1 }], [], 'a', 0)!;
    expect(stateOf(snap, 'a')).toBe('active');
    expect(stateOf(snap, 'zzz')).toBe('dormant');
    expect(stateOf(null, 'a')).toBe('dormant');
  });

  it('到期判定与 TTL 边界一致', () => {
    const snap = buildActivity([{ id: 'a', importance: 1 }], [], 'a', 1000)!;
    expect(isExpired(snap, 5999, 5000)).toBe(false);
    expect(isExpired(snap, 6000, 5000)).toBe(true);
    expect(isExpired(null, 0, 5000)).toBe(true);
  });

  it('跳跃延迟：0 跳立刻、1 跳一个步长', () => {
    expect(waveOffsetMs(0, WAVE_STEP_MS)).toBe(0);
    expect(waveOffsetMs(1, WAVE_STEP_MS)).toBe(WAVE_STEP_MS);
    expect(waveOffsetMs(-3, WAVE_STEP_MS)).toBe(0);
  });
});

describe('pickAccessRise：事件源②（access_count 上升沿）', () => {
  const counter = (id: string, access_count: number, importance = 0.5): AccessCounter => ({
    id,
    access_count,
    importance,
  });

  it('有上升沿 → 返回该 id，且能据此点亮活跃集', () => {
    const prev = [counter('a', 1), counter('b', 5)];
    const next = [counter('a', 1), counter('b', 9)];
    const rise = pickAccessRise(prev, next);
    expect(rise).toBe('b');

    // 与 buildActivity 串起来：命中的确是这一条，并且它的邻居进次级（验收口径 ②）
    const ns: ActivityNodeInput[] = [
      { id: 'a', importance: 0.1 },
      { id: 'b', importance: 0.9 },
    ];
    const snap = buildActivity(ns, [{ src: 'b', dst: 'a', confidence: 1 }], rise, 0)!;
    expect(snap.hitId).toBe('b');
    expect(snap.activeNodes).toBe(2);
    expect(stateOf(snap, 'b')).toBe('active');
    expect(stateOf(snap, 'a')).toBe('secondary');
  });

  it('无上升沿 → null（沉默态不动）', () => {
    const prev = [counter('a', 3), counter('b', 4)];
    expect(pickAccessRise(prev, [counter('a', 3), counter('b', 4)])).toBeNull();
    // 计数变小（重置/换库）也不算调用事件
    expect(pickAccessRise(prev, [counter('a', 1), counter('b', 4)])).toBeNull();
  });

  it('多条上升 → 取增量最大者；并列取 importance 高者', () => {
    expect(
      pickAccessRise([counter('a', 1), counter('b', 1)], [counter('a', 4), counter('b', 7)]),
    ).toBe('b');
    expect(
      pickAccessRise(
        [counter('a', 1, 0.2), counter('b', 1, 0.8)],
        [counter('a', 3, 0.2), counter('b', 3, 0.8)],
      ),
    ).toBe('b');
  });

  it('首屏（没有上一份）不触发', () => {
    expect(pickAccessRise(null, [counter('a', 1), counter('b', 2)])).toBeNull();
  });

  it('新出现的节点不算上升沿（没有"被调用"的历史）', () => {
    expect(pickAccessRise([counter('a', 2)], [counter('a', 2), counter('c', 99)])).toBeNull();
  });
});
