/**
 * 规范化 JSON 与哈希（详设 §1.3）。
 *
 * 这个文件是**触发器正确性的前提**：SQLite 里用 `json_extract` 比较 `attrs.frozen`
 * 判断是否被篡改，比较的是字符串。序列化不稳定 → 没改也会判定为改。
 *
 * 所以五条规则一条都不能松：
 * 键排序、无空白、数字规范、字符串只转义必要字符、不可序列化即抛错。
 */
import { createHash } from 'node:crypto';
import { MoshiError } from './errors.js';

/** 不可序列化的值类型——静默丢弃会让两个不同对象哈希相同，所以必须炸 */
function unsupported(what: string, path: string): never {
  throw new MoshiError('E_INPUT', `canonicalJson: ${what} 不可序列化（位置 ${path || '$'}）`, {
    path,
    kind: what,
  });
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

function encode(v: unknown, path: string): string {
  if (v === null) return 'null';

  switch (typeof v) {
    case 'string':
      // JSON.stringify 只转义 " \ 与控制字符，非 ASCII 原样输出——正好是规则 4
      return JSON.stringify(v);
    case 'number': {
      if (!Number.isFinite(v)) unsupported(`非有限数字 ${String(v)}`, path);
      if (Object.is(v, -0)) return '0';
      return String(v);
    }
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
      return unsupported('undefined', path);
    case 'function':
      return unsupported('function', path);
    case 'symbol':
      return unsupported('symbol', path);
    case 'bigint':
      return unsupported('bigint', path);
    case 'object':
      break;
  }

  const obj = v as object;
  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i += 1) {
      if (!(i in obj)) unsupported('稀疏数组空位', `${path}[${i}]`);
      parts.push(encode(obj[i], `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(obj)) {
    unsupported(`非纯对象 ${obj.constructor?.name ?? 'unknown'}`, path);
  }

  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${encode(record[k], `${path}.${k}`)}`);
  return `{${parts.join(',')}}`;
}

export function canonicalJson(v: unknown): string {
  return encode(v, '');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function shortHash(s: string, n = 32): string {
  return sha256Hex(s).slice(0, n);
}

/** 身份键分隔符：Unit Separator，正常文本里不会出现，避免拼接歧义 */
export const KEY_SEP = '\u001f';

/**
 * canonical_key（概设 §3.6.2 的落地）。前缀是格式版本，将来换构成时用 ck2:，新旧可共存。
 * `predicate` 必须是**规范化后**的谓词（§5.4），不是原文。
 */
export function canonicalKey(scope: string, entityId: string, predicate: string): string {
  return `ck1:${shortHash(`${scope}${KEY_SEP}${entityId}${KEY_SEP}${predicate}`, 32)}`;
}

export function valueHash(value: unknown): string {
  return `vh1:${shortHash(canonicalJson(value), 32)}`;
}
