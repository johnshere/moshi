/**
 * 2D 视图纯映射测试（P2-03）。
 *
 * 钉住四件事：
 * 1. 2D 坐标只取布局 `(x, z)`，布局的 Y（strength 分层）**不参与**投影；
 * 2. 颜色 / 尺寸 / 透明度全部来自 `encoding.ts` 那张表，2D 没有第二套色表；
 * 3. 沉默 / 次级 / 活跃三档在 2D 上依次变亮变大，沉默是默认；
 * 4. 选中只改尺寸与标签可见性，不动色相。
 */
import { describe, expect, it } from 'vitest';
import {
  edge2DAttrs,
  edgeColorHex,
  focusAttrs,
  node2DAttrs,
  nodeColorHex,
  nodeOpacity,
  projectTo2D,
  shortLabel,
  to2DAlphaEdge,
  to2DAlphaNode,
  type Node2DInput,
} from '../../src/ui/graph/pure/graph2d.js';
import { FOCUS_SCALE, dimHex, edgeVisual, nodeVisual } from '../../src/ui/graph/pure/encoding.js';

function node(over: Partial<Node2DInput> = {}): Node2DInput {
  return {
    x: 12,
    y: 0,
    z: -34,
    ftype: 'semantic',
    importance: 0.5,
    strength: 0.8,
    label: '事实标签',
    ...over,
  };
}

describe('projectTo2D：布局 (x, z) → 平面 (x, y)', () => {
  it('x 原样、z 落到 y 槽位', () => {
    expect(projectTo2D({ x: 5, z: -7 })).toEqual({ x: 5, y: -7 });
  });

  it('布局 Y（strength 层高）不参与投影：只差 Y 的两个节点落在同一点', () => {
    const a = node({ y: 60 });
    const b = node({ y: -100 });
    expect(projectTo2D(a)).toEqual(projectTo2D(b));
  });
});

describe('颜色：与 3D 同一张色表', () => {
  it('ftype → hex 与 encoding.FTYPE_HEX 逐字一致', () => {
    expect(nodeColorHex('semantic')).toBe('#22d3ee');
    expect(nodeColorHex('episodic')).toBe('#a78bfa');
    expect(nodeColorHex('conditional')).toBe('#f59e0b');
  });

  it('未知 ftype 落回 semantic，不抛错', () => {
    expect(nodeColorHex('nope')).toBe('#22d3ee');
  });

  it('etype → hex 走同一张表并认短名别名', () => {
    expect(edgeColorHex('depends_on')).toBe('#8b5cf6');
    expect(edgeColorHex('mutex')).toBe('#f59e0b');
    expect(edgeColorHex('derived')).toBe('#1e293b');
    expect(edgeColorHex('nope')).toBe('#1e293b');
  });

  it('沉默态压暗但不黑：比 encoding 的沉默色亮一档，比活跃色暗', () => {
    const dormant = node2DAttrs(node({ ftype: 'episodic' }));
    const active = node2DAttrs(node({ ftype: 'episodic' }), 'active');
    expect(active.color).toBe('#a78bfa');
    expect(dormant.color).not.toBe(active.color);
    // 2D 的沉默色 = encoding 沉默色抬一档（D-93），所以不再等于 3D 的沉默色
    expect(dormant.color).not.toBe(nodeVisual('dormant', 'episodic', 0.8).color);
    // 但仍是"同一张色表"：色相取自 ftype，只是降饱和/降明度
    expect(dormant.color).toBe(dimHex(nodeColorHex('episodic'), 0.55, 0.72));
  });

  it('次级态用 encoding 的原色（只有沉默档在 2D 被抬亮）', () => {
    const secondary = node2DAttrs(node({ ftype: 'episodic' }), 'secondary');
    expect(secondary.color).toBe(nodeVisual('secondary', 'episodic', 0.8).color);
  });

  it('沉默边也压暗，避免 6000 条边糊成灰雾', () => {
    const dormant = edge2DAttrs({ etype: 'logic', confidence: 1 });
    expect(dormant.color).toBe(dimHex(edgeColorHex('logic'), 0.35, 0.55));
    expect(edge2DAttrs({ etype: 'logic', confidence: 1 }, 'active').color).toBe(edgeColorHex('logic'));
  });
});

describe('尺寸：importance → 半径，按状态缩放', () => {
  it('沉默态 ×0.85、次级 ×1.0、活跃 ×1.0', () => {
    expect(node2DAttrs(node({ importance: 0 })).size).toBeCloseTo(3 * 0.85, 10);
    expect(node2DAttrs(node({ importance: 1 })).size).toBeCloseTo(12 * 0.85, 10);
    expect(node2DAttrs(node({ importance: 1 }), 'secondary').size).toBeCloseTo(12, 10);
    expect(node2DAttrs(node({ importance: 1 }), 'active').size).toBeCloseTo(12, 10);
  });

  it('baseSize 记下当前半径，供取消选中时还原', () => {
    const attrs = node2DAttrs(node({ importance: 0.4 }));
    expect(attrs.baseSize).toBe(attrs.size);
  });
});

describe('不透明度：沉默 < 次级 < 活跃，且经 2D 重映射抬进可见区间', () => {
  it('节点映射保序、夹在 [0.38, 1]；边映射更狠地压，夹在 [0.06, 1]', () => {
    expect(to2DAlphaNode(0)).toBeCloseTo(0.38, 10);
    expect(to2DAlphaNode(1)).toBeCloseTo(1, 10);
    expect(to2DAlphaNode(0.05)).toBeLessThan(to2DAlphaNode(0.5));
    expect(to2DAlphaNode(2)).toBe(1);
    expect(to2DAlphaNode(-1)).toBeCloseTo(0.38, 10);

    expect(to2DAlphaEdge(0)).toBeCloseTo(0.06, 10);
    expect(to2DAlphaEdge(1)).toBeCloseTo(1, 10);
    expect(to2DAlphaEdge(-1)).toBeCloseTo(0.06, 10);
    // 同一个 alpha 上，节点必须比边亮：否则沉默态的点会被边盖住
    expect(to2DAlphaNode(0.1)).toBeGreaterThan(to2DAlphaEdge(0.1));
  });

  it('三档依次变亮（同一个节点，strength 相同）', () => {
    const n = node({ strength: 0.8 });
    const dormant = node2DAttrs(n).opacity;
    const secondary = node2DAttrs(n, 'secondary').opacity;
    const active = node2DAttrs(n, 'active').opacity;
    expect(dormant).toBeLessThan(secondary);
    expect(secondary).toBeLessThan(active);
    expect(dormant).toBeCloseTo(to2DAlphaNode(nodeVisual('dormant', 'semantic', 0.8).opacity), 10);
  });

  it('带 [失效] 标签的节点回到沉默态下限，压到最暗那档', () => {
    expect(nodeOpacity(node({ strength: 0.95, label: '[失效] 旧口径' }))).toBeCloseTo(
      to2DAlphaNode(nodeVisual('dormant', 'semantic', 0).opacity),
      10,
    );
  });
});

describe('边：宽度随 confidence，活跃态加粗当"流动"的替身', () => {
  it('沉默态宽度 0.5–2，透明度取沉默档', () => {
    expect(edge2DAttrs({ etype: 'logic', confidence: 0 }).size).toBe(0.5);
    expect(edge2DAttrs({ etype: 'logic', confidence: 1 }).size).toBe(2);
    expect(edge2DAttrs({ etype: 'logic', confidence: 1 }).opacity).toBeCloseTo(
      to2DAlphaEdge(edgeVisual('dormant', 1).opacity),
      10,
    );
  });

  it('活跃边按 width 倍数加粗（2D 无流动通道，见详设 §10.3.1 注脚）', () => {
    const conf = 1;
    const width = edgeVisual('active', conf).width;
    expect(edge2DAttrs({ etype: 'logic', confidence: conf }, 'active').size).toBeCloseTo(2 * width, 10);
    expect(edge2DAttrs({ etype: 'logic', confidence: conf }, 'active').size).toBeGreaterThan(
      edge2DAttrs({ etype: 'logic', confidence: conf }).size,
    );
  });

  it('次级边介于沉默与活跃之间', () => {
    const c = 0.5;
    expect(edge2DAttrs({ etype: 'logic', confidence: c }, 'secondary').opacity).toBeGreaterThan(
      edge2DAttrs({ etype: 'logic', confidence: c }).opacity,
    );
    expect(edge2DAttrs({ etype: 'logic', confidence: c }, 'secondary').opacity).toBeLessThan(
      edge2DAttrs({ etype: 'logic', confidence: c }, 'active').opacity,
    );
  });
});

describe('选中高亮：放大 + 常显标签，颜色不动', () => {
  it('选中放大 FOCUS_SCALE 倍并强制显示标签', () => {
    const attrs = node2DAttrs(node({ importance: 0.5 }));
    const focused = focusAttrs(attrs, true);
    expect(focused.size).toBeCloseTo(attrs.baseSize * FOCUS_SCALE, 10);
    expect(focused.labelVisibility).toBe('visible');
  });

  it('取消选中回到原半径与 auto 标签', () => {
    const attrs = node2DAttrs(node());
    expect(focusAttrs(attrs, false)).toEqual({ size: attrs.baseSize, labelVisibility: 'auto' });
  });

  it('高亮不改 ftype 颜色', () => {
    const attrs = node2DAttrs(node({ ftype: 'episodic' }), 'active');
    expect(attrs.color).toBe('#a78bfa');
  });
});

describe('标签：截断与可见性', () => {
  it('短标签原样保留', () => {
    expect(shortLabel('  短  ')).toBe('短');
  });

  it('超长标签截到上限并以省略号收尾', () => {
    const out = shortLabel('一'.repeat(80), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('只有活跃态给 forced label，沉默/次级交给网格抽样', () => {
    expect(node2DAttrs(node(), 'active').labelVisibility).toBe('visible');
    expect(node2DAttrs(node(), 'secondary').labelVisibility).toBe('auto');
    expect(node2DAttrs(node()).labelVisibility).toBe('auto');
  });
});
