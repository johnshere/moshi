/**
 * 首开五态提示条（P2-19A-08，概设 §8.4 / 详设 §10.7）。
 *
 * 依据 `GET /api/status`（daemon/sidecar/mcp 最近调用）与 `GET /api/facts?limit=1`（是否有数据）
 * 判定要说什么；配置读取 `GET /api/config`（既有只读契约）只为「采集被手动关掉」这一态。
 *
 * 判定逻辑在 `./first-run.js`（纯函数，node 侧可直接单测）；这里只做取数、渲染与重试。
 * `ready` 或尚未探测完成时返回 null——首开提示不是常驻 UI。
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { useT } from '../i18n/index.js';
import {
  BANNERS,
  firstRunState,
  type BannerSpec,
  type FirstRunOptions,
  type FirstRunState,
  type FirstRunStatus,
} from './first-run.js';

const TONE_STYLE: Record<BannerSpec['tone'], CSSProperties> = {
  error: { background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-dim)', color: 'var(--color-danger-soft)' },
  info: { background: 'var(--color-bg-overlay)', border: '1px solid var(--color-info-bg)', color: 'var(--color-info-soft)' },
  muted: { background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-secondary)' },
  warn: { background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-dim)', color: 'var(--color-warning-soft)' },
};

const bannerStyle = (tone: BannerSpec['tone']): CSSProperties => ({
  position: 'fixed',
  top: 196,
  right: 14,
  zIndex: 60,
  maxWidth: 'min(440px, calc(100vw - 32px))',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  padding: '9px 14px',
  borderRadius: 10,
  textAlign: 'left',
  boxShadow: 'var(--shadow-menu)',
  fontSize: 12,
  lineHeight: 1.5,
  ...TONE_STYLE[tone],
});

const retryStyle: CSSProperties = {
  marginLeft: 'auto',
  background: 'transparent',
  color: 'inherit',
  border: '1px solid currentColor',
  borderRadius: 5,
  padding: '2px 10px',
  cursor: 'pointer',
  font: 'inherit',
  opacity: 0.9,
};

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { 'X-Moshi-Token': resolveToken() },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return (await res.json()) as T;
}

interface ProbeResult {
  status: FirstRunStatus | null;
  hasData: boolean;
  collectEnabled: boolean | null;
}

/**
 * 一次探测：status 失败 = daemon_off；成功后再并行取「有没有数据」「采集是否被关」。
 *
 * 后两者失败时按「不能证明异常」处理（hasData=true / collectEnabled=null），
 * 避免把一次 500 误报成「还没有记忆」。
 */
async function probe(signal: AbortSignal): Promise<ProbeResult> {
  let status: FirstRunStatus;
  try {
    status = await getJson<FirstRunStatus>('/api/status', signal);
  } catch {
    return { status: null, hasData: false, collectEnabled: null };
  }
  const [hasData, collectEnabled] = await Promise.all([
    (async (): Promise<boolean> => {
      try {
        const body = await getJson<{ items?: unknown[] }>('/api/facts?limit=1', signal);
        return !Array.isArray(body.items) || body.items.length > 0;
      } catch {
        return true;
      }
    })(),
    (async (): Promise<boolean | null> => {
      try {
        const body = await getJson<{ config?: { collect?: { enabled?: unknown } } }>(
          '/api/config',
          signal,
        );
        const enabled = body.config?.collect?.enabled;
        return typeof enabled === 'boolean' ? enabled : null;
      } catch {
        return null;
      }
    })(),
  ]);
  return { status, hasData, collectEnabled };
}

/** 顶部首开提示条。挂在 `Shell` 最外层；`ready` 时零占位。 */
export function FirstRun(): ReactElement | null {
  const t = useT();
  const [result, setResult] = useState<ProbeResult | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    const next = await probe(signal);
    if (!signal.aborted) setResult(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (result === null) return null;
  const options: FirstRunOptions = { collectEnabled: result.collectEnabled };
  const state: FirstRunState = firstRunState(result.status, result.hasData, options);
  if (state === 'ready') return null;
  // 用户 m00882：采集提醒三态暂不提示，等正式接入逻辑定稿——collect_off 没有文案，
  // 这里直接不渲染；判定仍留在 first-run.ts（其它地方还要用这个状态）。
  const banner = BANNERS[state];
  if (banner === undefined) return null;
  return (
    <div
      style={bannerStyle(banner.tone)}
      role="status"
      aria-live="polite"
      data-testid="first-run"
      data-state={state}
      className="moshi-firstrun"
    >
      <strong style={{ fontWeight: 600 }}>{t(banner.textKey)}</strong>
      <span style={{ opacity: 0.85 }}>{t(banner.hintKey)}</span>
      <button
        type="button"
        style={retryStyle}
        data-testid="first-run-retry"
        onClick={() => {
          void load(new AbortController().signal);
        }}
      >
        {t('common.retry')}
      </button>
    </div>
  );
}
