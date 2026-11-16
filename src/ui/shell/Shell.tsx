/**
 * 应用外壳（P2-19-A，概设 §8.1）：左侧一级导航 + 顶栏语言/三灯/待办角标。
 *
 * 外壳只负责「常驻」和「取全局状态」，不接管页面内容：页面仍是 absolute inset:0
 * 填满 <main>。三灯与角标 30s 轮询一次，取数失败显式降级，不静默装正常。
 * 顶栏只留 语言 + 三灯 + 角标；全局搜索与作用域下拉在记忆页工具条上（V-10，用户 m01201）。
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from 'react';
import { NAV, hrefForPath, lightColor, pageHref, queueBadge, statusLights, type AccessSection, type PageKey, type QueueBadge, type SettingsSection, type StatusLight } from './pure.js';
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

const shellStyle: CSSProperties = {
  display: 'flex',
  width: '100vw',
  height: '100vh',
  overflow: 'hidden',
  background: 'var(--color-bg-base)',
  color: 'var(--color-text-secondary)',
  fontFamily:
    "'SF Pro Text', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
};

const navStyle: CSSProperties = {
  width: 208,
  flex: '0 0 208px',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  padding: '14px 12px',
  gap: 4,
};

const brandStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--color-text-primary)',
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: '.02em',
  padding: '4px 10px 14px',
};

/** 品牌标记：一个小方块 + 一个强调色圆点，成本极低但让左栏有「头」 */
const brandMarkStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 7,
  border: '1px solid var(--color-border-subtle)',
  background: 'var(--color-bg-overlay)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  position: 'relative',
  flex: 'none',
};

const brandDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--color-accent)',
};

const topbarStyle: CSSProperties = {
  height: 56,
  flex: '0 0 56px',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '0 16px',
  background: 'var(--color-bg-raised)',
  borderBottom: '1px solid var(--color-border-subtle)',
  boxSizing: 'border-box',
};

function navItemStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 8,
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  };
}

/** 树里的一级子项（设置五二级）：缩进 + 小一号，用左侧竖线表达从属关系。 */
function navChildStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    padding: '5px 10px 5px 24px',
    borderRadius: 7,
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    textDecoration: 'none',
    fontSize: 12,
    cursor: 'pointer',
    position: 'relative',
  };
}

/** 子项左侧的树线：始终画，短一截表示「最后一个」由 CSS 无法判断，统一同长短。 */
const navTreeLineStyle: CSSProperties = {
  position: 'absolute',
  left: 13,
  top: 0,
  bottom: 0,
  width: 1,
  background: 'var(--color-border-subtle)',
};

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

export function Shell({ route, section, accessSection, children }: ShellProps): ReactElement {
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
    <div style={shellStyle}>
      {onboardOpen ? null : <FirstRun />}
      <OnboardModal onOpenChange={setOnboardOpen} />
      <aside style={navStyle} data-testid="shell-nav" className="moshi-nav">
        <div style={brandStyle}>
          <span style={brandMarkStyle} aria-hidden="true">
            <span style={brandDotStyle} />
          </span>
          {t('app.brand')}
        </div>
        {NAV.map((node) => {
          const active = node.key === route;
          return (
            <div key={node.key} data-testid={`nav-node-${node.key}`}>
              <a
                href={pageHref(node.key, window.location.search)}
                aria-current={active ? 'page' : undefined}
                aria-expanded={node.children === undefined ? undefined : active}
                data-testid={`nav-${node.key}`}
                data-active={active ? 'true' : 'false'}
                className="moshi-nav-item"
                style={navItemStyle(active)}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) return;
                  event.preventDefault();
                  navigate(pageHref(node.key, window.location.search));
                }}
                title={t(node.titleKey)}
              >
                {t(node.labelKey)}
              </a>
              {node.children !== undefined && active
                ? node.children.map((child) => {
                    const childActive =
                      node.key === 'settings' ? child.key === section : child.key === accessSection;
                    return (
                      <a
                        key={child.key}
                        href={hrefForPath(child.path, window.location.search)}
                        aria-current={childActive ? 'page' : undefined}
                        data-testid={`nav-${node.key}-${child.key}`}
                        data-active={childActive ? 'true' : 'false'}
                        className="moshi-nav-item moshi-nav-child"
                        style={navChildStyle(childActive)}
                        onClick={(event) => {
                          if (!isPlainLeftClick(event)) return;
                          event.preventDefault();
                          navigate(hrefForPath(child.path, window.location.search));
                        }}
                      >
                        <span style={navTreeLineStyle} aria-hidden="true" />
                        {t(child.labelKey)}
                      </a>
                    );
                  })
                : null}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <div style={{ color: 'var(--color-text-faint)', fontSize: 11, padding: '0 10px' }}>{t('app.tagline')}</div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <header style={topbarStyle}>
          <div style={{ flex: 1 }} />
          <LocaleSwitch />
          <ThemeSwitch />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} data-testid="status-lights">
            {lights.map((light) => (
              <span
                key={light.key}
                data-testid={`light-${light.key}`}
                data-state={light.state}
                title={t(light.textKey, light.textVars)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--color-text-secondary)' }}
              >
                <span
                  className="moshi-light-dot"
                  data-state={light.state}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: lightColor(light.state),
                    display: 'inline-block',
                  }}
                />
                {t(light.labelKey)}
              </span>
            ))}
          </div>
          <a
            href={pageHref('inbox', window.location.search)}
            data-testid="inbox-badge"
            data-count={badgeCount > 0 ? 'active' : 'zero'}
            className="moshi-inbox-badge"
            title={t('topbar.inbox.title')}
            style={{
              color: badgeCount > 0 ? 'var(--color-warning-soft)' : 'var(--color-text-muted)',
              textDecoration: 'none',
              fontSize: 12,
              border: `1px solid ${badgeCount > 0 ? 'var(--color-warning-dim)' : 'var(--color-border-subtle)'}`,
              background: badgeCount > 0 ? 'var(--color-warning-bg)' : 'var(--color-bg-raised)',
              borderRadius: 999,
              padding: '2px 10px',
            }}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              navigatePage('inbox');
            }}
          >
            {t('topbar.inbox.badge', { count: badge === null ? '—' : badge.label })}
          </a>
        </header>
        <main style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>{children}</main>
      </div>
      <ToastHost />
    </div>
  );
}
