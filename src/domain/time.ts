/**
 * 时间（详设 §1.2）。
 *
 * 唯一格式：`YYYY-MM-DDTHH:mm:ss.SSSZ`，UTC，长度恒为 24。
 * 好处是**字符串比较即时间比较**，SQL 里可以直接 `<` `>`，不用函数、不会走索引失效。
 * 代价是所有入参都要校验——所以这里只有一个解析入口，非法即抛错。
 */
import { MoshiError } from './errors.js';

/** 严格 24 位 UTC ISO 串 */
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isTs(s: unknown): s is string {
  return typeof s === 'string' && s.length === 24 && TS_RE.test(s);
}

/** 唯一解析入口。非法输入抛 E_INPUT——不要在不同模块各写一套容错 */
export function parseTs(s: string): number {
  if (!isTs(s)) {
    throw new MoshiError('E_INPUT', `时间格式非法（需 24 位 UTC ISO）：${String(s)}`, { value: s });
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new MoshiError('E_INPUT', `时间不存在：${s}`, { value: s });
  }
  return ms;
}

/** 字符串比较即时间比较；两边都校验过格式，所以等价于数值比较 */
export function compareTs(a: string, b: string): number {
  parseTs(a);
  parseTs(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addMs(iso: string, deltaMs: number): string {
  return new Date(parseTs(iso) + deltaMs).toISOString();
}

export function addDays(iso: string, days: number): string {
  return addMs(iso, days * 24 * 60 * 60 * 1000);
}

/** 展示用：本地时区 + 偏移（前端与归档共用同一格式，避免两处不一致） */
export function formatLocal(iso: string, locale = 'zh-CN'): string {
  const ms = parseTs(iso);
  const fmt = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
    hour12: false,
  });
  return fmt.format(new Date(ms));
}

/** 时长毫秒 → 人类可读（归档与 UI 的"3 天前"） */
export function humanizeAge(ms: number): string {
  const abs = Math.abs(ms);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < min) return '刚刚';
  if (abs < hour) return `${Math.floor(abs / min)} 分钟`;
  if (abs < day) return `${Math.floor(abs / hour)} 小时`;
  return `${Math.floor(abs / day)} 天`;
}
