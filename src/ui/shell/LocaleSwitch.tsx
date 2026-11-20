/**
 * 顶栏语言切换（D-184）：两态按钮「中 / EN」，放状态灯之前，不进设置（用户 m01201）。
 */
import type { ReactElement } from 'react';
import { useLocale, useT, type Locale } from '../i18n/index.js';

export function LocaleSwitch(): ReactElement {
  const t = useT();
  const locale = useLocale((state) => state.locale);
  const setLocale = useLocale((state) => state.setLocale);
  const items: readonly { value: Locale; label: string }[] = [
    { value: 'zh', label: t('locale.zh') },
    { value: 'en', label: t('locale.en') },
  ];

  return (
    <div className="seg" data-testid="locale-switch" role="group" aria-label={t('locale.switch')}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          data-testid={`locale-${item.value}`}
          aria-pressed={locale === item.value}
          data-active={locale === item.value ? 'true' : 'false'}
          className="seg-item"
          onClick={() => setLocale(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
