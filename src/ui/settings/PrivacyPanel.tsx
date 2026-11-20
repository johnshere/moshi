/**
 * 隐私面板（P2-19A-15）：隐私总览 + 全库导出 + 物理清理（唯一删除入口）。
 *
 * 后端契约（已接线）：
 * - `GET  /api/privacy/overview`（schema moshi-privacy/1）
 * - `POST /api/privacy/purge` body `{scope, dry_run?, confirm:'PURGE'}`
 * - `GET  /api/export/all` 附件流
 *
 * 纪律：不写 SQL、不改后端；导出/清理都走既有 HTTP 接口。
 * 请求函数暂放本文件（task-24 正在改 `src/ui/api.ts`，按 Lead 要求不动它）。
 *
 * 视觉（w10）：总览是一条读数带（标签 + 等宽值）；清理是带内嵌的一小条危险带，
 * 预览是 `.notice`；`privacy-pure.ts` 的判定逻辑一字未动。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { t as translate, useT } from '../i18n/index.js';
import {
  canSubmitPurge,
  overviewRows,
  purgeDeletedTotal,
  purgeSummary,
  purgeScopes,
  type PrivacyOverview,
  type PurgePreview,
  type PurgeResult,
  type PurgeScope,
  type WouldDelete,
} from './privacy-pure.js';

interface ErrorPayload {
  error?: string;
  message?: string;
  detail?: { reason?: string };
}

function errorText(body: UnknownBody, status: number): string {
  const reason = body.detail?.reason;
  const message = body.message ?? body.error ?? `HTTP ${String(status)}`;
  return reason === undefined ? message : translate('settings.cfg.httpError', { message, reason });
}

interface UnknownBody extends ErrorPayload {
  detail?: { reason?: string };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function fetchOverview(signal?: AbortSignal): Promise<PrivacyOverview> {
  const res = await fetch('/api/privacy/overview', {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) throw new Error(errorText(await readJson<UnknownBody>(res).catch(() => ({})), res.status));
  return readJson<PrivacyOverview>(res);
}

async function postPurge(body: {
  scope: PurgeScope;
  dry_run: boolean;
  confirm: string;
}): Promise<{ dryRun: true; preview: PurgePreview } | { dryRun: false; result: PurgeResult }> {
  const res = await fetch('/api/privacy/purge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Moshi-Token': resolveToken() },
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => ({}));
  const json = raw as UnknownBody & Partial<PurgePreview & PurgeResult>;
  if (!res.ok) throw new Error(errorText(json, res.status));
  if (json.dry_run === true) return { dryRun: true, preview: json as PurgePreview };
  return { dryRun: false, result: json as PurgeResult };
}

async function downloadAllExport(): Promise<string> {
  const res = await fetch('/api/export/all', {
    headers: { 'X-Moshi-Token': resolveToken() },
  });
  if (!res.ok) throw new Error(errorText(await readJson<UnknownBody>(res).catch(() => ({})), res.status));
  const disposition = res.headers.get('content-disposition') ?? '';
  const matched = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = matched?.[1] ?? `moshi-export-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return filename;
}

export function PrivacyPanel(): ReactElement {
  const t = useT();
  const [overview, setOverview] = useState<PrivacyOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [scope, setScope] = useState<PurgeScope>('all');
  const [confirmText, setConfirmText] = useState('');
  const [preview, setPreview] = useState<WouldDelete | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setBusy(true);
    try {
      setOverview(await fetchOverview(signal));
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const onExport = (): void => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    setNotice(null);
    void downloadAllExport()
      .then((filename) => {
        setNotice(t('privacy.exported', { file: filename }));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setExporting(false);
      });
  };

  const openDialog = (): void => {
    setDialogOpen(true);
    setScope('all');
    setConfirmText('');
    setPreview(null);
    setError(null);
    setNotice(null);
  };

  const onPreview = (): void => {
    if (previewBusy) return;
    setPreviewBusy(true);
    setError(null);
    void postPurge({ scope, dry_run: true, confirm: confirmText })
      .then((out) => {
        if (out.dryRun) setPreview(out.preview.would_delete);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setPreviewBusy(false);
      });
  };

  const onExecute = (): void => {
    if (executing || !canSubmitPurge(confirmText, scope)) return;
    setExecuting(true);
    setError(null);
    void postPurge({ scope, dry_run: false, confirm: confirmText })
      .then((out) => {
        if (out.dryRun) return;
        const total = purgeDeletedTotal(out.result.deleted);
        setNotice(t('privacy.purged', { count: total }));
        setDialogOpen(false);
        setPreview(null);
        return load();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setExecuting(false);
      });
  };

  return (
    <section className="band" data-testid="privacy-panel">
      <div className="band-head">
        <span className="band-title">{t('privacy.title')}</span>
        <div className="band-tools">
          <button type="button" className="btn" data-testid="privacy-refresh" disabled={busy} onClick={() => void load()}>
            {busy ? t('privacy.refreshing') : t('privacy.refresh')}
          </button>
          <button type="button" className="btn" data-testid="privacy-export" disabled={exporting} onClick={onExport}>
            {exporting ? t('privacy.exporting') : t('privacy.export')}
          </button>
          <button type="button" className="btn btn-danger" data-testid="privacy-open-dialog" onClick={openDialog}>
            {t('privacy.purge')}
          </button>
        </div>
      </div>
      <div className="band-body">
        <span className="station-note">{t('privacy.purgeHint')}</span>

        {notice !== null && (
          <div className="notice" data-tone="ok" data-testid="privacy-notice">
            <span className="notice-text">{notice}</span>
          </div>
        )}
        {error !== null && (
          <div className="notice" data-tone="error" data-testid="privacy-error">
            <span className="notice-text">{error}</span>
          </div>
        )}

        <div className="data-table" data-testid="privacy-overview">
          {overview === null ? (
            <div className="data-empty">{busy ? t('privacy.loading') : t('privacy.notLoaded')}</div>
          ) : (
            overviewRows(overview, t).map((row) => (
              <div key={row.label} className="data-row cols-privacy" data-testid="privacy-row">
                <span className="tone-mute">{row.label}</span>
                <span className="tile-line">{row.value}</span>
              </div>
            ))
          )}
        </div>

        {dialogOpen && (
          <section className="band" data-tone="danger" data-testid="privacy-dialog">
            <div className="band-head">
              <span className="band-title tone-err">{t('privacy.dialog.title')}</span>
            </div>
            <div className="band-body">
              <div className="field-row">
                <span className="field-label">{t('privacy.scopeLabel')}</span>
                <select
                  className="scope-select"
                  data-testid="privacy-scope"
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as PurgeScope);
                    setPreview(null);
                  }}
                >
                  {purgeScopes(t).map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <span className="field-label">{t('privacy.confirmLabel')}</span>
                <input
                  className="input-line"
                  data-testid="privacy-confirm"
                  value={confirmText}
                  placeholder={t('privacy.confirmPlaceholder')}
                  onChange={(e) => {
                    setConfirmText(e.target.value);
                    setPreview(null);
                  }}
                />
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  data-testid="privacy-dry-run"
                  disabled={previewBusy || executing}
                  onClick={onPreview}
                >
                  {previewBusy ? t('privacy.previewing') : t('privacy.preview')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  data-testid="privacy-execute"
                  disabled={!canSubmitPurge(confirmText, scope) || executing}
                  onClick={onExecute}
                >
                  {executing ? t('privacy.executing') : t('privacy.execConfirm')}
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="privacy-close"
                  disabled={executing}
                  onClick={() => {
                    setDialogOpen(false);
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
              {preview !== null && (
                <div className="notice" data-tone="warn" data-testid="privacy-preview">
                  <span className="notice-text">{t('privacy.previewLine', { summary: purgeSummary(preview, t) })}</span>
                </div>
              )}
              <span className="form-hint">{t('privacy.auditNote')}</span>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
