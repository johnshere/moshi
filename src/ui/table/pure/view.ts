import type { SortKey } from './rows.js';

/**
 * 表格视图的 URL 契约（纯函数）。
 *
 * `?view=table&q=...&sort=importance` 是分享/后退的唯一真相源：`q` 与 `sort` 都进 URL，
 * 这样"搜到一半刷新""把链接发给别人"看到的是同一屏。反过来 `parseTableView` 只认
 * 两个 sort 值，其余一律回落 `time`——URL 是用户可编辑的，不能让非法值穿透到 SQL。
 */
export interface TableViewState {
  q: string;
  sort: SortKey;
}

/** 从 `location.search` 读表格态；`sort` 非 `importance` 一律视为默认的 `time` */
export function parseTableView(search: string): TableViewState {
  const params = new URLSearchParams(search);
  return {
    q: (params.get('q') ?? '').trim(),
    sort: params.get('sort') === 'importance' ? 'importance' : 'time',
  };
}

/**
 * 把表格态写回 href 其余参数原样保留（`token`、以及将来 P2-05 的筛选器）。
 *
 * 默认值不进 URL：空 `q` 删参数、`sort=time` 删参数，避免出现
 * `?view=table&q=&sort=time` 这种"看起来设置了什么"的噪声。
 */
export function tableViewHref(href: string, state: TableViewState): string {
  const url = new URL(href);
  url.searchParams.set('view', 'table');
  const q = state.q.trim();
  if (q === '') url.searchParams.delete('q');
  else url.searchParams.set('q', q);
  if (state.sort === 'importance') url.searchParams.set('sort', 'importance');
  else url.searchParams.delete('sort');
  return url.toString();
}
