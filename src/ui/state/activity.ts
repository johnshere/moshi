/**
 * 活跃态（"此刻谁在被调用"）的共享状态（P2-03 / 详设 §10.3.1，台账 D-89）。
 *
 * 为什么和选中态分成两个 store：
 * - `useSelection` 是**用户意图**（我点了谁），跨视图、跨刷新都要活；
 * - `useActivity` 是**系统事件**（谁刚被调用），5 秒就过期，过期后图必须自己暗回去。
 * 两者生命周期不同，混在一个 store 里就会出现"选中了但没调用 → 该不该亮"这种扯不清的
 * 分支。分开之后规则是叠加的：`focusId` 负责常驻高亮，活动快照负责短暂发光。
 *
 * 快照（`ActivitySnapshot`）由持有 `data` 的那一层算一次后写进来（`setSnapshot`），
 * 两个渲染器只读同一份——避免 3D / 2D / 信息条各算一遍，算出三份不一样的活跃集。
 */
import { create } from 'zustand';
import type { ActivitySnapshot } from '../graph/pure/activity.js';

export interface ActivityState {
  /** 最近一次命中的节点 id；`null` = 当前无活跃调用 */
  hitId: string | null;
  /** 命中时刻（`performance.now()` 口径，与渲染循环同一个时钟） */
  hitAt: number;
  /** 命中序号：同一节点重复命中也会 +1，订阅方据此重放"重置计时" */
  seq: number;
  /** 命中事件算出来的活跃集；`null` = 沉默态 */
  snapshot: ActivitySnapshot | null;
  /** 记录一次命中（重复命中 = 重置计时，不叠加） */
  hit(id: string): void;
  /** 写入活跃集快照（由持有图数据的组件算完后调用） */
  setSnapshot(snapshot: ActivitySnapshot | null): void;
  /** 回到沉默态 */
  clear(): void;
}

export const useActivity = create<ActivityState>()((set) => ({
  hitId: null,
  hitAt: 0,
  seq: 0,
  snapshot: null,
  hit: (id) =>
    set((prev) => ({
      hitId: id,
      hitAt: performance.now(),
      seq: prev.seq + 1,
      snapshot: prev.hitId === id ? prev.snapshot : null,
    })),
  setSnapshot: (snapshot) => set({ snapshot }),
  clear: () => set((prev) => (prev.hitId === null ? prev : { hitId: null, hitAt: 0, snapshot: null })),
}));
