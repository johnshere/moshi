/**
 * 全局筛选条（详设 §10.2 的 `FilterBar`，P2-05 落地）。
 *
 * 渲染有真实消费方的四组筛选项：`scope`（自由文本）、`ftype` / `status`（多选）、
 * `timeRange`（from/to）；`strengthBand` / `pool` 后端暂无可消费方，字段已在
 * store 契约里（`pure/filter.ts`），UI 不渲染死控件（台账 D-?? 决策）。
 *
 * 所有变更都只调 `useFilter.set()` / `reset()`——它们负责写 URL（pushState）再
 * 从 URL 解析回 store，这里不碰 store 的 `filter` 字段（详设 §10.2 铁律 1）。
 *
 * 交互细节：
 * - 文本类输入（scope / from / to）用本地 state + 提交时才写 URL：逐键 pushState
 *   会把历史栈刷爆，也让"后退"失去意义（后退一次 = 撤销一个字符）。
 * - 按钮类（ftype / status）点击即提交：多选语义，点一次是一次完整筛选变更。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useFilter } from '../state/filter.js';
import { FILTER_FTYPES, FILTER_STATUSES, filterToSearch } from './pure/filter.js';
import { useT } from '../i18n/index.js';
import { enumLabel } from '../i18n/enums.js';

declare global {
  interface Window {
    /** P2-05 可测性钩子：当前筛选态 + 写 URL 后的真实 href（验收脚本读数用） */
    __moshiFilter?: {
      /** 序列化后的 query 片段（不含 `?`；空串 = 无筛选） */
      query: string;
      /** 当前 URL（筛选写进去之后的完整 href，含 view / limit / token 等其它参数） */
      href: string;
      /** 是否处于非默认态 */
      active: boolean;
    };
  }
}

const containerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  flexWrap: 'wrap',
  fontSize: 12,
  lineHeight: 1.6,
  pointerEvents: 'auto',
};

const labelStyle: CSSProperties = { color: 'var(--color-text-muted)', whiteSpace: 'nowrap' };

/* 胶囊：只有可点的东西是圆的；标签保持方角，圆角不滥用 */
const chipBase: CSSProperties = {
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 999,
  padding: '1px 8px',
  cursor: 'pointer',
  font: 'inherit',
  transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease',
};

const chipOn: CSSProperties = {
  ...chipBase,
  background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
  color: 'var(--color-accent-soft)',
  border: '1px solid color-mix(in srgb, var(--color-accent) 38%, transparent)',
};

const textInputStyle: CSSProperties = {
  background: 'var(--color-bg-overlay)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 999,
  padding: '1px 9px',
  font: 'inherit',
  width: 112,
};

const dateInputStyle: CSSProperties = { ...textInputStyle, width: 98, colorScheme: 'light dark' };

/** 把 ISO 时间截成 date input 能吃的 `YYYY-MM-DD`（取日期部分，容忍含时间的完整 ISO） */
function toDateValue(iso: string | null): string {
  if (iso === null) return '';
  return iso.slice(0, 10);
}

/** date input 的值补成 ISO：日期字符串直接可用（`2026-11-02` 可被 Date.parse 接受） */
function fromDateValue(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

export function FilterBar(): JSX.Element {
  const t = useT();
  const filter = useFilter((s) => s.filter);
  const active = useFilter((s) => s.active);
  const set = useFilter((s) => s.set);
  const reset = useFilter((s) => s.reset);

  // scope / from / to 走"本地 state + 提交"，按钮类走"点击即提交"
  const [scopeInput, setScopeInput] = useState(filter.scope ?? '');
  const [fromInput, setFromInput] = useState(toDateValue(filter.timeRange.from));
  const [toInput, setToInput] = useState(toDateValue(filter.timeRange.to));

  // URL 被外部改动（popstate / 分享链接打开）时，本地草稿要跟真相源走
  useEffect(() => setScopeInput(filter.scope ?? ''), [filter.scope]);
  useEffect(() => setFromInput(toDateValue(filter.timeRange.from)), [filter.timeRange.from]);
  useEffect(() => setToInput(toDateValue(filter.timeRange.to)), [filter.timeRange.to]);

  // 可测性钩子：每次筛选态或 URL 变化后重发（验收脚本据此读"筛选已写进 URL"）
  useEffect(() => {
    window.__moshiFilter = {
      query: filterToSearch(filter),
      href: window.location.href,
      active,
    };
  }, [filter, active]);

  const commitScope = (): void => {
    const v = scopeInput.trim();
    set({ scope: v === '' ? null : v });
  };
  const commitFrom = (): void => {
    set({ timeRange: { from: fromDateValue(fromInput), to: filter.timeRange.to } });
  };
  const commitTo = (): void => {
    set({ timeRange: { from: filter.timeRange.from, to: fromDateValue(toInput) } });
  };

  const toggleFtype = (v: string): void => {
    const next = filter.ftype.includes(v)
      ? filter.ftype.filter((x) => x !== v)
      : [...filter.ftype, v];
    set({ ftype: next });
  };
  const toggleStatus = (v: string): void => {
    const next = filter.status.includes(v)
      ? filter.status.filter((x) => x !== v)
      : [...filter.status, v];
    set({ status: next });
  };

  return (
    <div
      style={{
        ...containerStyle,
        ...(active ? { border: '1px solid var(--color-border-strong)', background: 'var(--color-bg-overlay)', borderRadius: 8, padding: '4px 8px' } : {}),
      }}
    >
      <span style={labelStyle} data-testid="filter-label">
        {t(active ? 'filter.titleActive' : 'filter.title')}
      </span>

      <label style={labelStyle}>{t('filter.scope')}</label>
      <input
        type="text"
        value={scopeInput}
        placeholder={t('filter.scopePlaceholder')}
        onChange={(e) => setScopeInput(e.target.value)}
        onBlur={commitScope}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitScope();
        }}
        style={textInputStyle}
      />

      <span style={labelStyle}>{t('filter.ftype')}</span>
      {FILTER_FTYPES.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={filter.ftype.includes(v)}
          onClick={() => toggleFtype(v)}
          style={filter.ftype.includes(v) ? chipOn : chipBase}
        >
          {enumLabel('ftype', v)}
        </button>
      ))}

      <span style={labelStyle}>{t('filter.status')}</span>
      {FILTER_STATUSES.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={filter.status.includes(v)}
          onClick={() => toggleStatus(v)}
          style={filter.status.includes(v) ? chipOn : chipBase}
        >
          {enumLabel('epistemic', v)}
        </button>
      ))}

      <span style={labelStyle}>{t('filter.time')}</span>
      <input type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} onBlur={commitFrom} style={dateInputStyle} />
      <span style={{ color: 'var(--color-text-faint)' }}>~</span>
      <input type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} onBlur={commitTo} style={dateInputStyle} />

      {active && (
        <button type="button" onClick={reset} style={{ ...chipBase, color: 'var(--color-warning)', borderColor: 'var(--color-warning-dim)' }}>
          {t('common.reset')}
        </button>
      )}
    </div>
  );
}
