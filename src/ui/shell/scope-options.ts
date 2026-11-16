/**
 * 作用域切换器的纯逻辑（V-02；V-10 起文案走词典）。
 *
 * `global` 与 `project:<cwd>` 是两种不同视图：前者看跨项目事实，后者看单项目。
 * 与筛选器共用 URL（`?scope=`），所以这里只产出选项，不存状态。
 *
 * 文案要按当前语言出，所以 `t` 作为显式首参传入（模块级常量表会在加载期固化语言）。
 */
import { t as translateNow } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

type T = (key: DictKey, vars?: Readonly<Record<string, string | number>>) => string;

export interface ScopeItem {
  scope: string;
  fact_count: number;
}

export interface ScopeOption {
  /** 空串 = 不限（全部作用域），写入筛选时映射成 `null` */
  value: string;
  label: string;
  count: number | null;
}

/** `project:` 前缀后的路径直接作为可读名；不是项目作用域就原样返回 */
export function scopeLabel(scope: string, t: T = translateNow): string {
  if (scope === 'global') return t('scope.global');
  if (scope.startsWith('project:')) return scope.slice('project:'.length) || scope;
  return scope;
}

/**
 * 选项顺序：全部 → 全局 → 项目（按 `/api/scopes` 返回顺序）。
 * 当前筛选值不在清单里（例如旧 URL 指向已清空的项目）也要保留，否则下拉框
 * 会显示空白并把用户困住。
 */
export function scopeOptions(
  items: readonly ScopeItem[],
  current: string | null,
  t: T = translateNow,
): ScopeOption[] {
  const options: ScopeOption[] = [{ value: '', label: t('scope.all'), count: null }];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.scope === 'global') {
      options.push({ value: 'global', label: t('scope.global'), count: item.fact_count });
    } else {
      options.push({ value: item.scope, label: scopeLabel(item.scope, t), count: item.fact_count });
    }
    seen.add(item.scope);
  }
  if (current !== null && !seen.has(current)) {
    options.push({ value: current, label: scopeLabel(current, t), count: null });
  }
  return options;
}
