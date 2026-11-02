/**
 * 跨视图共享的筛选态（详设 §10.2 的 `useFilter`，P2-05 落地）。
 *
 * **URL query 是唯一真相源，store 只是它的镜像**：本 store 不持有任何
 * "另一份筛选"，`filter` 字段永远等于 `parseFilterFromSearch(location.search)`
 * 的解析结果。三条铁律（详设 §10.2 / 台账 P2-05 的坑）：
 *
 * 1. 修改只走 `set()` / `reset()`：先写 URL（`pushState`，可后退）→ 再从 URL
 *    解析回 store。绝不在别处直接改 store 的 `filter`。
 * 2. 浏览器后退 / 前进（`popstate`）由调用方（main.tsx）调 `syncFromURL()`，
 *    重新解析 URL 覆盖 store——筛选状态跟 URL 走，不跟内存走。
 * 3. 写 URL 时保留其它参数（`view` / `limit` / `token`），只替换筛选键。
 *
 * 为什么不能"store 存一份、URL 存一份、手动同步"：双份必然不同步——刷新、
 * 后退、分享链接打开时 URL 才是被浏览器持久化的那一份，任何只改 store 的
 * 路径都会在导航后丢状态（台账 P2-05 的坑）。
 */
import { create } from 'zustand';
import {
  EMPTY_FILTER,
  filterToSearch,
  isEmptyFilter,
  parseFilterFromSearch,
  type FilterState,
} from '../filter/pure/filter.js';

/** 属于筛选器的 URL 键：写 URL 时只动这些，其它参数原样保留 */
const FILTER_KEYS = ['scope', 'ftype', 'status', 'strength', 'from', 'to', 'pool'] as const;

export interface FilterStore {
  /** URL 的解析镜像。读它 = 读 URL，永不手动赋值 */
  filter: FilterState;
  /** 是否处于非默认态（FilterBar 用来亮"已筛选"标记 / 提供一键重置） */
  active: boolean;
  /** 合并筛选变更：写 URL（pushState，可后退）→ 从 URL 解析回 store */
  set(patch: Partial<FilterState>): void;
  /** 清空全部筛选：写 URL → 从 URL 解析回 store */
  reset(): void;
  /** 从当前 URL 重新解析并覆盖 store：popstate / 外部导航的唯二入口之一 */
  syncFromURL(): void;
}

/**
 * 把筛选状态写进当前 URL 的 query（只替换筛选键，保留 view / limit / token 等），
 * 并 `pushState` 进历史——浏览器后退/前进能回到上一个筛选状态（验收项）。
 */
function applyFilterToURL(filter: FilterState): void {
  const url = new URL(window.location.href);
  for (const key of FILTER_KEYS) url.searchParams.delete(key);
  const serialized = filterToSearch(filter);
  // filterToSearch 返回不含 `?` 的片段；逐键写回，保证编码一致
  for (const [key, value] of new URLSearchParams(serialized)) {
    url.searchParams.set(key, value);
  }
  window.history.pushState({ moshiFilter: true }, '', `${url.pathname}${url.search}${url.hash}`);
}

function fromCurrentURL(): { filter: FilterState; active: boolean } {
  const filter = parseFilterFromSearch(window.location.search);
  return { filter, active: !isEmptyFilter(filter) };
}

export const useFilter = create<FilterStore>()((set, get) => ({
  ...fromCurrentURL(),
  set: (patch) => {
    // 兼容调用方只传 part：时间区间要求整对象（从当前值拷贝再改单端），这里合并兜底
    const next: FilterState = { ...get().filter, ...patch };
    if (patch.timeRange !== undefined) {
      next.timeRange = { ...get().filter.timeRange, ...patch.timeRange };
    }
    applyFilterToURL(next);
    set(fromCurrentURL());
  },
  reset: () => {
    applyFilterToURL(EMPTY_FILTER);
    set(fromCurrentURL());
  },
  syncFromURL: () => set(fromCurrentURL()),
}));
