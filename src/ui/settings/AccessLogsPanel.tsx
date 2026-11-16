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
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { purgeQueryLogs, purgeTraceLogs } from '../access/api.js';

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

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 140 };
const inputStyle: CSSProperties = { fontSize: 12, padding: '3px 6px', width: 140 };
const buttonStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--color-border-strong, #3a4a5a)',
  background: 'var(--color-bg-raised)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
};

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return body.message ?? body.error ?? `HTTP ${String(res.status)}`;
}

export function AccessLogsPanel(): ReactElement {
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
      setToast('已保存（写入 config.yaml，档位热应用）');
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
      setToast(`已清空检索日志：${String(result.removed)} 行（含证据 ${String(result.evidence_removed)} 行）`);
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
      setToast(`已清空插件运行日志：磁盘 ${String(result.disk_removed)} 个文件、内存 ${String(result.memory_removed)} 条`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div data-testid="access-logs-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section id="query-log" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600 }}>查询日志（检索日志）</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          正式功能：记录每次检索的入参、路线、候选与打包结果。保留期由这里决定，到期由 daemon 每日分批清理。
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>保留天数（0 = 永久）</span>
          <input
            style={inputStyle}
            data-testid="keep-days"
            value={draft?.keepDays ?? ''}
            onChange={(event) => setDraft(draft === null ? draft : { ...draft, keepDays: event.target.value })}
          />
        </div>
        <div style={rowStyle}>
          <button type="button" style={buttonStyle} onClick={() => { void purgeQuery(); }} data-testid="purge-query">
            {confirmQuery ? '再点一次确认清空' : '清空检索日志'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>不可逆；会先删证据子行，再删主表，并落 audit。</span>
        </div>
      </section>

      <section id="plugin-trace" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600 }}>插件运行日志</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          排查用：默认关闭，正式发版不保留该功能。summary 只记计数与哈希，full 才带查询/注入/回复正文（落盘前脱敏）。
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>档位</span>
          <select
            style={inputStyle}
            data-testid="trace-level"
            value={draft?.level ?? 'off'}
            onChange={(event) =>
              setDraft(draft === null ? draft : { ...draft, level: event.target.value as TraceLevel })
            }
          >
            <option value="off">off（默认）</option>
            <option value="summary">summary（计数 + 哈希）</option>
            <option value="full">full（含正文）</option>
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>单文件上限（字节）</span>
          <input
            style={inputStyle}
            data-testid="trace-max-bytes"
            value={draft?.maxBytes ?? ''}
            onChange={(event) => setDraft(draft === null ? draft : { ...draft, maxBytes: event.target.value })}
          />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>保留天数</span>
          <input
            style={inputStyle}
            data-testid="trace-keep-days"
            value={draft?.traceKeepDays ?? ''}
            onChange={(event) => setDraft(draft === null ? draft : { ...draft, traceKeepDays: event.target.value })}
          />
        </div>
        <div style={rowStyle}>
          <button type="button" style={buttonStyle} onClick={() => { void purgeTrace(); }} data-testid="purge-trace">
            {confirmTrace ? '再点一次确认清空' : '清空插件运行日志'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>同时清内存 ring 与磁盘文件，并落 audit。</span>
        </div>
      </section>

      <div style={rowStyle}>
        <button
          type="button"
          style={{ ...buttonStyle, opacity: dirty ? 1 : 0.5 }}
          disabled={!dirty || saving}
          onClick={() => { void save(); }}
          data-testid="access-logs-save"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {toast === null ? null : (
          <span style={{ fontSize: 12, color: 'var(--color-success, #3fb950)' }} data-testid="access-logs-toast">
            {toast}
          </span>
        )}
        {error === null ? null : (
          <span style={{ fontSize: 12, color: 'var(--color-danger, #f85149)' }} data-testid="access-logs-error">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
