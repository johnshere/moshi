/**
 * 顶栏全局搜索（P2-19-A，概设 §8.1）。
 *
 * 交互：`/` 聚焦（输入框内不抢字符）→ 输入 2 字以上取 `/api/facts?q=` 建议 →
 * 点建议进记忆页并选中 `?fact=`，回车进 `?q=` 结果页。Esc 收起。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { factHref, isSearchShortcut, isTypingTarget, memoriesHref } from './pure.js';
import { navigate } from './navigate.js';
import { fetchSuggestions, type FactSuggestion } from './api.js';

const boxStyle: CSSProperties = {
  position: 'relative',
  width: 320,
  maxWidth: '46vw',
};

const inputStyle = (focused: boolean): CSSProperties => ({
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--color-bg-raised)',
  color: 'var(--color-text-primary)',
  border: `1px solid ${focused ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
  borderRadius: 5,
  padding: '5px 9px 5px 26px',
  fontSize: 12,
  outline: 'none',
  boxShadow: focused
    ? '0 0 0 1px color-mix(in srgb, var(--color-accent) 40%, transparent), 0 0 16px var(--color-glow)'
    : 'none',
});

const listStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  background: 'var(--color-bg-overlay)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 6,
  boxShadow: 'var(--shadow-menu)',
  zIndex: 60,
  overflow: 'hidden',
};

const itemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 0,
  borderBottom: '1px solid var(--color-border-subtle)',
  color: 'var(--color-text-secondary)',
  padding: '7px 9px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export function SearchBox(): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly FactSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSearchShortcut(event)) return;
      if (isTypingTarget(event.target as { tagName?: string; isContentEditable?: boolean } | null)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchSuggestions(q, 6, controller.signal)
        .then((rows) => {
          if (!controller.signal.aborted) {
            setItems(rows);
            setOpen(true);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setItems([]);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const submit = (): void => {
    const q = query.trim();
    if (q === '') return;
    setOpen(false);
    navigate(memoriesHref(q, window.location.search));
  };

  return (
    <div style={boxStyle}>
      <span style={{ position: 'absolute', left: 9, top: 5, color: 'var(--color-text-muted)', fontSize: 12 }}>⌕</span>
      <input
        ref={inputRef}
        data-testid="global-search"
        aria-label="全局搜索"
        data-focus={focusWithin ? 'true' : 'false'}
        className="moshi-search"
        placeholder="搜索事实（/）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          setFocusWithin(true);
          if (items.length > 0) setOpen(true);
        }}
        onBlur={() => {
          setFocusWithin(false);
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        style={inputStyle(focusWithin)}
      />
      {!focusWithin && query === '' ? (
        <span
          style={{
            position: 'absolute',
            right: 8,
            top: 5,
            color: 'var(--color-text-faint)',
            fontSize: 11,
            pointerEvents: 'none',
          }}
        >
          /
        </span>
      ) : null}
      {open && items.length > 0 ? (
        <div style={listStyle} data-testid="search-suggestions">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              style={itemStyle}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                navigate(factHref(item.id, window.location.search));
              }}
              title={item.id}
            >
              <span style={{ color: 'var(--color-text-muted)', marginRight: 6 }}>{item.ftype}</span>
              {item.content}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
