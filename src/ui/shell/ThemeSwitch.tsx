/**
 * 顶栏主题三档切换：自动（跟随系统）/ 亮 / 暗。
 *
 * 三个图标都是内联 SVG（不用 emoji、不引图标库）；点击只改客户端偏好，
 * 不产生任何网络请求，也不影响既有功能。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { applyMode, saveMode, storedMode, subscribeMode, watchSystem, type ThemeMode } from '../theme.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

const OPTIONS: readonly { mode: ThemeMode; labelKey: DictKey; path: string }[] = [
  { mode: 'system', labelKey: 'theme.system', path: 'M12 3a9 9 0 0 0 0 18v-18z' },
  { mode: 'light', labelKey: 'theme.light', path: 'M12 4v2m0 12v2m8-8h-2M6 12H4m12.5-5.5 1.4-1.4M6.1 17.9l1.4-1.4m0-9-1.4-1.4M17.9 17.9l-1.4-1.4' },
  { mode: 'dark', labelKey: 'theme.dark', path: 'M20 14.5A8 8 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z' },
];

function segStyle(active: boolean): CSSProperties {
  return {
    width: 26,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    background: active ? 'var(--color-accent)' : 'transparent',
    color: active ? 'var(--color-accent-ink)' : 'var(--color-text-muted)',
    transition: 'background-color 140ms ease, color 140ms ease',
  };
}

export function ThemeSwitch(): ReactElement {
  const t = useT();
  const [mode, setMode] = useState<ThemeMode>(() => storedMode());

  useEffect(() => {
    const off = subscribeMode(setMode);
    const stopWatch = watchSystem();
    return () => {
      off();
      stopWatch();
    };
  }, []);

  return (
    <div
      data-testid="theme-switch"
      role="group"
      aria-label={t('theme.switch')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-bg-overlay)',
      }}
    >
      {OPTIONS.map((option) => {
        const active = mode === option.mode;
        const label = t(option.labelKey);
        return (
          <button
            key={option.mode}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            data-testid={`theme-${option.mode}`}
            style={segStyle(active)}
            onClick={() => {
              saveMode(option.mode);
              applyMode(option.mode);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
              <path
                d={option.path}
                fill={option.mode === 'system' ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth={option.mode === 'system' ? 0 : 1.6}
                strokeLinecap="round"
              />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
