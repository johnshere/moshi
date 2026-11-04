/**
 * P2-19-B 视觉层纯函数：取色 token（node 环境走 fallback）+ 方向箭头/扫描环/网格数学。
 *
 * 这两层刻意不 import DOM / three / sigma：根 vitest 的 node 环境直接测，
 * shader 与 2D canvas 用的是同一组常量，避免"单测一条公式、渲染另一条"。
 */
import { describe, expect, it } from 'vitest';

import {
  arrowCss,
  bgBaseHex,
  boxBorderCss,
  boxFillCss,
  etypeHex,
  ftypeHex,
  gridCss,
  haloStops,
  labelCss,
  layerPlaneHexes,
  mixWith,
  mixWithTransparent,
  readToken,
  resetPaletteCache,
  sceneBackdropCss,
  sceneVignetteCss,
  selectionRingRgb,
  stageGlowCss,
  withAlpha,
} from '../../src/ui/graph/pure/palette.js';
import {
  ARROW_MAX_2D,
  ARROW_MIN_LENGTH_PX,
  ARROW_SPEED,
  SCAN_SPEED,
  SCAN_WIDTH,
  angularDistance,
  arrowPhase,
  arrowStride,
  coreGlow,
  gridOpacity,
  placeArrow,
  ringBand,
  scanAngle,
  scanBand,
  screenLength,
  sphereRim,
  type ProjectedEdge,
} from '../../src/ui/graph/pure/fx.js';

const EDGE: ProjectedEdge = { ax: 0, ay: 0, bx: 100, by: 0, mass: 0.5, flow: 0.6, hopPhase: 0, dir: 0 };

describe('palette：无 DOM 时回落旧色板', () => {
  it('readToken 读不到 CSS 变量时用 fallback', () => {
    resetPaletteCache();
    expect(readToken('--color-bg-base')).toBe('#05070d');
    expect(readToken('--color-accent')).toBe('#22d3ee');
    expect(readToken('--color-glow')).toBe('#7dd3fc');
    expect(readToken('--color-danger')).toBe('#ef4444');
  });

  it('bgBaseHex 与 readToken 同源，resetPaletteCache 后一致', () => {
    resetPaletteCache();
    expect(bgBaseHex()).toBe(readToken('--color-bg-base'));
  });

  it('ftype 语义色：semantic→accent、episodic→accent-alt、未知→semantic fallback', () => {
    resetPaletteCache();
    expect(ftypeHex('semantic')).toBe('#22d3ee');
    expect(ftypeHex('episodic')).toBe('#a78bfa');
    // conditional 没有 token，落在固定 fallback
    expect(ftypeHex('conditional')).toBe('#f59e0b');
    expect(ftypeHex('nope')).toBe('#22d3ee');
  });

  it('etype 语义色：logic→accent、supersedes→danger、co_occur→muted、未知→derived_from', () => {
    resetPaletteCache();
    expect(etypeHex('logic')).toBe('#22d3ee');
    expect(etypeHex('supersedes')).toBe('#ef4444');
    expect(etypeHex('co_occur')).toBe('#64748b');
    expect(etypeHex('derived_from')).toBe('#1e293b');
    expect(etypeHex('depends_on')).toBe('#8b5cf6');
    expect(etypeHex('nope')).toBe('#475569');
  });
});

describe('palette：颜色派生', () => {
  it('withAlpha 输出 rgba，alpha 夹 0–1，非法 hex 走中性灰', () => {
    expect(withAlpha('#22d3ee', 0.5)).toBe('rgba(34, 211, 238, 0.5)');
    expect(withAlpha('#22d3ee', 2)).toBe('rgba(34, 211, 238, 1)');
    expect(withAlpha('#22d3ee', -1)).toBe('rgba(34, 211, 238, 0)');
    expect(withAlpha('oops', 0.25)).toBe('rgba(150, 150, 150, 0.25)');
  });

  it('mixWithTransparent / mixWith 输出 color-mix 并按 0–100 夹住', () => {
    expect(mixWithTransparent('#22d3ee', 40)).toBe('color-mix(in srgb, #22d3ee 40%, transparent)');
    expect(mixWithTransparent('#22d3ee', 400)).toBe('color-mix(in srgb, #22d3ee 100%, transparent)');
    expect(mixWith('#22d3ee', '#05070d', 12)).toBe('color-mix(in srgb, #22d3ee 12%, #05070d)');
  });

  it('selectionRingRgb 把 accent 转成 0–1 三段', () => {
    resetPaletteCache();
    expect(selectionRingRgb()).toEqual([34 / 255, 211 / 255, 238 / 255]);
  });

  it('layerPlaneHexes 四层顺序 = 活跃 / 中 / 低 / 失效', () => {
    resetPaletteCache();
    expect(layerPlaneHexes()).toEqual(['#22d3ee', '#64748b', '#1e293b', '#ef4444']);
  });

  it('haloStops 三段：白心 → glow 半透明 → glow 全透明', () => {
    resetPaletteCache();
    expect(haloStops()).toEqual([
      'rgba(255, 255, 255, 0.9)',
      'rgba(125, 211, 252, 0.28)',
      'rgba(125, 211, 252, 0)',
    ]);
  });
});

describe('palette：CSS 片段只引用 token', () => {
  it('背景/雾/网格/标签/框选/箭头都不含裸 hex 字面量以外的写死颜色', () => {
    resetPaletteCache();
    expect(sceneBackdropCss()).toContain('radial-gradient');
    expect(sceneBackdropCss()).toContain('linear-gradient');
    expect(sceneVignetteCss()).toContain('radial-gradient');
    expect(gridCss()).toContain('repeating-linear-gradient');
    expect(stageGlowCss()).toContain('radial-gradient');
    expect(labelCss()).toContain('font:11px');
    expect(boxBorderCss()).toBe('rgba(125, 211, 252, 0.85)');
    expect(boxFillCss()).toBe('rgba(34, 211, 238, 0.12)');
    expect(arrowCss(0.4)).toBe('rgba(125, 211, 252, 0.55)');
  });
});

describe('fx：箭头密度与相位', () => {
  it('arrowStride 至少 1，并按可见边数/上限向上取整', () => {
    expect(arrowStride(0)).toBe(1);
    expect(arrowStride(1)).toBe(1);
    expect(arrowStride(ARROW_MAX_2D)).toBe(1);
    expect(arrowStride(ARROW_MAX_2D * 3)).toBe(3);
    expect(arrowStride(301, 100)).toBe(4);
  });

  it('arrowStride 非法输入回退 1', () => {
    expect(arrowStride(Number.NaN)).toBe(1);
    expect(arrowStride(Number.POSITIVE_INFINITY)).toBe(1);
    expect(arrowStride(10, 0)).toBe(1);
  });

  it('arrowPhase 落在 [0,1)，flow=0 时等于 hopPhase 相位', () => {
    const phase = arrowPhase(2, ARROW_SPEED, 0.33);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
    expect(arrowPhase(0, 0, 0.33)).toBeCloseTo(0.33, 5);
    expect(arrowPhase(Number.NaN, 1, 0)).toBe(0);
  });

  it('placeArrow dir=0 从 src 指向 dst，dir=1 反向', () => {
    const forward = placeArrow(EDGE, 0.5);
    expect(forward.x).toBeCloseTo(50, 4);
    expect(forward.y).toBeCloseTo(0, 4);
    expect(forward.angle).toBeCloseTo(0, 6);
    expect(forward.mass).toBe(0.5);

    const backward = placeArrow({ ...EDGE, dir: 1 }, 0.5);
    expect(backward.x).toBeCloseTo(50, 4);
    expect(backward.angle).toBeCloseTo(Math.PI, 6);
  });

  it('placeArrow 两端留白、t 夹 0–1', () => {
    expect(placeArrow(EDGE, -1).x).toBeCloseTo(6, 4);
    expect(placeArrow(EDGE, 2).x).toBeCloseTo(94, 4);
  });

  it('screenLength 用屏幕距离，太短的边不画箭头', () => {
    expect(screenLength(EDGE)).toBeCloseTo(100, 6);
    expect(screenLength({ ...EDGE, bx: 5 })).toBeLessThan(ARROW_MIN_LENGTH_PX);
  });
});

describe('fx：扫描环与节点环', () => {
  it('scanAngle 落在 0–2π 并随时间循环', () => {
    expect(scanAngle(0)).toBe(0);
    expect(scanAngle((Math.PI * 2) / SCAN_SPEED)).toBeCloseTo(0, 6);
    expect(scanAngle(1)).toBeCloseTo(SCAN_SPEED, 6);
    expect(scanAngle(Number.NaN)).toBe(0);
  });

  it('angularDistance 取最短角距（含跨 0 点）', () => {
    expect(angularDistance(0.1, 0)).toBeCloseTo(0.1, 6);
    expect(angularDistance(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(0.2, 6);
    expect(angularDistance(Math.PI, 0)).toBeCloseTo(Math.PI, 6);
  });

  it('scanBand 在扫描线附近最亮、超出宽度为 0', () => {
    expect(scanBand(0.3, 0.3)).toBeCloseTo(1, 6);
    expect(scanBand(0.3, 0.3 + SCAN_WIDTH / 2)).toBeCloseTo(0.5, 6);
    expect(scanBand(0.3, 0.3 + SCAN_WIDTH + 0.2)).toBe(0);
  });

  it('sphereRim：正对相机 0、轮廓 1', () => {
    expect(sphereRim(1)).toBe(0);
    expect(sphereRim(-1)).toBe(0);
    expect(sphereRim(0)).toBe(1);
    expect(sphereRim(Number.NaN)).toBe(0);
  });

  it('ringBand 在 0.74–0.86 亮起、0.96 之后收掉', () => {
    expect(ringBand(0.5)).toBe(0);
    expect(ringBand(0.86)).toBeGreaterThan(0.9);
    expect(ringBand(1)).toBe(0);
  });

  it('coreGlow 内芯 1、rim 0.45 之后为 0', () => {
    expect(coreGlow(0)).toBe(1);
    expect(coreGlow(0.45)).toBe(0);
    expect(coreGlow(0.9)).toBe(0);
  });
});

describe('fx：网格雾', () => {
  it('gridOpacity 随缩放变淡，越界夹在 0.12–0.42', () => {
    expect(gridOpacity(0)).toBeCloseTo(0.42, 6);
    expect(gridOpacity(0.5)).toBeCloseTo(0.27, 6);
    expect(gridOpacity(1)).toBeCloseTo(0.12, 6);
    expect(gridOpacity(-1)).toBeCloseTo(0.42, 6);
    expect(gridOpacity(3)).toBeCloseTo(0.12, 6);
    expect(gridOpacity(Number.NaN)).toBe(0);
  });
});
