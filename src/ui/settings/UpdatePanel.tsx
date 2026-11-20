/**
 * 软件更新面板（V-03B）：检查 GitHub Releases → 下载 → 静默安装并重启。
 *
 * 界面只做三件事：展示检查结果、触发下载、触发安装。版本比较与资产选择在
 * 后端（`GET /api/update`），这里不重复判定。
 *
 * 视觉（w10）：一条读数带；当前版本是等宽读数，更新说明与结果行用提示条/读数带脚。
 */
import { useEffect, useState, type ReactElement } from 'react';
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

  const hasUpdate = status !== null && status.ok && status.available;

  return (
    <section className="band" data-testid="update-panel">
      <div className="band-head">
        <span className="band-title">{t('settings.update.title')}</span>
        <span className="readout">
          {t('settings.update.current', { version: status === null ? '—' : status.current })}
        </span>
        <div className="band-tools">
          <button type="button" className="btn" onClick={() => void check()} disabled={busy !== null}>
            {busy === 'check' ? t('settings.update.checking') : t('settings.update.check')}
          </button>
        </div>
      </div>
      <div className="band-body">
        <span className="station-note">
          {status !== null && status.enabled && status.ok && !status.available ? t('settings.update.upToDate') : null}
          {status !== null && !status.enabled ? t('settings.update.disabled') : null}
        </span>
        {hasUpdate && (
          <span className="tile-line tone-accent">
            {t('settings.update.found', { version: status.latest ?? '' })}
            {status.published_at === null ? '' : t('settings.update.published', { date: status.published_at.slice(0, 10) })}
            {status.asset_url === null ? t('settings.update.noAsset') : ''}
          </span>
        )}
        {hasUpdate && status.notes !== null && <pre className="dialog-pre">{status.notes}</pre>}
        {status !== null && !status.ok && (
          <div className="notice" data-tone="warn">
            <span className="notice-text">{t('settings.update.checkFailed', { error: status.error ?? '' })}</span>
          </div>
        )}
        <div className="btn-row">
          {hasUpdate && status.asset_url !== null && (
            <button type="button" className="btn" onClick={() => void download()} disabled={busy !== null}>
              {busy === 'download' ? t('settings.update.downloading') : t('settings.update.download')}
            </button>
          )}
          {downloaded !== null && (
            <button type="button" className="btn btn-primary" onClick={() => void install()} disabled={busy !== null}>
              {busy === 'install' ? t('settings.update.installing') : t('settings.update.install')}
            </button>
          )}
        </div>
        {message !== null && (
          <div className="notice" data-tone="info">
            <span className="notice-text">{t(message.key, message.vars)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
