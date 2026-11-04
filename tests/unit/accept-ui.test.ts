import { describe, expect, it } from 'vitest';
import {
  ACCEPT_UI_PAGES,
  MAX_CALLS,
  buildReport,
  decideVerdict,
  formatPageLine,
  medianFps,
  type GraphReadout,
  type PageSample,
} from '../../tools/accept-ui-lib.js';

function page(over: Partial<PageSample> = {}): PageSample {
  return {
    page: 'memories',
    path: '/ui/memories',
    title: '默识 · 记忆',
    calls: null,
    fps: 60,
    frame_samples: [60, 60, 60],
    selectors: { shell: true },
    screenshot: 'temp/accept-ui/x/memories.png',
    screenshot_ms: 10,
    ...over,
  };
}

function allPages(graphFps = 60): PageSample[] {
  return ACCEPT_UI_PAGES.map((key) =>
    page({ page: key, path: `/ui/${key}`, calls: key === 'graph' ? 8 : null, fps: graphFps }),
  );
}

function graph(over: Partial<GraphReadout> = {}): GraphReadout {
  return { calls: 8, nodeCount: 5000, edgeCount: 15000, fps: 60, ...over };
}

describe('P2-19-B：accept-ui 纯函数', () => {
  it('空样本与无有限样本 → null（不把「没采到」当成 0）', () => {
    expect(medianFps([])).toBeNull();
    expect(medianFps([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it('medianFps 取中位数（奇偶）', () => {
    expect(medianFps([30, 10, 20])).toBe(20);
    expect(medianFps([10, 20, 30, 40])).toBe(25);
  });

  it(`calls=${String(MAX_CALLS)} 且 fps 正常 → pass`, () => {
    const verdict = decideVerdict({ pages: allPages(), graph: graph({ calls: MAX_CALLS }) });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.violations).toEqual([]);
  });

  it(`calls=${String(MAX_CALLS + 1)} → fail（calls=13 > 12）`, () => {
    const verdict = decideVerdict({ pages: allPages(), graph: graph({ calls: MAX_CALLS + 1 }) });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.violations).toEqual([{ page: 'graph', reason: 'calls=13 > 12' }]);
  });

  it('fps < 30 → warn 而不是 fail', () => {
    const pages = allPages(29.9);
    const verdict = decideVerdict({ pages, graph: graph({ fps: 29.9 }) });
    expect(verdict.verdict).toBe('warn');
    expect(verdict.violations).toEqual([]);
    expect(verdict.warnings.length).toBeGreaterThanOrEqual(1);
    expect(verdict.warnings[0]?.reason).toBe('fps=29.9 < 30');
  });

  it('fps 恰好 30 → 不警告', () => {
    const verdict = decideVerdict({ pages: allPages(30), graph: graph({ fps: 30 }) });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.warnings).toEqual([]);
  });

  it('缺页 → fail（page_missing）', () => {
    const pages = allPages().filter((p) => p.page !== 'settings');
    const verdict = decideVerdict({ pages, graph: graph() });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.violations).toContainEqual({ page: 'settings', reason: 'page_missing' });
  });

  it('没读到 __moshiGraph（calls 缺失）→ fail（calls_missing）', () => {
    const verdict = decideVerdict({ pages: allPages(), graph: graph({ calls: null }) });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.violations).toContainEqual({ page: 'graph', reason: 'calls_missing' });
  });

  it('buildReport 写 schema / 摘要 / 判定', () => {
    const report = buildReport({
      at: '2026-11-04T00:00:00.000Z',
      baseUrl: 'http://127.0.0.1:1',
      facts: 5000,
      edges: 15000,
      pages: allPages(),
      graph: graph(),
    });
    expect(report.schema).toBe('moshi-accept-ui/1');
    expect(report.pages).toHaveLength(5);
    expect(report.verdict).toBe('pass');
    expect(report.violations).toEqual([]);
  });

  it('formatPageLine 打印 fps/calls/nodes/edges；fps 低时前缀 WARN', () => {
    const line = formatPageLine(page({ page: 'graph', path: '/ui/graph', calls: 8 }), graph());
    for (const needle of ['PASS', 'graph', '/ui/graph', 'fps=60', 'calls=8', 'nodes=5000', 'edges=15000']) {
      expect(line).toContain(needle);
    }
    const warn = formatPageLine(page({ fps: 12.5 }), graph());
    expect(warn.startsWith('WARN')).toBe(true);
  });
});
