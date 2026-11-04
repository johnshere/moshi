/**
 * 应用外壳（P2-19-A，概设 §8.1）：左侧一级导航 + 顶栏全局搜索/三灯/待办角标。
 *
 * 外壳只负责「常驻」和「取全局状态」，不接管页面内容：页面仍是 absolute inset:0
 * 填满 <main>。三灯与角标 30s 轮询一次，取数失败显式降级，不静默装正常。
 */
import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from 'react';
import { PAGES, lightColor, pageHref, queueBadge, statusLights, type PageKey, type QueueBadge, type StatusLight } from './pure.js';
import { navigate, navigatePage } from './navigate.js';
import { SearchBox } from './SearchBox.js';
import { fetchQueueCounts, fetchStatus } from './api.js';

const POLL_MS = 30_000;

const shellStyle: CSSProperties = {
  display: 'flex',
  width: '100vw',
  height: '100vh',
  overflow: 'hidden',
  background: '#070c16',
  color: '#cbd5e1',
  fontFamily: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif',
};

const navStyle: CSSProperties = {
  width: 172,
  flex: '0 0 172px',
  display: 'flex',
  flexDirection: 'column',
  background: '#0b1220',
  borderRight: '1px solid #1e293b',
  boxSizing: 'border-box',
  padding: '10px 8px',
  gap: 2,
};

const brandStyle: CSSProperties = {
  color: '#e2e8f0',
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: 1,
  padding: '4px 10px 12px',
};

const topbarStyle: CSSProperties = {
  height: 46,
  flex: '0 0 46px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 12px',
  background: '#0b1220',
  borderBottom: '1px solid #1e293b',
  boxSizing: 'border-box',
};

function navItemStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    borderRadius: 5,
    color: active ? '#f8fafc' : '#94a3b8',
    background: active ? '#1e293b' : 'transparent',
    textDecoration: 'none',
    fontSize: 13,
    cursor: 'pointer',
  };
}

function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export interface ShellProps {
  route: PageKey;
  children: ReactNode;
}

export function Shell({ route, children }: ShellProps): ReactElement {
  const [lights, setLights] = useState<readonly StatusLight[]>(statusLights(null));
  const [badge, setBadge] = useState<QueueBadge | null>(null);

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
      <aside style={navStyle} data-testid="shell-nav">
        <div style={brandStyle}>默识</div>
        {PAGES.map((page) => {
          const active = page.key === route;
          return (
            <a
              key={page.key}
              href={pageHref(page.key, window.location.search)}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${page.key}`}
              style={navItemStyle(active)}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                navigate(pageHref(page.key, window.location.search));
              }}
              title={page.title}
            >
              {page.label}
            </a>
          );
        })}
        <div style={{ flex: 1 }} />
        <div style={{ color: '#475569', fontSize: 11, padding: '0 10px' }}>本地知识图谱</div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <header style={topbarStyle}>
          <SearchBox />
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} data-testid="status-lights">
            {lights.map((light) => (
              <span
                key={light.key}
                data-testid={`light-${light.key}`}
                data-state={light.state}
                title={light.text}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94a3b8' }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: lightColor(light.state),
                    display: 'inline-block',
                  }}
                />
                {light.label}
              </span>
            ))}
          </div>
          <a
            href={pageHref('inbox', window.location.search)}
            data-testid="inbox-badge"
            title="待办：消解确认 / 低置信 / 淘汰候选（按单页 200 条估算）"
            style={{
              color: '#fbbf24',
              textDecoration: 'none',
              fontSize: 12,
              border: '1px solid #78350f',
              background: '#1c1205',
              borderRadius: 999,
              padding: '2px 10px',
            }}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              navigatePage('inbox');
            }}
          >
            待办 {badge === null ? '—' : badge.label}
          </a>
        </header>
        <main style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>{children}</main>
      </div>
    </div>
  );
}
