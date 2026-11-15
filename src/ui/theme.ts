/**
 * 主题：跟随系统 / 手工亮 / 手工暗 三档（D-1XX 视觉改版）。
 *
 * 只做一件事：把 `data-theme` 写到 `<html>` 上，颜色全部由 app.css 的 token 承接。
 * 组件不读这里的值做布局判断，避免"主题影响功能"。
 */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'moshi-theme';

export function storedMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* 隐私模式下 localStorage 可能抛错：当作没存过 */
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 解析成实际渲染用的明/暗（system 落到当前系统偏好）。 */
export function resolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark() ? 'dark' : 'light';
}

export function applyMode(mode: ThemeMode): void {
  const resolved = resolvedTheme(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = resolved;
}

export function saveMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    /* 存不上不影响这一次的渲染 */
  }
  applyMode(mode);
  listeners.forEach((fn) => fn(mode));
}

const listeners = new Set<(mode: ThemeMode) => void>();

export function subscribeMode(fn: (mode: ThemeMode) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 系统偏好变化时，只有 system 档需要跟着变。 */
export function watchSystem(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    const mode = storedMode();
    if (mode === 'system') {
      applyMode(mode);
      listeners.forEach((fn) => fn(mode));
    }
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
