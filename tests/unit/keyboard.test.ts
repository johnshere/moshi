/**
 * 全局键盘导航（P2-19A-07b）：resolveKey 纯函数 + useNav 移动语义。
 *
 * 这里不测 DOM：`Shell` 只把 action 执行到 document/navigate，属于装配层；
 * 纯函数把「按键 → 动作」钉死后，浏览器验收再补真实 activeElement/URL 读数。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  G_SEQUENCE_TIMEOUT_MS,
  G_TARGET_PAGES,
  gSequenceExpired,
  resolveKey,
  type KeyContext,
  type KeyEventLike,
} from '../../src/ui/shell/keyboard.js';
import { useNav } from '../../src/ui/state/nav.js';
import { useSelection } from '../../src/ui/state/selection.js';

const NOW = 1_000_000;

function ctx(over: Partial<KeyContext> = {}): KeyContext {
  return { pendingGAt: null, now: NOW, listNav: false, ...over };
}

function ev(key: string, over: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, ...over };
}

/** contenteditable 的 input 形状（isTypingTarget 只看 tagName/内容可编辑） */
const INPUT = { tagName: 'INPUT', isContentEditable: false };

beforeEach(() => {
  useNav.getState().clear();
  useSelection.getState().clear();
});

describe('resolveKey', () => {
  it('带 Ctrl/Alt/Meta 的按键一律不接（交给浏览器/系统）', () => {
    expect(resolveKey(ev('j', { ctrlKey: true }), ctx({ listNav: true }))).toBeNull();
    expect(resolveKey(ev('/', { altKey: true }), ctx())).toBeNull();
    expect(resolveKey(ev('g', { metaKey: true }), ctx())).toBeNull();
  });

  it('输入框/可编辑区域内不抢字符：/、g、j 全部放行', () => {
    expect(resolveKey(ev('/', { target: INPUT }), ctx())).toBeNull();
    expect(resolveKey(ev('g', { target: INPUT }), ctx())).toBeNull();
    expect(resolveKey(ev('j', { target: INPUT }), ctx({ listNav: true }))).toBeNull();
  });

  it('/ 聚焦搜索框', () => {
    expect(resolveKey(ev('/'), ctx())).toEqual({ type: 'focus-search' });
  });

  it('Esc 交给调用方（非输入区）', () => {
    expect(resolveKey(ev('Escape'), ctx())).toEqual({ type: 'escape' });
  });

  it('单按 g 进入等待序列', () => {
    expect(resolveKey(ev('g'), ctx())).toEqual({ type: 'arm-g' });
  });

  it('g + 第二键在 600ms 内跳页；五个目标全覆盖', () => {
    for (const [key, page] of Object.entries(G_TARGET_PAGES)) {
      expect(resolveKey(ev(key), ctx({ pendingGAt: NOW - 100 }))).toEqual({ type: 'nav', page });
    }
  });

  it('g 序列超时（601ms）后第二键不再跳页', () => {
    expect(resolveKey(ev('i'), ctx({ pendingGAt: NOW - G_SEQUENCE_TIMEOUT_MS - 1 }))).toBeNull();
    // 边界：恰好 600ms 仍有效
    expect(resolveKey(ev('i'), ctx({ pendingGAt: NOW - G_SEQUENCE_TIMEOUT_MS }))).toEqual({
      type: 'nav',
      page: 'inbox',
    });
  });

  it('等待 g 时按未登记的第二键不跳页', () => {
    expect(resolveKey(ev('x'), ctx({ pendingGAt: NOW - 10 }))).toBeNull();
  });

  it('j/k 只在列表上下文生效，方向正确', () => {
    expect(resolveKey(ev('j'), ctx({ listNav: true }))).toEqual({ type: 'move', delta: 1 });
    expect(resolveKey(ev('k'), ctx({ listNav: true }))).toEqual({ type: 'move', delta: -1 });
    expect(resolveKey(ev('j'), ctx({ listNav: false }))).toBeNull();
    expect(resolveKey(ev('k'), ctx({ listNav: false }))).toBeNull();
  });

  it('gSequenceExpired 边界', () => {
    expect(gSequenceExpired(null, NOW)).toBe(false);
    expect(gSequenceExpired(NOW - G_SEQUENCE_TIMEOUT_MS, NOW)).toBe(false);
    expect(gSequenceExpired(NOW - G_SEQUENCE_TIMEOUT_MS - 1, NOW)).toBe(true);
  });
});

describe('useNav', () => {
  it('无列表时 move 返回 null', () => {
    expect(useNav.getState().move(1)).toBeNull();
  });

  it('无选中时 j 从第一条开始、k 从最后一条开始', () => {
    useNav.getState().setItems(['a', 'b', 'c']);
    expect(useNav.getState().move(1)).toBe('a');
    expect(useSelection.getState().focusId).toBe('a');
    useNav.getState().clear();
    useSelection.getState().clear();
    useNav.getState().setItems(['a', 'b', 'c']);
    expect(useNav.getState().move(-1)).toBe('c');
  });

  it('移动在两端夹住，不越界', () => {
    useNav.getState().setItems(['a', 'b']);
    useSelection.getState().select('a');
    expect(useNav.getState().move(-1)).toBe('a');
    expect(useNav.getState().move(1)).toBe('b');
    expect(useNav.getState().move(1)).toBe('b');
  });

  it('setItems 过滤空 id；同内容不触发 activeId 重置', () => {
    useNav.getState().setItems(['a', '', 'b']);
    expect(useNav.getState().items).toEqual(['a', 'b']);
    const id = useNav.getState().move(1);
    expect(id).toBe('a');
    useNav.getState().setItems(['a', 'b']);
    expect(useNav.getState().activeId).toBe('a');
  });

  it('clear 只清导航上下文，不动选中', () => {
    useNav.getState().setItems(['a']);
    useSelection.getState().select('a');
    useNav.getState().clear();
    expect(useNav.getState().items).toEqual([]);
    expect(useSelection.getState().focusId).toBe('a');
  });
});
