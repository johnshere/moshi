/**
 * 全局 Toast（P2-19A-07b，详设 §10.1：全局常驻 `<ToastHost>`）。
 *
 * 为什么要有统一 store：inbox 的撤销条原本内联在 BatchPanel 里，一旦切页/面板状态
 * 被预览挤掉，撤销入口就消失。收口到 toast 后，「已剪枝 N 条 + 撤销」跟着全局常驻，
 * 页面只负责提交动作、不再自己画撤销条。
 *
 * 时间语义：
 * - 普通提示（info/success/error）默认 `TOAST_TTL_MS` 后自动消失；
 * - `undo` 用调用方给的 deadline（服务端 30s 撤销窗口），`sweep` 到期即移除；
 * - 最多 `TOAST_MAX` 条，超了淘汰最旧（FIFO），避免堆满屏幕。
 */
import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error' | 'undo';

export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
  /** 右侧按钮文案（如「撤销」）；没有就不渲染按钮 */
  actionLabel?: string;
  /** 按钮回调；`runAction` 调用后自动 dismiss */
  onAction?: () => void;
  /** 自动消失时刻（毫秒时间戳） */
  deadline: number;
}

export interface ToastInput {
  kind: ToastKind;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  /** 缺省：undo 用 30s 撤销窗口，其它用 TOAST_TTL_MS */
  deadline?: number;
}

/** 同时最多显示几条 */
export const TOAST_MAX = 5;
/** 普通提示存活时长 */
export const TOAST_TTL_MS = 4500;
/** undo 类缺省存活时长（与批量撤销窗口一致） */
export const TOAST_UNDO_TTL_MS = 30_000;

let seq = 0;

function nextId(): string {
  seq += 1;
  return `toast_${String(seq)}`;
}

/** 纯计算：push 后的新列表（过期清理 + FIFO 截断）。单测可直接钉。 */
export function appendToast(
  current: readonly Toast[],
  toast: Toast,
  now: number,
  max = TOAST_MAX,
): Toast[] {
  const alive = current.filter((t) => t.deadline > now);
  const next = [...alive, toast];
  return next.length <= max ? next : next.slice(next.length - max);
}

export interface ToastState {
  toasts: Toast[];
  /** 推一条；返回 id（便于调用方 dismiss） */
  push(input: ToastInput, now?: number): string;
  dismiss(id: string): void;
  /** 执行按钮回调（先 dismiss 再调，防止回调里抛错把 toast 卡住） */
  runAction(id: string): void;
  /** 清掉已到期的；返回被清掉的条数（0 = 没变化，不触发重渲染） */
  sweep(now?: number): number;
  /** 测试/切页重置用 */
  clear(): void;
}

export const useToast = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (input, now = Date.now()) => {
    const id = nextId();
    const ttl =
      input.kind === 'undo' ? TOAST_UNDO_TTL_MS : TOAST_TTL_MS;
    const toast: Toast = {
      id,
      kind: input.kind,
      text: input.text,
      deadline: input.deadline ?? now + ttl,
      ...(input.actionLabel === undefined ? {} : { actionLabel: input.actionLabel }),
      ...(input.onAction === undefined ? {} : { onAction: input.onAction }),
    };
    set((prev) => ({ toasts: appendToast(prev.toasts, toast, now) }));
    return id;
  },
  dismiss: (id) => {
    set((prev) => {
      const next = prev.toasts.filter((t) => t.id !== id);
      return next.length === prev.toasts.length ? prev : { toasts: next };
    });
  },
  runAction: (id) => {
    const toast = get().toasts.find((t) => t.id === id);
    if (toast === undefined) return;
    // 先 dismiss：回调里可能触发刷新/导航，不能让「撤销中…」的 toast 挂着
    get().dismiss(id);
    try {
      toast.onAction?.();
    } catch {
      /* toast 是提示层，回调失败由调用方自己的错误提示负责 */
    }
  },
  sweep: (now = Date.now()) => {
    const prev = get().toasts;
    const next = prev.filter((t) => t.deadline > now);
    if (next.length === prev.length) return 0;
    set({ toasts: next });
    return prev.length - next.length;
  },
  clear: () => set({ toasts: [] }),
}));
