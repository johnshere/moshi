/**
 * 标识符（详设 §1.1）。
 *
 * `<prefix>_<26 位 ULID 小写>`。用 ULID 而不是自增 / UUIDv4 / 内容哈希：
 * 可排序、索引局部性好、且内容变化不影响 id（引用不会断）。
 * `monotonicFactory` 保证同毫秒内递增——批量写入时这一点很重要，否则排序不稳定。
 */
import { monotonicFactory } from 'ulid';
import { MoshiError } from './errors.js';

const ulid = monotonicFactory();

export const ID_PREFIX = {
  fact: 'f',
  edge: 'x',
  entity: 'en',
  episode: 'ep',
  session: 'ss',
  query: 'q',
  annotation: 'an',
  audit: 'au',
  adjudication: 'aj',
  topic: 't',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${ulid().toLowerCase()}`;
}

export function parseId(id: string): { kind: IdKind; ulid: string } | null {
  const idx = id.indexOf('_');
  if (idx <= 0) return null;
  const prefix = id.slice(0, idx);
  const rest = id.slice(idx + 1).toUpperCase();
  if (!ULID_RE.test(rest)) return null;
  const entry = (Object.entries(ID_PREFIX) as [IdKind, string][]).find(([, p]) => p === prefix);
  if (entry === undefined) return null;
  return { kind: entry[0], ulid: rest };
}

export function isId(kind: IdKind, id: string): boolean {
  return parseId(id)?.kind === kind;
}

/** 给外部输入用：不合法就抛，而不是返回 false 让调用方自己判断 */
export function assertId(kind: IdKind, id: string): string {
  if (!isId(kind, id)) {
    throw new MoshiError('E_INPUT', `期望 ${ID_PREFIX[kind]}_ 前缀的 id，实际是 ${id}`, { id });
  }
  return id;
}
