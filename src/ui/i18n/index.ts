/**
 * UI 国际化入口（D-184）：`t(key)` 取当前语言文案，`{name}` 占位由 vars 替换。
 *
 * - 非 React 代码（api 错误映射、纯函数）：直接 `t(key)`，读 store 当前值；
 * - 组件里用 `useT()`，locale 变化时组件重渲染；
 * - 未知 key 返回 `〔key〕`（不是空串），便于一眼看出漏译。
 */
import { useCallback } from 'react';
import { en } from './dict.en.js';
import { zh, type DictKey } from './dict.js';
import { useLocale, type Locale } from '../state/locale.js';

export type { DictKey };
export { LOCALES, useLocale, type Locale } from '../state/locale.js';

export type DictVars = Readonly<Record<string, string | number>>;

/** 翻译函数签名：`useT()` 的返回值，也是纯函数模块可注入的默认参数类型。 */
export type Translator = (key: DictKey, vars?: DictVars) => string;

const DICTS: Readonly<Record<Locale, Readonly<Record<DictKey, string>>>> = { zh, en };

export function hasKey(key: string): key is DictKey {
  return Object.prototype.hasOwnProperty.call(zh, key);
}

export function translate(locale: Locale, key: DictKey, vars?: DictVars): string {
  const raw = DICTS[locale][key] ?? zh[key];
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** 当前语言下的文案（非响应式；组件里请用 `useT()`）。 */
export function t(key: DictKey, vars?: DictVars): string {
  return translate(useLocale.getState().locale, key, vars);
}

/** 组件用：返回绑定了当前 locale 的 `t`。 */
export function useT(): Translator {
  const locale = useLocale((state) => state.locale);
  return useCallback((key: DictKey, vars?: DictVars) => translate(locale, key, vars), [locale]);
}
