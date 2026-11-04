/**
 * 列表导航上下文（P2-19A-07b，概设 §8.9 的 j/k 可达）。
 *
 * 谁注册：页面把「当前可上下移动的行 id 列表」交给 `setItems`（memories 表格、
 * inbox 当前 tab 的队列）。谁执行：`Shell` 的全局 keydown 调 `move(±1)`。
 *
 * 不新造选中态：`move` 最终调既有 `useSelection.select`，检查器/2D/3D 都订阅同一份。
 * 为什么 `activeId` 单独存：选中可能来自表格点击或深链，`items` 里未必马上有该 id；
 * 以 `activeId ?? useSelection.focusId` 作为当前位置，既尊重外部选中，也能从「无选中」起步。
 */
import { create } from 'zustand';
import { useSelection } from './selection.js';

export interface NavState {
  /** 当前页可移动的 id 顺序（页面注册；空 = 无列表上下文，j/k 静默忽略） */
  items: readonly string[];
  /** 上一次 j/k 落到的 id；不在 items 里时退回 focusId */
  activeId: string | null;
  setItems(ids: readonly string[]): void;
  /** 清空注册（页面卸载时调用；不动用户选中） */
  clear(): void;
  /** 下/上移动一步并选中；无列表返回 null */
  move(delta: 1 | -1): string | null;
}

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export const useNav = create<NavState>()((set, get) => ({
  items: [],
  activeId: null,
  setItems: (ids) => {
    const next = ids.filter((id) => id !== '');
    set((prev) => {
      if (sameItems(prev.items, next)) return prev;
      const activeId = prev.activeId !== null && next.includes(prev.activeId) ? prev.activeId : null;
      return { items: next, activeId };
    });
  },
  clear: () => {
    set((prev) => (prev.items.length === 0 && prev.activeId === null ? prev : { items: [], activeId: null }));
  },
  move: (delta) => {
    const { items } = get();
    if (items.length === 0) return null;
    const focusId = useSelection.getState().focusId;
    const current = get().activeId ?? focusId;
    const at = current === null ? -1 : items.indexOf(current);
    // 无当前位置时：j 从第一条开始，k 从最后一条开始（与常见分页器一致）
    const base = at === -1 ? (delta === 1 ? -1 : items.length) : at;
    const index = Math.min(items.length - 1, Math.max(0, base + delta));
    const id = items[index];
    if (id === undefined) return null;
    set({ activeId: id });
    useSelection.getState().select(id);
    return id;
  },
}));
