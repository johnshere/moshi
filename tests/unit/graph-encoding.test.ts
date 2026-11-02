/**
 * 视觉编码纯函数测试（P2-02 / 详设 §10.3 编码表）。
 *
 * 这些是 3D 场景里唯一"算错了也看不出来"的部分——颜色、层高、半径、脉冲曲线
 * 错了顶多显得不好看，但会让人误判事实状态。所以全部钉在这里，不依赖 WebGL。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_LAYER_MIN_Y,
  ETYPE_ORDER,
  FTYPE_HEX,
  LAYER_INVALID,
  LAYER_MID,
  LAYER_TOP,
  PULSE_DURATION_S,
  SINK_DURATION_MS,
  alphaForStrength,
  easeOutCubic,
  edgeWidthForConfidence,
  etypeColor,
  etypeColorTable,
  etypeIndex,
  flowSpeedForActivity,
  ftypeColor,
  hexToRgb,
  isActiveLayer,
  layerY,
  normalizeActivity,
  pulseScale,
  radiusForImportance,
  sinkY,
} from '../../src/ui/graph/pure/encoding.js';

describe('ftype → 色相', () => {
  it('三类事实各归其色', () => {
    expect(ftypeColor('semantic')).toEqual(hexToRgb(FTYPE_HEX.semantic));
    expect(ftypeColor('episodic')).toEqual(hexToRgb(FTYPE_HEX.episodic));
    expect(ftypeColor('conditional')).toEqual(hexToRgb(FTYPE_HEX.conditional));
  });

  it('未知类型退回 semantic 色，不返回黑', () => {
    expect(ftypeColor('nonsense')).toEqual(hexToRgb(FTYPE_HEX.semantic));
  });

  it('#22d3ee → 归一化 RGB', () => {
    const [r, g, b] = hexToRgb('#22d3ee');
    expect(r).toBeCloseTo(0x22 / 255, 6);
    expect(g).toBeCloseTo(0xd3 / 255, 6);
    expect(b).toBeCloseTo(0xee / 255, 6);
  });
});

describe('etype → 边色 / aType 序号', () => {
  it('ETYPE_ORDER 覆盖 6 种边型且顺序稳定', () => {
    expect(ETYPE_ORDER).toHaveLength(6);
    expect([...ETYPE_ORDER]).toEqual([
      'depends_on',
      'logic',
      'mutually_exclusive',
      'co_occur',
      'supersedes',
      'derived_from',
    ]);
  });

  it('序号就是数组下标，未知类型落到最后一个槽位', () => {
    ETYPE_ORDER.forEach((e, i) => expect(etypeIndex(e)).toBe(i));
    expect(etypeIndex('unknown_etype')).toBe(ETYPE_ORDER.length - 1);
  });

  it('别名 mutex / derived 与正式名同色', () => {
    expect(etypeColor('mutex')).toEqual(etypeColor('mutually_exclusive'));
    expect(etypeColor('derived')).toEqual(etypeColor('derived_from'));
    expect(etypeColor('supersedes')).toEqual(hexToRgb('#ef4444'));
  });

  it('色表长度与 ETYPE_ORDER 一致（shader uniform 数组按此上传）', () => {
    expect(etypeColorTable()).toHaveLength(ETYPE_ORDER.length);
  });
});

describe('strength → Y 四层', () => {
  it('四个层的锚点', () => {
    expect(layerY(0.7)).toBeCloseTo(LAYER_TOP - 20, 6);
    expect(layerY(0.3)).toBeCloseTo(LAYER_MID - 20, 6);
    expect(layerY(0)).toBeCloseTo(-80, 6);
    expect(layerY(0.5, true)).toBe(LAYER_INVALID);
  });

  it('层内 ±20 线性微调：上边界落在 +80', () => {
    expect(layerY(1)).toBeCloseTo(80, 6);
    expect(layerY(0.5)).toBeCloseTo(0, 6);
    expect(layerY(0.15)).toBeCloseTo(-60, 6);
  });

  it('strength 单调递增 → y 单调递增（不跳层的区间内）', () => {
    const top = [0.7, 0.8, 0.9, 1].map((s) => layerY(s));
    const mid = [0.3, 0.4, 0.5, 0.6].map((s) => layerY(s));
    for (let i = 1; i < top.length; i++) expect(top[i]!).toBeGreaterThan(top[i - 1]!);
    for (let i = 1; i < mid.length; i++) expect(mid[i]!).toBeGreaterThan(mid[i - 1]!);
  });

  it('失效层在最底下，比任何正常层都低', () => {
    expect(layerY(1, true)).toBeLessThan(layerY(0));
  });

  it('活跃层阈值 = 顶层下沿 40', () => {
    expect(ACTIVE_LAYER_MIN_Y).toBe(40);
    expect(isActiveLayer(40)).toBe(true);
    expect(isActiveLayer(39.9)).toBe(false);
  });
});

describe('importance → 半径、strength → 不透明度', () => {
  it('半径 3..12 px 线性，越界夹取', () => {
    expect(radiusForImportance(0)).toBeCloseTo(3, 6);
    expect(radiusForImportance(1)).toBeCloseTo(12, 6);
    expect(radiusForImportance(0.5)).toBeCloseTo(7.5, 6);
    expect(radiusForImportance(-1)).toBeCloseTo(3, 6);
    expect(radiusForImportance(2)).toBeCloseTo(12, 6);
  });

  it('不透明度 0.35 + 0.65s', () => {
    expect(alphaForStrength(0)).toBeCloseTo(0.35, 6);
    expect(alphaForStrength(1)).toBeCloseTo(1, 6);
    expect(alphaForStrength(0.5)).toBeCloseTo(0.675, 6);
  });
});

describe('confidence → 边宽、活跃度 → 流动速度', () => {
  it('边宽 0.5..2.0 px', () => {
    expect(edgeWidthForConfidence(0)).toBeCloseTo(0.5, 6);
    expect(edgeWidthForConfidence(1)).toBeCloseTo(2, 6);
  });

  it('零访问静止，归一化后线性增长', () => {
    expect(normalizeActivity(0, 10)).toBe(0);
    expect(normalizeActivity(5, 10)).toBeCloseTo(0.5, 6);
    expect(normalizeActivity(99, 10)).toBe(1);
    expect(normalizeActivity(3, 0)).toBe(0);
    expect(flowSpeedForActivity(0)).toBe(0);
    expect(flowSpeedForActivity(1)).toBeGreaterThan(0);
  });
});

describe('查询命中 → 脉冲曲线', () => {
  it('t=0 从 1 起跳，2s 末已衰减回 1 附近（窗口外恒 1）', () => {
    expect(pulseScale(0)).toBeCloseTo(1, 6);
    expect(PULSE_DURATION_S).toBe(2);
    // 曲线是 0.6·sin(8t)·e^(−t/2)，t=2 时理论上还剩 −0.064 的余量
    expect(Math.abs(pulseScale(PULSE_DURATION_S) - 1)).toBeLessThan(0.1);
    expect(pulseScale(2.5)).toBe(1);
    expect(pulseScale(-1)).toBe(1);
  });

  it('窗口内出现过放大（峰值 > 1.3），且衰减到尾部小于峰值', () => {
    let peak = 1;
    for (let t = 0; t <= PULSE_DURATION_S; t += 0.01) peak = Math.max(peak, pulseScale(t));
    expect(peak).toBeGreaterThan(1.3);
    expect(peak).toBeLessThan(1.6 + 1e-9);
    const early = Math.abs(pulseScale(0.25) - 1);
    const late = Math.abs(pulseScale(1.75) - 1);
    expect(early).toBeGreaterThan(late);
  });
});

describe('下沉动画（跨层不瞬移）', () => {
  it('easeOutCubic 端点与中点', () => {
    expect(easeOutCubic(0)).toBeCloseTo(0, 6);
    expect(easeOutCubic(1)).toBeCloseTo(1, 6);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6);
  });

  it('2.5s 内从旧层平滑走到新层', () => {
    expect(SINK_DURATION_MS).toBe(2500);
    expect(sinkY(60, -60, 0)).toBeCloseTo(60, 6);
    expect(sinkY(60, -60, SINK_DURATION_MS)).toBeCloseTo(-60, 6);
    const mid = sinkY(60, -60, 625);
    expect(mid).toBeGreaterThan(-60);
    expect(mid).toBeLessThan(60);
  });

  it('单调下行，不会来回抖', () => {
    let prev = Infinity;
    for (let t = 0; t <= SINK_DURATION_MS; t += 100) {
      const y = sinkY(60, -60, t);
      expect(y).toBeLessThanOrEqual(prev + 1e-9);
      prev = y;
    }
  });

  it('超时后停在目标层', () => {
    expect(sinkY(60, -60, SINK_DURATION_MS * 3)).toBeCloseTo(-60, 6);
  });
});
