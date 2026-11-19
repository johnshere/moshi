/**
 * 全局键盘导航（P2-19A-07b，概设 §8.9 / 详设 §10.1）。
 *
 * 纯函数层：只把「按键 + 上下文」解析成动作，不碰 DOM、不装监听——这样 j/k 边界、
 * `g` 序列超时、输入框让位都能在单测里直接钉住；`Shell.tsx` 只负责执行动作。
 *
 * 约定：
 * - 带 Ctrl/Alt/Meta 的一律不接（浏览器/系统快捷键优先）；
 * - 焦点在 input/textarea/select/contenteditable 里时一律不接（`/`、j/k、g 都不抢字符）；
 * - `g` 前缀序列 600ms 内有效：`g m`/`g r`/`g i`/`g g`/`g a`/`g s` 分别跳六个页面；
 * - j/k 只在列表上下文（`ctx.listNav === true`）里生效，无列表时静默忽略；
 * - Esc 交给调用方做「收起搜索 / 清空选中」，不在这里判断 Inspector 是否打开。
 */
import { isTypingTarget, type PageKey } from './pure.js';

/** `g` 之后等第二个键的窗口（毫秒）。超过就当这次没按 `g`。 */
export const G_SEQUENCE_TIMEOUT_MS = 600;

/** `g` 序列第二键 → 页面（`g g` 回图谱）。 */
export const G_TARGET_PAGES: Readonly<Record<string, PageKey>> = {
  g: 'graph',
  r: 'recall',
  m: 'memories',
  i: 'inbox',
  a: 'archive',
  s: 'settings',
};

/** 键盘事件的最小形状：真实 `KeyboardEvent` 与单测里的普通对象都满足。 */
export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** 真实事件是 `EventTarget`，单测里是带 tagName 的普通对象 */
  target?: { tagName?: string; isContentEditable?: boolean } | EventTarget | null;
}

export interface KeyContext {
  /** 上一次按 `g` 的时刻；null = 没有等待中的序列 */
  pendingGAt: number | null;
  /** 当前时刻（允许单测注入） */
  now: number;
  /** 当前页是否存在可 j/k 移动的列表（由页面注册的 nav items 决定） */
  listNav: boolean;
}

export type KeyAction =
  | { type: 'focus-search' }
  | { type: 'arm-g' }
  | { type: 'nav'; page: PageKey }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'escape' };

/**
 * 把事件目标收窄成 `isTypingTarget` 需要的形状。
 *
 * 真实的 `KeyboardEvent.target` 是 `EventTarget`，这里只读 `tagName` /
 * `isContentEditable` 两个属性——拿不到就当作非输入目标，不抛错。
 */
function typingTargetOf(
  target: KeyEventLike['target'],
): { tagName?: string; isContentEditable?: boolean } | null {
  if (target === null || target === undefined) return null;
  return target as { tagName?: string; isContentEditable?: boolean };
}

/**
 * 解析一次 keydown。返回 null = 不拦截，事件继续走默认行为。
 *
 * 注意顺序：Esc `/` 先于 `g` 序列判断（正在等第二个键时按 `/` 仍聚焦搜索），
 * `g` 先于 j/k（`g` 起头的序列不会被当成单键导航）。
 */
export function resolveKey(event: KeyEventLike, ctx: KeyContext): KeyAction | null {
  if (event.ctrlKey === true || event.altKey === true || event.metaKey === true) return null;
  if (isTypingTarget(typingTargetOf(event.target ?? null))) return null;

  if (event.key === 'Escape') return { type: 'escape' };
  if (event.key === '/') return { type: 'focus-search' };

  if (ctx.pendingGAt !== null && ctx.now - ctx.pendingGAt <= G_SEQUENCE_TIMEOUT_MS) {
    const page = G_TARGET_PAGES[event.key];
    return page === undefined ? null : { type: 'nav', page };
  }

  if (event.key === 'g') return { type: 'arm-g' };

  if (event.key === 'j') return ctx.listNav ? { type: 'move', delta: 1 } : null;
  if (event.key === 'k') return ctx.listNav ? { type: 'move', delta: -1 } : null;

  return null;
}

/** 等待中的 `g` 序列是否已过期（Shell 用来清 pending，避免过期状态一直挂着）。 */
export function gSequenceExpired(pendingGAt: number | null, now: number): boolean {
  return pendingGAt !== null && now - pendingGAt > G_SEQUENCE_TIMEOUT_MS;
}
