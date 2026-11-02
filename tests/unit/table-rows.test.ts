/**
 * 表格视图纯逻辑（P2-04）：分页合并去重 / 预取判定 / 显示格式。
 *
 * 钉死三件事：
 * 1. keyset 页间重复行不会在列表里出现两次（并发写入下真会发生）；
 * 2. "什么时候续拉"只由可见区下沿决定，不会在首屏就一次拉全量；
 * 3. 时间列是本地时间到分钟（不是 ISO、不是 UTC）。
 */
import { describe, expect, it } from 'vitest';
import {
  PAGE_LIMIT,
  PREFETCH_AHEAD,
  ROW_HEIGHT,
  formatLocalMinute,
  formatScore,
  mergePage,
  oneLine,
  shouldPrefetch,
  type FactRow,
} from '../../src/ui/table/pure/rows.js';

function row(id: string, extra: Partial<FactRow> = {}): FactRow {
  return {
    id,
    content: `内容 ${id}`,
    ftype: 'semantic',
    confidence: 0.9,
    strength: 0.5,
    importance: 0.5,
    epistemic_status: 'active',
    valid_at: '2026-11-02T07:57:00.000Z',
    valid_to: null,
    recorded_at: '2026-11-02T07:57:00.000Z',
    ...extra,
  };
}

describe('常量口径', () => {
  it('单页 200 行、提前量 20 行、固定行高 32px（详设 §10.8）', () => {
    expect(PAGE_LIMIT).toBe(200);
    expect(PREFETCH_AHEAD).toBe(20);
    expect(ROW_HEIGHT).toBe(32);
  });
});

describe('mergePage', () => {
  it('首屏直接追加', () => {
    const { rows, added } = mergePage([], [row('a'), row('b')]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(added).toBe(2);
  });

  it('页间重复 id 就地丢弃（keyset 并发写入会重取上一页的行）', () => {
    const prev = [row('a'), row('b')];
    const { rows, added } = mergePage(prev, [row('b'), row('c')]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(added).toBe(1);
  });

  it('整页都是重复 → added=0（调用方据此判停滞游标，不再续拉）', () => {
    const prev = [row('a'), row('b')];
    const { rows, added } = mergePage(prev, [row('a'), row('b')]);
    expect(rows).toHaveLength(2);
    expect(added).toBe(0);
  });

  it('不修改传入数组（React state 直接复用旧引用会漏渲染）', () => {
    const prev = [row('a')];
    const copy = [...prev];
    mergePage(prev, [row('b')]);
    expect(prev).toEqual(copy);
  });

  it('同一页内部重复也去重（只保留第一次出现的顺序）', () => {
    const { rows, added } = mergePage([], [row('a'), row('a')]);
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(added).toBe(1);
  });
});

describe('shouldPrefetch', () => {
  const base = { lastVisibleIndex: 180, loaded: 200, hasMore: true, loading: false };

  it('可见区下沿进入末尾前 20 行 → 拉下一页', () => {
    expect(shouldPrefetch(base)).toBe(true);
    expect(shouldPrefetch({ ...base, lastVisibleIndex: 199 })).toBe(true);
  });

  it('离末尾还远 → 不拉（首屏只请求一页，不预取全量）', () => {
    expect(shouldPrefetch({ ...base, lastVisibleIndex: 179 })).toBe(false);
    expect(shouldPrefetch({ ...base, lastVisibleIndex: 0 })).toBe(false);
  });

  it('已到底 / 请求在飞 / 空列表 / 可见区未算出 → 都不拉', () => {
    expect(shouldPrefetch({ ...base, hasMore: false })).toBe(false);
    expect(shouldPrefetch({ ...base, loading: true })).toBe(false);
    expect(shouldPrefetch({ ...base, loaded: 0, lastVisibleIndex: 0 })).toBe(false);
    expect(shouldPrefetch({ ...base, lastVisibleIndex: -1 })).toBe(false);
  });

  it('提前量可覆盖', () => {
    expect(shouldPrefetch({ ...base, lastVisibleIndex: 199, ahead: 1 })).toBe(true);
    expect(shouldPrefetch({ ...base, lastVisibleIndex: 198, ahead: 1 })).toBe(false);
  });
});

describe('formatLocalMinute', () => {
  it('本地时间到分钟（秒被截掉，不显示 ISO/UTC）', () => {
    const local = new Date(2026, 10, 2, 15, 57, 42); // 本地时间构造 → 时区无关
    expect(formatLocalMinute(local.toISOString())).toBe('2026-11-02 15:57');
  });

  it('个位月/日/时/分补零', () => {
    const local = new Date(2026, 0, 3, 4, 5, 0);
    expect(formatLocalMinute(local.toISOString())).toBe('2026-01-03 04:05');
  });

  it('非法输入不显示 NaN', () => {
    expect(formatLocalMinute('not-a-date')).toBe('—');
  });
});

describe('oneLine', () => {
  it('多行压成一行（换行 = 空格，避免截断点落在空白里）', () => {
    expect(oneLine('第一行\n第二行\t第三行')).toBe('第一行 第二行 第三行');
  });

  it('超长截断并加省略号，长度不超过 max', () => {
    const out = oneLine('x'.repeat(400), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('恰好等于上限时不截断', () => {
    const text = 'y'.repeat(160);
    expect(oneLine(text)).toBe(text);
  });
});

describe('formatScore', () => {
  it('0..1 统一两位小数', () => {
    expect(formatScore(0.5)).toBe('0.50');
    expect(formatScore(1)).toBe('1.00');
    expect(formatScore(0.123)).toBe('0.12');
  });

  it('非有限值不显示 NaN', () => {
    expect(formatScore(Number.NaN)).toBe('—');
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
