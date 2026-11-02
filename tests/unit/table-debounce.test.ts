/**
 * 搜索框防抖（P2-04）：300ms 内连续输入只打一次 `/api/facts?q=`。
 *
 * 用 fake timers 钉边界：299ms 不动、300ms 才落、参数取最后一次（否则会把
 * 中间态的搜索词发出去）；`cancel()` 之后绝不能再触发（组件卸载后的 setState）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../../src/ui/table/pure/debounce.js';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('300ms 内连续三次 → 只触发一次，且用最后一次的参数', () => {
    const calls: string[] = [];
    const fn = debounce((v: string) => calls.push(v), 300);
    fn('r');
    fn('ru');
    fn('rus');
    vi.advanceTimersByTime(299);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['rus']);
  });

  it('两次间隔超过窗口 → 各自触发（用户分两次搜索）', () => {
    const calls: string[] = [];
    const fn = debounce((v: string) => calls.push(v), 300);
    fn('a');
    vi.advanceTimersByTime(300);
    fn('b');
    vi.advanceTimersByTime(300);
    expect(calls).toEqual(['a', 'b']);
  });

  it('cancel 之后不触发（组件卸载 / 回车立即生效时要丢掉挂起的防抖）', () => {
    const calls: string[] = [];
    const fn = debounce((v: string) => calls.push(v), 300);
    fn('typing');
    fn.cancel();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
  });

  it('cancel 无挂起调用时是幂等的', () => {
    const fn = debounce(() => undefined, 300);
    expect(() => {
      fn.cancel();
      fn.cancel();
    }).not.toThrow();
  });

  it('多参数原样透传', () => {
    const calls: [string, number][] = [];
    const fn = debounce((a: string, b: number) => calls.push([a, b]), 50);
    fn('x', 7);
    vi.advanceTimersByTime(50);
    expect(calls).toEqual([['x', 7]]);
  });
});
