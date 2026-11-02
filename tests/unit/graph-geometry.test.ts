/**
 * 顶点属性组装与社区包络的纯函数测试（P2-02 返工补）。
 *
 * 这两块是"画出来对不对"的算术底座：`buildEdgeBuffers` 决定每条边用什么色、
 * 有没有流动点；`communityBounds` 决定包络球画在哪儿、多大。
 *
 * 特别是 `communityBounds` 的 `yOf`：渲染用的 Y 是 `layerY(strength)`（四层 ±60 / −100），
 * 不是布局 Y（恒 0）。用错的话包络球会飘在 y=0 平面上、跟簇错位（返工单 H4）。
 */
import { describe, expect, it } from 'vitest';
import { ETYPE_ORDER, etypeIndex, isInvalidated, layerY, renderY } from '../../src/ui/graph/pure/encoding.js';
import { buildEdgeBuffers, communityBounds } from '../../src/ui/graph/pure/geometry.js';

const nodes = [
  { id: 'a', x: 0, y: 0, z: 0, community_id: 2 },
  { id: 'b', x: 10, y: 0, z: 0, community_id: 2 },
  { id: 'c', x: 0, y: 0, z: 10, community_id: 5 },
];

describe('buildEdgeBuffers', () => {
  it('每条边两个顶点，uv 沿边取 0 / 1（shader 里 uv.x += t 就是流动点）', () => {
    const buf = buildEdgeBuffers(nodes, [
      { src: 'a', dst: 'b', etype: 'depends_on', confidence: 0.9 },
    ]);
    expect(buf.edgeCount).toBe(1);
    expect([...buf.positions]).toEqual([0, 0, 0, 10, 0, 0]);
    expect([...buf.uvs]).toEqual([0, 0, 1, 0]);
  });

  it('aType 写的是 etype 下标（shader 靠它选色），不是 rgb', () => {
    const buf = buildEdgeBuffers(nodes, [
      { src: 'a', dst: 'b', etype: 'depends_on', confidence: 0.9 },
      { src: 'b', dst: 'c', etype: 'supersedes', confidence: 0.4 },
    ]);
    const want = [etypeIndex('depends_on'), etypeIndex('depends_on'), etypeIndex('supersedes'), etypeIndex('supersedes')];
    expect([...buf.aType]).toEqual(want);
    // 六个类型都在 0..5 之间，且下标与 ETYPE_ORDER 对得上
    expect(want.every((i) => i >= 0 && i < ETYPE_ORDER.length)).toBe(true);
    expect(etypeIndex('depends_on')).toBe(ETYPE_ORDER.indexOf('depends_on'));
  });

  it('端点不在节点集里的边被丢弃（前端再兜一层，与接口口径一致）', () => {
    const buf = buildEdgeBuffers(nodes, [
      { src: 'a', dst: 'b', etype: 'logic', confidence: 1 },
      { src: 'a', dst: 'nope', etype: 'logic', confidence: 1 },
      { src: 'nope', dst: 'b', etype: 'logic', confidence: 1 },
    ]);
    expect(buf.edgeCount).toBe(1);
    expect(buf.aType).toHaveLength(2);
  });

  it('confidence 缺失按 0 处理，aFlow 取两端活跃度的较大者', () => {
    const buf = buildEdgeBuffers(
      nodes,
      [{ src: 'a', dst: 'b', etype: 'co_occur', confidence: Number.NaN }],
      (id) => (id === 'a' ? 0 : 0.5),
    );
    expect([...buf.aConf]).toEqual([0, 0]);
    // 0.5 归一化后是 0.6 的流动速度，两端取 max → 不是 0
    expect(buf.aFlow[0]).toBeGreaterThan(0);
  });

  it('空输入不炸', () => {
    const buf = buildEdgeBuffers([], []);
    expect(buf.edgeCount).toBe(0);
    expect(buf.positions).toHaveLength(0);
  });
});

describe('communityBounds', () => {
  it('默认用布局 Y 算包围球，球心落在成员均值上', () => {
    const bounds = communityBounds(nodes);
    const two = bounds.find((b) => b.communityId === 2);
    expect(two?.center).toEqual([5, 0, 0]);
  });

  it('yOf 覆盖后按渲染层高算：球心与簇处在同一平面（H4）', () => {
    const bounds = communityBounds(nodes, (n) => layerY(n.id === 'a' ? 0.9 : 0.1));
    const two = bounds.find((b) => b.communityId === 2);
    // a 在顶层（strength 0.9 → 层内 40 + 26.7 附近），b 在底层（strength 0.1 → −53.3 附近）
    const ya = layerY(0.9);
    const yb = layerY(0.1);
    expect(two?.center[1]).toBeCloseTo((ya + yb) / 2, 6);
    expect(two?.center[1]).not.toBe(0);
  });

  it('单个节点、或半径不足时给下限 12', () => {
    const bounds = communityBounds([{ id: 'solo', x: 1, y: 2, z: 3, community_id: 9 }]);
    expect(bounds).toHaveLength(1);
    expect(bounds[0]?.radius).toBe(12);
  });

  it('失效成员与活跃成员同属一个社区时，球心落在 −100 且球外 0 个（复审 H-1）', () => {
    // 一个社区里混入两个失效成员：一个 strength 归零、一个 label 带 [失效] 前缀，
    // 它们画在 −100；如果包络球心漏传 invalidated 会被算到 −80，球就罩不住它们。
    const mixed = [
      { id: 'live1', x: 0, y: 0, z: 0, strength: 0.9, label: '正常事实 A', community_id: 7 },
      { id: 'live2', x: 20, y: 0, z: 0, strength: 0.5, label: '正常事实 B', community_id: 7 },
      { id: 'dead1', x: 0, y: 0, z: 20, strength: 0, label: '[失效] 旧结论', community_id: 7 },
      { id: 'dead2', x: 0, y: 0, z: 40, strength: 0.8, label: '[失效] 被推翻', community_id: 7 },
    ];
    const bounds = communityBounds(mixed, (n) => renderY(n));
    const ball = bounds.find((b) => b.communityId === 7);
    expect(ball).toBeDefined();

    const centerY = ball!.center[1]!;
    const radius = ball!.radius;
    expect(isInvalidated(mixed[2]!)).toBe(true);
    expect(isInvalidated(mixed[3]!)).toBe(true);

    // 球心 Y == 成员「渲染 Y」的均值：漏传 invalidated 时会算成 −80 分档的均值，这里立刻红
    const expectedCenterY = mixed.reduce((sum, n) => sum + renderY(n), 0) / mixed.length;
    expect(centerY).toBeCloseTo(expectedCenterY, 6);
    expect(centerY).toBeLessThan(0);

    // 球外 0 个：每个成员到球心的距离都不超过半径（用「渲染 Y」算，与画面对齐）
    const outside = mixed.filter((n) => {
      const dy = renderY(n) - centerY;
      const d = Math.hypot(n.x - ball!.center[0]!, dy, n.z - ball!.center[2]!);
      return d > radius + 1e-9;
    });
    expect(outside).toHaveLength(0);
  });

  it('整社区都是失效成员时球心 Y == −100（复审 H-1 的最小复现）', () => {
    const ghosts = [
      { id: 'g1', x: 0, y: 0, z: 0, strength: 0, label: '[失效] a', community_id: 3 },
      { id: 'g2', x: 5, y: 0, z: 5, strength: 0, label: '[失效] b', community_id: 3 },
      { id: 'g3', x: 0, y: 0, z: 10, strength: 0, label: '普通文本', community_id: 3 },
    ];
    const ball = communityBounds(ghosts, (n) => renderY(n))[0]!;
    expect(ball.center[1]).toBe(-100);
    expect(ball.radius).toBeLessThanOrEqual(12); // 全在同一层，半径吃下限
  });

  it('community_id 为 null 的节点不参与，结果按社区号排序', () => {
    const bounds = communityBounds([
      ...nodes,
      { id: 'loose', x: 99, y: 99, z: 99, community_id: null },
    ]);
    expect(bounds.map((b) => b.communityId)).toEqual([2, 5]);
    expect(bounds.every((b) => Number.isFinite(b.radius))).toBe(true);
  });
});
