/**
 * 软件更新面板（V-03B）：检查 GitHub Releases → 下载 → 静默安装并重启。
 *
 * 界面只做三件事：展示检查结果、触发下载、触发安装。版本比较与资产选择在
 * 后端（`GET /api/update`），这里不重复判定。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

interface UpdateStatus {
  schema: string;
  enabled: boolean;
  ok: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  notes: string | null;
  page_url: string | null;
  asset_url: string | null;
  asset_name: string | null;
  asset_size: number | null;
  published_at: string | null;
  checked_at: string;
  error: string | null;
}

interface DownloadResult {
  ok: boolean;
  version: string;
  path: string;
  bytes: number;
}

async function tokenHeaders(json = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'X-Moshi-Token': resolveToken() };
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

async function getStatus(): Promise<UpdateStatus> {
  const res = await fetch('/api/update?force=1', { headers: await tokenHeaders() });
  const body = (await res.json().catch(() => ({}))) as Partial<UpdateStatus> & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `HTTP ${String(res.status)}`);
  return body as UpdateStatus;
}

async function post(path: string): Promise<unknown> {
  const res = await fetch(path, { method: 'POST', headers: await tokenHeaders(true) });
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  return body;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const panelStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  color: 'var(--color-text-secondary)',
  fontSize: 13,
};

const buttonStyle: CSSProperties = {
  alignSelf: 'flex-start',
  background: 'var(--color-bg-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 8,
  padding: '5px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

export function UpdatePanel(): ReactElement {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null);
  /** 结果行存 key + 变量而不是成品字符串：切语言时同一行能跟着变 */
  const [message, setMessage] = useState<{ key: DictKey; vars?: Record<string, string> } | null>(null);
  const [downloaded, setDownloaded] = useState<DownloadResult | null>(null);

  const check = async (): Promise<void> => {
    setBusy('check');
    setMessage(null);
    setDownloaded(null);
    try {
      setStatus(await getStatus());
    } catch (err) {
      setMessage({ key: 'settings.update.checkFailed', vars: { error: err instanceof Error ? err.message : String(err) } });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void check();
  }, []);

  const download = async (): Promise<void> => {
    setBusy('download');
    setMessage(null);
    try {
      const body = (await post('/api/update/download')) as DownloadResult;
      setDownloaded(body);
      setMessage({ key: 'settings.update.downloaded', vars: { version: body.version, size: mb(body.bytes) } });
    } catch (err) {
      setMessage({ key: 'settings.update.downloadFailed', vars: { error: err instanceof Error ? err.message : String(err) } });
    } finally {
      setBusy(null);
    }
  };

  const install = async (): Promise<void> => {
    setBusy('install');
    setMessage(null);
    try {
      await post('/api/update/install');
      setMessage({ key: 'settings.update.installStarted' });
    } catch (err) {
      setMessage({ key: 'settings.update.installFailed', vars: { error: err instanceof Error ? err.message : String(err) } });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={panelStyle} data-testid="update-panel">
      <div style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{t('settings.update.title')}</div>
      <div>
        {t('settings.update.current', { version: status === null ? '—' : status.current })}
        {status !== null && status.enabled && status.ok && !status.available && t('settings.update.upToDate')}
        {status !== null && !status.enabled && t('settings.update.disabled')}
      </div>
      {status !== null && status.ok && status.available && (
        <div>
          {t('settings.update.found', { version: status.latest ?? '' })}
          {status.published_at === null ? '' : t('settings.update.published', { date: status.published_at.slice(0, 10) })}
          {status.asset_url === null && t('settings.update.noAsset')}
        </div>
      )}
      {status !== null && status.ok && status.available && status.notes !== null && (
        <pre
          style={{
            margin: 0,
            maxHeight: 120,
            overflow: 'auto',
            background: 'var(--color-bg-base)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 8,
            padding: 8,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {status.notes}
        </pre>
      )}
      {status !== null && !status.ok && (
        <div style={{ color: 'var(--color-warning-soft)' }}>{t('settings.update.checkFailed', { error: status.error ?? '' })}</div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={buttonStyle} onClick={() => void check()} disabled={busy !== null}>
          {busy === 'check' ? t('settings.update.checking') : t('settings.update.check')}
        </button>
        {status !== null && status.ok && status.available && status.asset_url !== null && (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void download()}
            disabled={busy !== null}
          >
            {busy === 'download' ? t('settings.update.downloading') : t('settings.update.download')}
          </button>
        )}
        {downloaded !== null && (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void install()}
            disabled={busy !== null}
          >
            {busy === 'install' ? t('settings.update.installing') : t('settings.update.install')}
          </button>
        )}
      </div>
      {message !== null && <div>{t(message.key, message.vars)}</div>}
    </div>
  );
}
