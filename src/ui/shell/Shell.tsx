/**
 * 应用外壳（W8H 遥测台）：顶部 56px 仪表导轨 + 全局状态读数 + 通道导航。
 *
 * 外壳只负责「常驻」和「取全局状态」，不接管页面内容：页面仍是 absolute inset:0
 * 填满 <main>。三灯与角标 30s 轮询一次，取数失败显式降级，不静默装正常。
 * 导航从左侧栏改为顶栏：一级通道常驻导轨；「接入」的两个二级（日志 / 接入点）在导轨
 * 下常驻一条页签带，与设置页的页签同一套 `.seg` 样式与语义（选中态、展开态都由 URL
 * 决定，见 pure.ts）。
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from 'react';
import { ACCESS_SECTIONS, NAV, accessHref, pageHref, queueBadge, statusLights, type AccessSection, type PageKey, type QueueBadge, type SettingsSection, type StatusLight } from './pure.js';
import { navigate, navigatePage } from './navigate.js';
import { gSequenceExpired, resolveKey } from './keyboard.js';
import { LocaleSwitch } from './LocaleSwitch.js';
import { ThemeSwitch } from './ThemeSwitch.js';
import { useT } from '../i18n/index.js';
import { fetchQueueCounts, fetchStatus } from './api.js';
import { FirstRun } from './FirstRun.js';
import { OnboardModal } from './OnboardModal.js';
import { ToastHost } from './ToastHost.js';
import { useNav } from '../state/nav.js';
import { useSelection } from '../state/selection.js';

const POLL_MS = 30_000;

/** 灯旁的等宽状态码（两语同形：仪表读数不翻译） */
const LIGHT_CODES = {
  ok: 'light.code.ok',
  warn: 'light.code.warn',
  error: 'light.code.error',
  off: 'light.code.off',
} as const;

function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * `/` 的落点：全局搜索框挂在记忆页工具条上（V-10，用户 m01201 把顶栏收成 语言+三灯+角标）。
 * 当前页没有搜索框（图谱 / 待办 / 归档 / 设置）就先跳到记忆页，再等 DOM 挂上后聚焦。
 */
function focusGlobalSearch(): void {
  const take = (): boolean => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="global-search"]');
    if (input === null) return false;
    input.focus();
    input.select();
    return true;
  };
  if (take()) return;
  navigatePage('memories');
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (take() || attempts >= 20) window.clearInterval(timer);
  }, 50);
}

export interface ShellProps {
  route: PageKey;
  /** 设置二级；非设置页传 null（设计 §16.5.2：菜单树展开态由 URL 决定） */
  section: SettingsSection | null;
  /** 接入二级；非接入页传 null（P4） */
  accessSection: AccessSection | null;
  children: ReactNode;
}

export function Shell({ route, accessSection, children }: ShellProps): ReactElement {
  const t = useT();
  const [lights, setLights] = useState<readonly StatusLight[]>(statusLights(null));
  const [badge, setBadge] = useState<QueueBadge | null>(null);
  /** 首启弹窗开着时压掉首屏提示条：弹窗讲的正是同一件事，两条并排太吵 */
  const [onboardOpen, setOnboardOpen] = useState(false);
  const badgeCount = badge?.total ?? 0;
  /** `g` 序列的起点时刻；600ms 内按第二个键才跳页（见 keyboard.ts） */
  const pendingGRef = useRef<number | null>(null);

  // 全局键盘导航（P2-19A-07b）：`/` 聚焦搜索、`g` 序列跳页、j/k 列表移动、Esc 收起。
  // 纯解析在 keyboard.ts，这里只执行；add/remove 严格配对、卸载时清理。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const now = Date.now();
      const action = resolveKey(event, {
        pendingGAt: pendingGRef.current,
        now,
        listNav: useNav.getState().items.length > 0,
      });
      if (action === null) {
        if (gSequenceExpired(pendingGRef.current, now)) pendingGRef.current = null;
        return;
      }
      switch (action.type) {
        case 'arm-g':
          pendingGRef.current = now;
          return;
        case 'focus-search': {
          event.preventDefault();
          pendingGRef.current = null;
          focusGlobalSearch();
          return;
        }
        case 'nav':
          event.preventDefault();
          pendingGRef.current = null;
          navigatePage(action.page);
          return;
        case 'move':
          event.preventDefault();
          pendingGRef.current = null;
          useNav.getState().move(action.delta);
          return;
        case 'escape': {
          pendingGRef.current = null;
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.getAttribute('data-testid') === 'global-search') {
            active.blur();
          } else {
            useSelection.getState().clear();
          }
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        const status = await fetchStatus(controller.signal);
        if (!disposed) setLights(statusLights(status));
      } catch {
        if (!disposed) setLights(statusLights(null));
      }
      try {
        const counts = await fetchQueueCounts(controller.signal);
        if (!disposed) setBadge(queueBadge(counts));
      } catch {
        if (!disposed) setBadge(null);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="deck">
      {onboardOpen ? null : <FirstRun />}
      <OnboardModal onOpenChange={setOnboardOpen} />

      <header className="masthead">
        <div className="masthead-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0 }}>
            <span>{t('app.brand')}</span>
            <span className="brand-tagline" title={t('app.tagline')}>
              {t('app.tagline')}
            </span>
          </span>
        </div>

        <nav className="masthead-nav" data-testid="shell-nav" aria-label={t('app.brand')}>
          {NAV.map((node) => {
            const active = node.key === route;
            return (
              <div key={node.key} data-testid={`nav-node-${node.key}`} style={{ display: 'contents' }}>
                <a
                  href={pageHref(node.key, window.location.search)}
                  aria-current={active ? 'page' : undefined}
                  aria-expanded={node.children === undefined ? undefined : active}
                  data-testid={`nav-${node.key}`}
                  data-active={active ? 'true' : 'false'}
                  className="deck-tab"
                  onClick={(event) => {
                    if (!isPlainLeftClick(event)) return;
                    event.preventDefault();
                    navigate(pageHref(node.key, window.location.search));
                  }}
                  title={t(node.titleKey)}
                >
                  {t(node.labelKey)}
                </a>
              </div>
            );
          })}
        </nav>

        <div className="deck-tools">
          <LocaleSwitch />
          <ThemeSwitch />
          <div className="deck-status" data-testid="status-lights">
            {lights.map((light) => (
              <span
                key={light.key}
                className="deck-light"
                data-testid={`light-${light.key}`}
                data-state={light.state}
                title={t(light.textKey, light.textVars)}
              >
                <span className="moshi-light-dot" data-state={light.state} />
                <span className="status-label">{t(light.labelKey)}</span>
                <span className="light-code">{t(LIGHT_CODES[light.state])}</span>
              </span>
            ))}
          </div>
          <a
            href={pageHref('inbox', window.location.search)}
            data-testid="inbox-badge"
            data-count={badgeCount > 0 ? 'active' : 'zero'}
            className="moshi-inbox-badge"
            title={t('topbar.inbox.title')}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              navigatePage('inbox');
            }}
          >
            {t('topbar.inbox.badge', { count: badge === null ? '—' : badge.label })}
          </a>
          <span className="masthead-coord" aria-hidden="true">
            {window.location.pathname}
          </span>
        </div>
      </header>

      {/* 接入二级：日志 / 接入点。设置页的二级在页头自建页签，这里只为「接入」补一条
          常驻页签带——导轨一行放不下两级，二级就落在导轨正下方，样式与设置页同源。 */}
      {route === 'access' ? (
        <div className="masthead-subnav" data-testid="access-section-bar">
          <span className="subnav-label" aria-hidden="true">
            {t('nav.access')}
          </span>
          <div className="seg subnav-tabs" role="tablist" aria-label={t('nav.access.title')} data-testid="access-section-tabs">
            {ACCESS_SECTIONS.map((item) => {
              const active = item.key === accessSection;
              return (
                <a
                  key={item.key}
                  href={accessHref(item.key, window.location.search)}
                  role="tab"
                  aria-selected={active}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`nav-access-${item.key}`}
                  data-active={active ? 'true' : 'false'}
                  className="seg-item"
                  title={t(item.titleKey)}
                  onClick={(event) => {
                    if (!isPlainLeftClick(event)) return;
                    event.preventDefault();
                    navigate(accessHref(item.key, window.location.search));
                  }}
                >
                  {t(item.labelKey)}
                </a>
              );
            })}
          </div>
        </div>
      ) : null}

      <main className="shell-main">{children}</main>
      <ToastHost />
    </div>
  );
}
