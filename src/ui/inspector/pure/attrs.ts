/**
 * 检查器的 `attrs.ext` 呈现规则（详设 §10.5：按值猜控件，不做自定义表单）。
 *
 * 只做"呈现类型判定"——ext 是未定字段的扩展槽（概设 §8.2），字段语义没定之前
 * 不做自定义表单。猜得出类型的用对应控件渲染，猜不出的退回 KV 表格原样展示。
 */

import { t as translateNow, type Translator } from '../../i18n/index.js';

export type ExtGuess =
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'datetime' }
  | { kind: 'text' }
  | { kind: 'kv' };

/** ISO 时间串的宽松判定：`YYYY-MM-DD` 或带 T/Z/± 的完整时间 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

/**
 * 按值猜控件类型。
 *
 * - number → 数字框
 * - boolean → 开关
 * - 能解析成日期的字符串 → 日期选择（只认 ISO 形态；`"2026"` 这种裸年份不是时间）
 * - 其余标量 → 文本框
 * - 数组 / 对象 → KV 原样（猜不出，不做自定义表单）
 */
export function guessExtControl(value: unknown): ExtGuess {
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'number' };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value))) {
    return { kind: 'datetime' };
  }
  if (typeof value === 'string') return { kind: 'text' };
  return { kind: 'kv' };
}

/** 只读展示时按类型格式化值（开关显示 开/关，时间显示原始串即可） */
export function formatExtValue(value: unknown, t: Translator = translateNow): string {
  if (typeof value === 'boolean') return value ? t('inspector.attr.on') : t('inspector.attr.off');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}
