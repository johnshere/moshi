/**
 * 维护面板（P2-19A-06）：索引重建的显式入口。
 *
 * 调 `POST /api/maintenance/rebuild`，复用后端既有的 syncMissingFts / rebuildFts /
 * rebuildDegree / syncFactVectors，不在这里写任何 SQL 或索引逻辑。
 *
 * - 四个按钮：FTS / 向量 / 度数 / 全部
 * - 「只统计不重建」= dry_run，用于先看 before 计数
 * - 结果展示 before/after 的 mismatch 计数与耗时；向量在 sidecar 不可用时会 skipped
 *
 * 视觉（w10）：一条读数带；四个目标是一排 `.btn`，结果用读数行（before / after 右对齐）。
 */
import { useState, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { useT } from '../i18n/index.js';
import { t as translate } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

interface Counts {
  fts_missing: number;
  vec_missing: number;
  degree_mismatch: number;
}

interface RebuildResult {
  ok: boolean;
  target: string;
  dry_run: boolean;
  before: Counts;
  after: Counts;
  elapsed_ms: number;
  skipped?: string[];
  details?: Record<string, unknown>;
}

const TARGETS: readonly { target: 'fts' | 'vec' | 'degree' | 'all'; labelKey: DictKey }[] = [
  { target: 'fts', labelKey: 'settings.maint.target.fts' },
  { target: 'vec', labelKey: 'settings.maint.target.vec' },
  { target: 'degree', labelKey: 'settings.maint.target.degree' },
  { target: 'all', labelKey: 'settings.maint.target.all' },
];

const COUNT_LABELS: readonly { key: keyof Counts; labelKey: DictKey }[] = [
  { key: 'fts_missing', labelKey: 'settings.maint.count.fts' },
  { key: 'vec_missing', labelKey: 'settings.maint.count.vec' },
  { key: 'degree_mismatch', labelKey: 'settings.maint.count.degree' },
];

async function postRebuild(target: string, dryRun: boolean): Promise<RebuildResult> {
  const res = await fetch('/api/maintenance/rebuild', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Moshi-Token': resolveToken() },
    body: JSON.stringify({ target, dry_run: dryRun }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<RebuildResult> & {
    message?: string;
    error?: string;
    detail?: { reason?: string };
  };
  if (!res.ok) {
    const message = body.message ?? body.error ?? `HTTP ${String(res.status)}`;
    const reason = body.detail?.reason;
    throw new Error(
      reason === undefined ? message : translate('settings.cfg.httpError', { message, reason }),
    );
  }
  return body as RebuildResult;
}

export function MaintenancePanel(): ReactElement {
  const t = useT();
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (target: string): Promise<void> => {
    if (running !== null) return;
    setRunning(target);
    setError(null);
    setResult(null);
    try {
      setResult(await postRebuild(target, dryRun));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  return (
    <section className="band" data-testid="maintenance-panel">
      <div className="band-head">
        <span className="band-title">{t('settings.maint.title')}</span>
        <span className="band-tag">{dryRun ? 'dry_run' : t('settings.maint.done')}</span>
      </div>
      <div className="band-body">
        <span className="station-note">{t('settings.maint.desc')}</span>

        <label className="switch" style={{ paddingTop: 0 }}>
          <input
            type="checkbox"
            data-testid="maintenance-dry-run"
            checked={dryRun}
            disabled={running !== null}
            onChange={(e) => { setDryRun(e.target.checked); }}
          />
          <span className="switch-body">
            <span className="switch-label">{t('settings.maint.dryRun')}</span>
          </span>
        </label>

        <div className="btn-row">
          {TARGETS.map((item) => (
            <button
              key={item.target}
              type="button"
              className="btn"
              data-testid={`rebuild-${item.target}`}
              disabled={running !== null}
              onClick={() => { void run(item.target); }}
            >
              {running === item.target ? t('settings.maint.running') : t(item.labelKey)}
            </button>
          ))}
        </div>

        {error !== null && (
          <div className="notice" data-tone="error" data-testid="maintenance-error">
            <span className="notice-text">{error}</span>
          </div>
        )}

        {result !== null && (
          <div data-testid="maintenance-result">
            <div className="data-table">
              <div className="data-head cols-rebuild">
                <span>{t('settings.maint.col.metric')}</span>
                <span data-num="true">before</span>
                <span data-num="true">after</span>
              </div>
              {COUNT_LABELS.map((c) => (
                <div key={c.key} className="data-row cols-rebuild">
                  <span>{t(c.labelKey)}</span>
                  <span className="data-num tone-mute">{result.before[c.key]}</span>
                  <span
                    className={`data-num ${result.after[c.key] < result.before[c.key] ? 'tone-ok' : ''}`}
                  >
                    {result.after[c.key]}
                  </span>
                </div>
              ))}
            </div>
            <div className="tile-line tone-mute" style={{ marginTop: 6 }}>
              {result.target} · {result.dry_run ? 'dry_run' : t('settings.maint.done')} ·{' '}
              {String(result.elapsed_ms)}ms
              {result.skipped !== undefined && result.skipped.length > 0
                ? t('settings.maint.skipped', { list: result.skipped.join(', ') })
                : ''}
            </div>
            {result.details !== undefined && (
              <pre className="dialog-pre">{JSON.stringify(result.details, null, 2)}</pre>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
