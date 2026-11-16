/**
 * 隐私面板（P2-19A-15）：隐私总览 + 全库导出 + 物理清理（唯一删除入口）。
 *
 * 后端契约（已接线）：
 * - `GET  /api/privacy/overview`（schema moshi-privacy/1）
 * - `POST /api/privacy/purge` body `{scope, dry_run?, confirm:'PURGE'}`
 * - `GET  /api/export/all` 附件流
 *
 * 纪律：不写 SQL、不改后端；导出/清理都走既有 HTTP 接口。样式 inline（P2-19-B 统一）。
 * 请求函数暂放本文件（task-24 正在改 `src/ui/api.ts`，按 Lead 要求不动它）。
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react';
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

const panelStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  color: 'var(--color-text-secondary)',
  fontSize: 13,
};

const buttonStyle: CSSProperties = {
  background: 'var(--color-bg-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'var(--color-danger-bg)',
  borderColor: 'var(--color-danger-dim)',
  color: 'var(--color-danger-soft)',
};

const inputStyle: CSSProperties = {
  background: 'var(--color-bg-overlay)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 8,
  padding: '5px 8px',
  fontSize: 12,
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '140px minmax(0, 1fr)',
  gap: 8,
  alignItems: 'baseline',
  fontSize: 12,
};

const noticeStyle: CSSProperties = {
  color: 'var(--color-success-soft)',
  background: 'var(--color-success-bg)',
  border: '1px solid var(--color-success-dim)',
  borderRadius: 8,
  padding: '6px 8px',
};

const errorStyle: CSSProperties = {
  color: 'var(--color-danger-soft)',
  background: 'var(--color-danger-bg)',
  border: '1px solid var(--color-danger-dim)',
  borderRadius: 8,
  padding: '6px 8px',
};

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
    <section data-testid="privacy-panel" style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ color: 'var(--color-text-primary)', fontSize: 14, fontWeight: 600 }}>{t('privacy.title')}</div>
        <button
          type="button"
          data-testid="privacy-refresh"
          style={buttonStyle}
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? t('privacy.refreshing') : t('privacy.refresh')}
        </button>
        <button
          type="button"
          data-testid="privacy-export"
          style={buttonStyle}
          disabled={exporting}
          onClick={onExport}
        >
          {exporting ? t('privacy.exporting') : t('privacy.export')}
        </button>
        <button
          type="button"
          data-testid="privacy-open-dialog"
          style={dangerButtonStyle}
          onClick={openDialog}
        >
          {t('privacy.purge')}
        </button>
      </div>

      <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>
        {t('privacy.purgeHint')}
      </div>

      {notice !== null && (
        <div data-testid="privacy-notice" style={noticeStyle}>
          {notice}
        </div>
      )}
      {error !== null && (
        <div data-testid="privacy-error" style={errorStyle}>
          {error}
        </div>
      )}

      <div data-testid="privacy-overview" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {overview === null
          ? busy
            ? t('privacy.loading')
            : t('privacy.notLoaded')
          : overviewRows(overview, t).map((row) => (
              <div key={row.label} data-testid="privacy-row" style={rowStyle}>
                <span style={{ color: 'var(--color-text-muted)' }}>{row.label}</span>
                <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{row.value}</span>
              </div>
            ))}
      </div>

      {dialogOpen && (
        <div
          data-testid="privacy-dialog"
          style={{
            background: 'var(--color-bg-overlay)',
            border: '1px solid var(--color-danger-dim)',
            borderRadius: 8,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ color: 'var(--color-danger-soft)', fontWeight: 600 }}>{t('privacy.dialog.title')}</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--color-text-secondary)', width: 48 }}>{t('privacy.scopeLabel')}</span>
            <select
              data-testid="privacy-scope"
              value={scope}
              style={inputStyle}
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
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--color-text-secondary)', width: 48 }}>{t('privacy.confirmLabel')}</span>
            <input
              data-testid="privacy-confirm"
              value={confirmText}
              placeholder={t('privacy.confirmPlaceholder')}
              style={{ ...inputStyle, width: 160 }}
              onChange={(e) => {
                setConfirmText(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="privacy-dry-run"
              style={buttonStyle}
              disabled={previewBusy || executing}
              onClick={onPreview}
            >
              {previewBusy ? t('privacy.previewing') : t('privacy.preview')}
            </button>
            <button
              type="button"
              data-testid="privacy-execute"
              style={{
                ...dangerButtonStyle,
                opacity: canSubmitPurge(confirmText, scope) && !executing ? 1 : 0.45,
              }}
              disabled={!canSubmitPurge(confirmText, scope) || executing}
              onClick={onExecute}
            >
              {executing ? t('privacy.executing') : t('privacy.execConfirm')}
            </button>
            <button
              type="button"
              data-testid="privacy-close"
              style={buttonStyle}
              disabled={executing}
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
          {preview !== null && (
            <div data-testid="privacy-preview" style={{ fontSize: 12, color: 'var(--color-warning-soft)' }}>
              {t('privacy.previewLine', { summary: purgeSummary(preview, t) })}
            </div>
          )}
          <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>
            {t('privacy.auditNote')}
          </div>
        </div>
      )}
    </section>
  );
}
