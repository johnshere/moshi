/**
 * 表格视图 URL 契约（P2-04）：`?view=table&q=...&sort=importance`。
 *
 * 钉死两件事：
 * 1. 非法 sort 不可能穿透到 SQL（`sort=bogus` 一律回落 `time`）；
 * 2. 默认值不写进 URL（空 q 删参数、sort=time 删参数），否则分享出去的链接会
 *    带一堆"看起来设置了什么"的噪声。
 */
import { describe, expect, it } from 'vitest';
import { parseTableView, tableViewHref } from '../../src/ui/table/pure/view.js';

const BASE = 'http://127.0.0.1:53000/ui/graph/';

describe('parseTableView', () => {
  it('缺省 → 空搜索 + 时间序', () => {
    expect(parseTableView('')).toEqual({ q: '', sort: 'time' });
  });

  it('读出 q，两侧空白去掉', () => {
    expect(parseTableView('?view=table&q=%20rust%20')).toEqual({ q: 'rust', sort: 'time' });
  });

  it('sort=importance 生效；其它值一律回落 time', () => {
    expect(parseTableView('?sort=importance').sort).toBe('importance');
    expect(parseTableView('?sort=strength').sort).toBe('time');
    expect(parseTableView('?sort=IMPORTANCE').sort).toBe('time');
  });
});

describe('tableViewHref', () => {
  it('设置 view=table 并保留其它参数（token 不能被切视图弄丢）', () => {
    const href = tableViewHref(`${BASE}?view=3d&token=abc`, { q: '', sort: 'time' });
    const url = new URL(href);
    expect(url.searchParams.get('view')).toBe('table');
    expect(url.searchParams.get('token')).toBe('abc');
    expect(url.pathname).toBe('/ui/graph/');
  });

  it('空 q 删参数、sort=time 删参数', () => {
    const href = tableViewHref(`${BASE}?view=table&q=old&sort=importance`, { q: '   ', sort: 'time' });
    const url = new URL(href);
    expect(url.searchParams.get('q')).toBeNull();
    expect(url.searchParams.get('sort')).toBeNull();
  });

  it('非空 q 与 sort=importance 写进 URL', () => {
    const url = new URL(tableViewHref(`${BASE}?view=table`, { q: ' vec ', sort: 'importance' }));
    expect(url.searchParams.get('q')).toBe('vec');
    expect(url.searchParams.get('sort')).toBe('importance');
  });

  it('往返一致：写进去再读出来是同一个状态（分享/刷新不丢）', () => {
    const state = { q: 'sqlite', sort: 'importance' as const };
    const href = tableViewHref(BASE, state);
    expect(parseTableView(new URL(href).search)).toEqual(state);
  });
});
