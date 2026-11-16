/**
 * 顶栏语言切换（D-184）：两态按钮「中 / EN」，放状态灯之前，不进设置（用户 m01201）。
 */
import type { CSSProperties, ReactElement } from 'react';
import { useLocale, useT, type Locale } from '../i18n/index.js';

const groupStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  overflow: 'hidden',
};

function itemStyle(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--color-bg-hover)' : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    border: 0,
    padding: '2px 7px',
    fontSize: 11,
    lineHeight: 1.6,
    cursor: 'pointer',
    font: 'inherit',
  };
}

export function LocaleSwitch(): ReactElement {
  const t = useT();
  const locale = useLocale((state) => state.locale);
  const setLocale = useLocale((state) => state.setLocale);
  const items: readonly { value: Locale; label: string }[] = [
    { value: 'zh', label: t('locale.zh') },
    { value: 'en', label: t('locale.en') },
  ];

  return (
    <div style={groupStyle} data-testid="locale-switch" role="group" aria-label={t('locale.switch')}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          data-testid={`locale-${item.value}`}
          aria-pressed={locale === item.value}
          data-active={locale === item.value ? 'true' : 'false'}
          onClick={() => setLocale(item.value)}
          style={itemStyle(locale === item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
