/**
 * 极小的防抖（纯逻辑，vitest 用 fake timers 测）。
 *
 * 搜索框每次击键都打一次 `/api/facts?q=` 是浪费——详设 §10.8 的搜索走后端，
 * 300ms 内连续输入应当只落一次请求。回车另走"立即 flush"路径（见 `FactsTable.tsx`）。
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** 丢弃尚未触发的调用（组件卸载时用，避免 setState on unmounted） */
  cancel(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  debounced.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
