/**
 * 作用域切换器的纯逻辑（V-02）。
 *
 * `global` 与 `project:<cwd>` 是两种不同视图：前者看跨项目事实，后者看单项目。
 * 与筛选器共用 URL（`?scope=`），所以这里只产出选项，不存状态。
 */

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
export function scopeLabel(scope: string): string {
  if (scope === 'global') return '全局';
  if (scope.startsWith('project:')) return scope.slice('project:'.length) || scope;
  return scope;
}

/**
 * 选项顺序：全部 → 全局 → 项目（按 `/api/scopes` 返回顺序）。
 * 当前筛选值不在清单里（例如旧 URL 指向已清空的项目）也要保留，否则下拉框
 * 会显示空白并把用户困住。
 */
export function scopeOptions(items: readonly ScopeItem[], current: string | null): ScopeOption[] {
  const options: ScopeOption[] = [{ value: '', label: '全部作用域', count: null }];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.scope === 'global') {
      options.push({ value: 'global', label: '全局', count: item.fact_count });
    } else {
      options.push({ value: item.scope, label: scopeLabel(item.scope), count: item.fact_count });
    }
    seen.add(item.scope);
  }
  if (current !== null && !seen.has(current)) {
    options.push({ value: current, label: scopeLabel(current), count: null });
  }
  return options;
}
