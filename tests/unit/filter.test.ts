/**
 * 筛选器 URL 契约（P2-05 / 详设 §10.2）。
 *
 * `useFilter` 以 URL query 为唯一真相源，这里钉死解析/序列化纯函数：
 * 1. 合法值（含逗号分隔多值）解析正确；
 * 2. 非法值（不在值域内的枚举、非 ISO 时间）一律丢弃，不回退成别的值；
 * 3. 默认值不写进 URL（空筛选序列化 = 空串），否则分享链接带噪声；
 * 4. 往返一致：写进去再读出来是同一个状态（"复制 URL 打开一致"的验收基础）。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  filterToSearch,
  isEmptyFilter,
  parseFilterFromSearch,
  type FilterState,
} from '../../src/ui/filter/pure/filter.js';

describe('parseFilterFromSearch', () => {
  it('缺省 → 全部放开（EMPTY_FILTER）', () => {
    expect(parseFilterFromSearch('')).toEqual(EMPTY_FILTER);
    expect(parseFilterFromSearch('?view=table&q=x')).toEqual(EMPTY_FILTER);
  });

  it('scope 读出并去空白；空串 = 不限', () => {
    expect(parseFilterFromSearch('?scope=%20project%3Afoo%20').scope).toBe('project:foo');
    expect(parseFilterFromSearch('?scope=%20%20').scope).toBeNull();
  });

  it('ftype 逗号分隔多值；值域外项丢弃', () => {
    const f = parseFilterFromSearch('?ftype=semantic,episodic,meta');
    expect(f.ftype).toEqual(['semantic', 'episodic']);
  });

  it('status 逗号分隔多值；值域外项丢弃', () => {
    const f = parseFilterFromSearch('?status=active,disputed,bogus');
    expect(f.status).toEqual(['active', 'disputed']);
  });

  it('strength 带只认四层；其它值一律 null', () => {
    expect(parseFilterFromSearch('?strength=high').strengthBand).toBe('high');
    expect(parseFilterFromSearch('?strength=invalid').strengthBand).toBe('invalid');
    expect(parseFilterFromSearch('?strength=0.5').strengthBand).toBeNull();
    expect(parseFilterFromSearch('?strength=HIGH').strengthBand).toBeNull();
  });

  it('from/to 非 ISO 一律丢弃', () => {
    expect(parseFilterFromSearch('?from=2026-11-01T00:00:00Z').timeRange.from).toBe('2026-11-01T00:00:00Z');
    expect(parseFilterFromSearch('?from=not-a-date').timeRange.from).toBeNull();
    expect(parseFilterFromSearch('?to=2026-11-02').timeRange.to).toBe('2026-11-02');
  });

  it('pool 逗号分隔多值；值域外项丢弃', () => {
    const f = parseFilterFromSearch('?pool=utility,value_floor,other');
    expect(f.pool).toEqual(['utility', 'value_floor']);
  });
});

describe('filterToSearch', () => {
  it('空筛选 → 空串（不写任何参数）', () => {
    expect(filterToSearch(EMPTY_FILTER)).toBe('');
  });

  it('只写非默认键，且逗号分隔多值', () => {
    const f: FilterState = {
      scope: 'project:x',
      ftype: ['semantic', 'episodic'],
      status: [],
      strengthBand: null,
      timeRange: { from: null, to: null },
      pool: [],
    };
    const q = filterToSearch(f);
    expect(q).toContain('scope=project%3Ax');
    expect(q).toContain('ftype=semantic%2Cepisodic');
    expect(q).not.toContain('status=');
  });

  it('往返一致：写进去再读出来是同一个状态', () => {
    const f: FilterState = {
      scope: 'project:core',
      ftype: ['semantic'],
      status: ['active', 'disputed'],
      strengthBand: 'high',
      timeRange: { from: '2026-11-01T00:00:00Z', to: '2026-11-02T23:59:59Z' },
      pool: ['utility'],
    };
    expect(parseFilterFromSearch(filterToSearch(f))).toEqual(f);
  });
});

describe('isEmptyFilter', () => {
  it('全部放开 = true；任一维度非空 = false', () => {
    expect(isEmptyFilter(EMPTY_FILTER)).toBe(true);
    expect(isEmptyFilter({ ...EMPTY_FILTER, scope: 'global' })).toBe(false);
    expect(isEmptyFilter({ ...EMPTY_FILTER, ftype: ['semantic'] })).toBe(false);
  });
});
