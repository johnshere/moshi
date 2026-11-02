/**
 * 跨视图共享的选中态（详设 §10.2 的 `useSelection`，P2-03 落地）。
 *
 * 为什么必须单独一个 store：3D 与 2D 是两个互不相识的渲染器（three / sigma），
 * 点选要从一个走到另一个，props 没有通路。URL 也不承载它——刷新丢选中是允许的，
 * URL 只承载过滤条件（详设 §10.2：`useFilter` 以 URL 为唯一真相源）。
 *
 * 两条订阅路径读的都是同一份状态：
 * - React 组件：`useSelection((s) => s.focusId)`（zustand 返回的就是 hook）
 * - 命令式渲染器（`GraphScene` / `SigmaScene`）：`useSelection.subscribe(listener)`
 *
 * `selectedIds` 用 Set 是给 P2-05 的多选（邻域聚焦 / 框选）留的容器；本任务只写
 * 单元素，`select()` 覆盖旧选中，重复选同一个 id 是幂等的（不产生新引用，避免
 * 订阅方白重绘）。
 */
import { create } from 'zustand';
import { useActivity } from './activity.js';

export interface SelectionState {
  /** 当前选中的节点 id 集合（P2-03 只有 0 或 1 个元素） */
  selectedIds: Set<string>;
  /** 主选中节点：高亮、检查器都以它为准（多选时取最近一次点击） */
  focusId: string | null;
  /** 选中一个节点（覆盖旧选中） */
  select(id: string): void;
  /** 清空选中（点空白 / Esc） */
  clear(): void;
}

export const useSelection = create<SelectionState>()((set) => ({
  selectedIds: new Set<string>(),
  focusId: null,
  // 点选同时是一次"调用"事件：选中 → 活跃集 → 命中节点 + 1-hop 亮 4–6s（详设 §10.3.1）。
  // 放在这里而不是两个渲染器里各写一遍，是为了让"2D 点选"和"3D 点选"产生完全相同的
  // 活跃集，也避免同一帧里被触发两次。
  select: (id) => {
    useActivity.getState().hit(id);
    set((prev) => (prev.focusId === id ? prev : { selectedIds: new Set([id]), focusId: id }));
  },
  clear: () => set((prev) => (prev.focusId === null ? prev : { selectedIds: new Set<string>(), focusId: null })),
}));
