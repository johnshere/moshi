/**
 * 界面语言（D-184）：中文默认，英文可选。
 *
 * 存 `localStorage['moshi.locale']`（纯前端偏好，不碰 daemon 配置）；
 * 初值取 `navigator.language`（`en*` → 英文，其余中文）；切换时同步 `<html lang>`。
 *
 * 注意：本文件会经 `i18n/index.ts` 被单元测试引入，而根 `tsconfig.json` 是 node 工程
 * （无 DOM lib）。所以这里不直接写 `window` / `document` / `navigator`，改用
 * `globalThis` 上的最小结构面（与 `src/ui/api.ts` 的 `tokenWindow()` 同一写法），
 * 浏览器里行为不变，node 里自动降级成默认语言。
 */
import { create } from 'zustand';

export const LOCALES = ['zh', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const STORAGE_KEY = 'moshi.locale';

/** 只用到 localStorage 的两个方法，够存一个语言码。 */
interface LocaleWindowLike {
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

interface LocaleDocumentLike {
  documentElement: { lang: string };
}

interface LocaleNavigatorLike {
  language?: string;
}

function localeWindow(): LocaleWindowLike | null {
  const value = (globalThis as { window?: LocaleWindowLike }).window;
  return value === undefined ? null : value;
}

function localeDocument(): LocaleDocumentLike | null {
  const value = (globalThis as { document?: LocaleDocumentLike }).document;
  return value === undefined ? null : value;
}

function browserLanguage(): string {
  const value = (globalThis as { navigator?: LocaleNavigatorLike }).navigator;
  return value?.language ?? '';
}

function detectLocale(): Locale {
  const win = localeWindow();
  if (win !== null) {
    try {
      const saved = win.localStorage?.getItem(STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch {
      // 隐私模式/禁用存储：按系统语言走
    }
  }
  return browserLanguage().toLowerCase().startsWith('en') ? 'en' : 'zh';
}

function applyHtmlLang(locale: Locale): void {
  const doc = localeDocument();
  if (doc === null) return;
  doc.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
}

export interface LocaleState {
  locale: Locale;
  setLocale(locale: Locale): void;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    try {
      localeWindow()?.localStorage?.setItem(STORAGE_KEY, locale);
    } catch {
      // 存不下就只在本次会话生效
    }
    applyHtmlLang(locale);
    set({ locale });
  },
}));

applyHtmlLang(useLocale.getState().locale);
