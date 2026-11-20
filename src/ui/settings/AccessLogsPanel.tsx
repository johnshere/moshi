/**
 * 「日志与保留」面板（P4；开发方案 §4 P4 / §7）。
 *
 * 组件放在 `settings/` 只是因为历史位置；用户 m00882 起它归一级「接入」，用户 m01083
 * 起由日志页的弹框 `src/ui/access/LogConfigModal.tsx` 挂载（原 设置 › 接入与日志 已删，
 * 曾经短暂作为接入二级独立页也不再有菜单项）。
 *
 * **唯一写入口**：查询日志保留天数、插件运行日志档位/上限/保留，都经
 * `PUT /api/config`（白名单键，原子写回 YAML，daemon 收到后热应用档位）。
 * 日志页右上角的按钮只是打开这个弹框的快捷入口（用户 m02743）。
 *
 * 视觉（w10）：两段 `.diag-group`（`#query-log` / `#plugin-trace` 锚点保留，
 * 弹框的 scrollIntoView 依赖它们），行 `.form-row`，值右对齐等宽。
 */
import { useEffect, useState, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { purgeQueryLogs, purgeTraceLogs } from '../access/api.js';
import { useT } from '../i18n/index.js';

type TraceLevel = 'off' | 'summary' | 'full';

interface ConfigView {
  config: {
    storage: { query_log_keep_days: number };
    hook_plugin_trace: { level: TraceLevel; max_bytes: number; keep_days: number };
  };
}

interface Draft {
  keepDays: string;
  level: TraceLevel;
  maxBytes: string;
  traceKeepDays: string;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return body.message ?? body.error ?? `HTTP ${String(res.status)}`;
}

export function AccessLogsPanel(): ReactElement {
  const t = useT();
  const [loaded, setLoaded] = useState<ConfigView['config'] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmQuery, setConfirmQuery] = useState(false);
  const [confirmTrace, setConfirmTrace] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/config', { headers: { 'X-Moshi-Token': resolveToken() }, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorMessage(res));
        const view = (await res.json()) as ConfigView;
        setLoaded(view.config);
        setDraft({
          keepDays: String(view.config.storage.query_log_keep_days),
          level: view.config.hook_plugin_trace.level,
          maxBytes: String(view.config.hook_plugin_trace.max_bytes),
          traceKeepDays: String(view.config.hook_plugin_trace.keep_days),
        });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => controller.abort();
  }, []);

  const dirty =
    loaded !== null &&
    draft !== null &&
    (String(loaded.storage.query_log_keep_days) !== draft.keepDays ||
      loaded.hook_plugin_trace.level !== draft.level ||
      String(loaded.hook_plugin_trace.max_bytes) !== draft.maxBytes ||
      String(loaded.hook_plugin_trace.keep_days) !== draft.traceKeepDays);

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const patch = {
        storage: { query_log_keep_days: Number(draft.keepDays) },
        hook_plugin_trace: {
          level: draft.level,
          max_bytes: Number(draft.maxBytes),
          keep_days: Number(draft.traceKeepDays),
        },
      };
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Moshi-Token': resolveToken() },
        body: JSON.stringify({ patch }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setToast(t('access.logRetention.saved'));
      const next = (await fetch('/api/config', {
        headers: { 'X-Moshi-Token': resolveToken() },
      }).then((r) => r.json())) as ConfigView;
      setLoaded(next.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const purgeQuery = async (): Promise<void> => {
    if (!confirmQuery) {
      setConfirmQuery(true);
      return;
    }
    setConfirmQuery(false);
    try {
      const result = await purgeQueryLogs();
      setToast(t('access.logRetention.purged.query', { removed: result.removed, evidence: result.evidence_removed }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const purgeTrace = async (): Promise<void> => {
    if (!confirmTrace) {
      setConfirmTrace(true);
      return;
    }
    setConfirmTrace(false);
    try {
      const result = await purgeTraceLogs();
      setToast(t('access.logRetention.purged.trace', { disk: result.disk_removed, memory: result.memory_removed }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="form" data-testid="access-logs-panel">
      <section id="query-log" className="diag-group">
        <span className="diag-title">{t('access.logRetention.query.title')}</span>
        <span className="form-hint">{t('access.logRetention.query.desc')}</span>
        <div className="form-row">
          <label className="form-label" htmlFor="log-keep-days">
            {t('access.logRetention.keepDays')}
          </label>
          <input
            id="log-keep-days"
            name="query_log_keep_days"
            className="input-line"
            data-kind="num"
            data-testid="keep-days"
            value={draft?.keepDays ?? ''}
            onChange={(event) => setDraft(draft === null ? draft : { ...draft, keepDays: event.target.value })}
          />
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => { void purgeQuery(); }} data-testid="purge-query">
            {confirmQuery ? t('access.logRetention.purgeQuery.confirm') : t('access.logRetention.purgeQuery')}
          </button>
          <span className="form-hint">{t('access.logRetention.purgeQuery.hint')}</span>
        </div>
      </section>

      <section id="plugin-trace" className="diag-group">
        <span className="diag-title">{t('access.logRetention.trace.title')}</span>
        <span className="form-hint">{t('access.logRetention.trace.desc')}</span>
        <div className="form-row">
          <label className="form-label" htmlFor="log-trace-level">
            {t('access.logRetention.trace.level')}
          </label>
          <select
            id="log-trace-level"
            name="hook_plugin_trace_level"
            className="scope-select"
            data-testid="trace-level"
            value={draft?.level ?? 'off'}
            onChange={(event) =>
              setDraft(draft === null ? draft : { ...draft, level: event.target.value as TraceLevel })
            }
          >
            <option value="off">{t('access.logRetention.trace.level.off')}</option>
            <option value="summary">{t('access.logRetention.trace.level.summary')}</option>
            <option value="full">{t('access.logRetention.trace.level.full')}</option>
          </select>
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor="log-trace-max-bytes">
            {t('access.logRetention.trace.maxBytes')}
          </label>
          <input
            id="log-trace-max-bytes"
            name="hook_plugin_trace_max_bytes"
            className="input-line"
            data-kind="num"
            data-testid="trace-max-bytes"
            value={draft?.maxBytes ?? ''}
            onChange={(event) => setDraft(draft === null ? draft : { ...draft, maxBytes: event.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor="log-trace-keep-days">
            {t('access.logRetention.trace.keepDays')}
          </label>
          <input
            id="log-trace-keep-days"
            name="hook_plugin_trace_keep_days"
            className="input-line"
            data-kind="num"
            data-testid="trace-keep-days"
            value={draft?.traceKeepDays ?? ''}
            onChange={(event) => setDraft(draft === null ? draft : { ...draft, traceKeepDays: event.target.value })}
          />
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => { void purgeTrace(); }} data-testid="purge-trace">
            {confirmTrace ? t('access.logRetention.purgeTrace.confirm') : t('access.logRetention.purgeTrace')}
          </button>
          <span className="form-hint">{t('access.logRetention.purgeTrace.hint')}</span>
        </div>
      </section>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || saving}
          onClick={() => { void save(); }}
          data-testid="access-logs-save"
        >
          {saving ? t('access.logRetention.saving') : t('access.logRetention.save')}
        </button>
        {toast === null ? null : (
          <span className="notice" data-tone="ok" data-testid="access-logs-toast">
            <span className="notice-text">{toast}</span>
          </span>
        )}
        {error === null ? null : (
          <span className="notice" data-tone="error" data-testid="access-logs-error">
            <span className="notice-text">{error}</span>
          </span>
        )}
      </div>
    </div>
  );
}
