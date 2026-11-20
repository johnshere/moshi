/**
 * 顶栏全局搜索（P2-19-A，概设 §8.1）。
 *
 * 交互：`/` 聚焦（输入框内不抢字符）→ 输入 2 字以上取 `/api/facts?q=` 建议 →
 * 点建议进记忆页并选中 `?fact=`，回车进 `?q=` 结果页。Esc 收起。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { factHref, isSearchShortcut, isTypingTarget, memoriesHref } from './pure.js';
import { navigate } from './navigate.js';
import { fetchSuggestions, type FactSuggestion } from './api.js';
import { useT } from '../i18n/index.js';
import { enumLabel } from '../i18n/enums.js';

export function SearchBox(): ReactElement {
  const t = useT();
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
    <div className="search-shell">
      <span className="search-glyph" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={inputRef}
        data-testid="global-search"
        aria-label={t('search.global')}
        data-focus={focusWithin ? 'true' : 'false'}
        className="search-input moshi-search"
        placeholder={t('search.placeholder')}
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
      />
      {!focusWithin && query === '' ? (
        <span className="search-key" aria-hidden="true">
          /
        </span>
      ) : null}
      {open && items.length > 0 ? (
        <div className="search-suggestions" data-testid="search-suggestions">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="search-suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                navigate(factHref(item.id, window.location.search));
              }}
              title={item.id}
            >
              <span style={{ color: 'var(--color-text-muted)', marginRight: 6 }}>{enumLabel('ftype', item.ftype)}</span>
              {item.content}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
