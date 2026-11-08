/**
 * 作用域切换器（V-02）：全局 / 单项目视图。
 *
 * 只写筛选器的 `scope`（URL query 唯一真相源），列表与图谱都读同一个筛选，
 * 所以切换后两边同步过滤。作用域清单来自 `GET /api/scopes`，取数失败时
 * 仍保留当前值，不把用户困在空白下拉框里。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { fetchScopes, type ScopeItem } from './api.js';
import { scopeOptions } from './scope-options.js';
import { useFilter } from '../state/filter.js';

const selectStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 4,
  padding: '2px 6px',
  font: 'inherit',
  fontSize: 12,
  maxWidth: 260,
};

export function ScopeSwitcher(): ReactElement {
  const current = useFilter((s) => s.filter.scope);
  const set = useFilter((s) => s.set);
  const [items, setItems] = useState<ScopeItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchScopes(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setItems(next);
      })
      .catch(() => {
        /* 清单取不到只影响选项数量；当前值仍在 options 里 */
      });
    return () => controller.abort();
  }, []);

  const options = scopeOptions(items, current);
  return (
    <select
      data-testid="scope-switcher"
      aria-label="作用域切换"
      title="作用域：全局 / 单项目"
      style={selectStyle}
      value={current ?? ''}
      onChange={(event) => {
        const next = event.target.value;
        set({ scope: next === '' ? null : next });
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.count === null ? option.label : `${option.label} (${String(option.count)})`}
        </option>
      ))}
    </select>
  );
}
