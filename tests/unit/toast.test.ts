/**
 * 全局 Toast（P2-19A-07b）：appendToast 纯计算 + useToast 时间语义。
 *
 * 重点钉三件事：上限 5 条 FIFO、普通提示 TTL / undo 用服务端 deadline、
 * 按钮回调执行前先 dismiss（回调抛错不能把 toast 卡在屏幕上）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOAST_MAX,
  TOAST_TTL_MS,
  TOAST_UNDO_TTL_MS,
  appendToast,
  useToast,
  type Toast,
} from '../../src/ui/state/toast.js';

const NOW = 2_000_000;

function toast(id: string, deadline: number, kind: Toast['kind'] = 'info'): Toast {
  return { id, kind, text: id, deadline };
}

beforeEach(() => {
  useToast.getState().clear();
});

describe('appendToast', () => {
  it('追加到末尾', () => {
    const next = appendToast([toast('a', NOW + 1000)], toast('b', NOW + 1000), NOW);
    expect(next.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('先清掉已经过期的', () => {
    const next = appendToast([toast('old', NOW - 1), toast('alive', NOW + 1)], toast('new', NOW + 10), NOW);
    expect(next.map((t) => t.id)).toEqual(['alive', 'new']);
  });

  it('超过上限淘汰最旧（FIFO）', () => {
    const current = Array.from({ length: TOAST_MAX }, (_, i) => toast(`t${i}`, NOW + 1000));
    const next = appendToast(current, toast('newest', NOW + 1000), NOW);
    expect(next).toHaveLength(TOAST_MAX);
    expect(next[0]?.id).toBe('t1');
    expect(next.at(-1)?.id).toBe('newest');
  });

  it('允许自定义上限', () => {
    const next = appendToast([toast('a', NOW + 1), toast('b', NOW + 1)], toast('c', NOW + 1), NOW, 2);
    expect(next.map((t) => t.id)).toEqual(['b', 'c']);
  });
});

describe('useToast', () => {
  it('普通提示用 TTL 活着，undo 缺省用 30s 窗口', () => {
    const id = useToast.getState().push({ kind: 'info', text: 'hi' }, NOW);
    expect(id).toMatch(/^toast_/);
    const stored = useToast.getState().toasts[0];
    expect(stored?.deadline).toBe(NOW + TOAST_TTL_MS);

    useToast.getState().clear();
    useToast.getState().push({ kind: 'undo', text: '已剪枝', actionLabel: '撤销' }, NOW);
    expect(useToast.getState().toasts[0]?.deadline).toBe(NOW + TOAST_UNDO_TTL_MS);
  });

  it('调用方给的 deadline 优先（服务端撤销窗口）', () => {
    useToast.getState().push({ kind: 'undo', text: 'x', deadline: NOW + 1234 }, NOW);
    expect(useToast.getState().toasts[0]?.deadline).toBe(NOW + 1234);
  });

  it('dismiss 按 id 移除', () => {
    const id = useToast.getState().push({ kind: 'info', text: 'x' }, NOW);
    useToast.getState().dismiss(id);
    expect(useToast.getState().toasts).toHaveLength(0);
  });

  it('runAction 先 dismiss 再执行回调', () => {
    const onAction = vi.fn(() => {
      // 回调执行时 toast 必须已经消失，防止「撤销中」卡住
      expect(useToast.getState().toasts.some((t) => t.actionLabel === '撤销')).toBe(false);
    });
    const id = useToast.getState().push({ kind: 'undo', text: 'x', actionLabel: '撤销', onAction }, NOW);
    useToast.getState().runAction(id);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(useToast.getState().toasts).toHaveLength(0);
  });

  it('回调抛错被吞掉，toast 不复活', () => {
    const id = useToast.getState().push(
      { kind: 'undo', text: 'x', onAction: () => { throw new Error('boom'); } },
      NOW,
    );
    expect(() => useToast.getState().runAction(id)).not.toThrow();
    expect(useToast.getState().toasts).toHaveLength(0);
  });

  it('sweep 清到期项并返回条数；没变化返回 0', () => {
    useToast.getState().push({ kind: 'info', text: 'a', deadline: NOW + 10 }, NOW);
    useToast.getState().push({ kind: 'info', text: 'b', deadline: NOW + 100 }, NOW);
    expect(useToast.getState().sweep(NOW + 50)).toBe(1);
    expect(useToast.getState().toasts).toHaveLength(1);
    expect(useToast.getState().sweep(NOW + 50)).toBe(0);
  });

  it('clear 清空全部', () => {
    useToast.getState().push({ kind: 'info', text: 'a' }, NOW);
    useToast.getState().push({ kind: 'error', text: 'b' }, NOW);
    useToast.getState().clear();
    expect(useToast.getState().toasts).toEqual([]);
  });
});
