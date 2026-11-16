/**
 * 配置表单（P2-19A-06）：设置页可写配置。
 *
 * - 读取：GET `/api/config`（只含白名单安全子集，见 `src/app/config.ts` 的
 *   `EDITABLE_CONFIG_ENTRIES`；不含 token）
 * - 保存：PUT `/api/config`，body `{patch:{...}}`，只提交**改动过的键**，
 *   否则 `restart_required` 会被未改动的启动期键误置为 true
 * - 启动期键（端口 / data_dir / archive_dir）只读展示，其余可编辑
 *
 * 样式 inline、深色，与既有 DiagPanel 一致；不做视觉重构（P2-19-B 另议）。
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { t as translate, useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

interface ConfigView {
  schema: string;
  config: {
    ingest: { harvest_cron: string };
    archive: {
      export_cron: string;
      dirty_threshold_facts: number;
      dirty_threshold_confidence: number;
      min_facts: number;
      history_keep: number;
    };
    layout: { enabled: boolean; interval_ms: number };
    collect: { enabled: boolean; interval_ms: number; llm_scan: boolean };
    http: { port: number };
    storage: { data_dir: string; archive_dir: string; backup_keep: number };
  };
  meta: { config_path: string };
}

type LeafValue = string | number | boolean;
type FlatConfig = Record<string, LeafValue>;

const STARTUP_PATHS = new Set(['storage.data_dir', 'storage.archive_dir']);
const PORT_MIN = 1024;
const PORT_MAX = 49151;

const FIELD_GROUPS: readonly {
  titleKey: DictKey;
  hintKey?: DictKey;
  fields: readonly { path: string; labelKey: DictKey; kind: 'text' | 'number' | 'toggle' }[];
}[] = [
  {
    titleKey: 'settings.cfg.group.ingest',
    hintKey: 'settings.cfg.group.ingestHint',
    fields: [
      { path: 'ingest.harvest_cron', labelKey: 'settings.cfg.harvestCron', kind: 'text' },
      { path: 'collect.enabled', labelKey: 'settings.cfg.collectEnabled', kind: 'toggle' },
      { path: 'collect.interval_ms', labelKey: 'settings.cfg.collectInterval', kind: 'number' },
      { path: 'collect.llm_scan', labelKey: 'settings.cfg.collectLlmScan', kind: 'toggle' },
      { path: 'layout.enabled', labelKey: 'settings.cfg.layoutEnabled', kind: 'toggle' },
      { path: 'layout.interval_ms', labelKey: 'settings.cfg.layoutInterval', kind: 'number' },
    ],
  },
  {
    titleKey: 'settings.cfg.group.archive',
    fields: [
      { path: 'archive.export_cron', labelKey: 'settings.cfg.exportCron', kind: 'text' },
      { path: 'archive.dirty_threshold_facts', labelKey: 'settings.cfg.dirtyFacts', kind: 'number' },
      {
        path: 'archive.dirty_threshold_confidence',
        labelKey: 'settings.cfg.dirtyConfidence',
        kind: 'number',
      },
      { path: 'archive.min_facts', labelKey: 'settings.cfg.minFacts', kind: 'number' },
      { path: 'archive.history_keep', labelKey: 'settings.cfg.historyKeep', kind: 'number' },
    ],
  },
  {
    titleKey: 'settings.cfg.group.startup',
    hintKey: 'settings.cfg.group.startupHint',
    fields: [
      { path: 'http.port', labelKey: 'settings.cfg.httpPort', kind: 'number' },
      { path: 'storage.data_dir', labelKey: 'settings.cfg.dataDir', kind: 'text' },
      { path: 'storage.archive_dir', labelKey: 'settings.cfg.archiveDir', kind: 'text' },
      { path: 'storage.backup_keep', labelKey: 'settings.cfg.backupKeep', kind: 'number' },
    ],
  },
];

function flatten(cfg: ConfigView['config']): FlatConfig {
  return {
    'ingest.harvest_cron': cfg.ingest.harvest_cron,
    'archive.export_cron': cfg.archive.export_cron,
    'archive.dirty_threshold_facts': cfg.archive.dirty_threshold_facts,
    'archive.dirty_threshold_confidence': cfg.archive.dirty_threshold_confidence,
    'archive.min_facts': cfg.archive.min_facts,
    'archive.history_keep': cfg.archive.history_keep,
    'layout.enabled': cfg.layout.enabled,
    'layout.interval_ms': cfg.layout.interval_ms,
    'collect.enabled': cfg.collect.enabled,
    'collect.interval_ms': cfg.collect.interval_ms,
    'collect.llm_scan': cfg.collect.llm_scan,
    'http.port': cfg.http.port,
    'storage.data_dir': cfg.storage.data_dir,
    'storage.archive_dir': cfg.storage.archive_dir,
    'storage.backup_keep': cfg.storage.backup_keep,
  };
}

function unflatten(flat: FlatConfig): Record<string, unknown> {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [path, value] of Object.entries(flat)) {
    const [section, key] = path.split('.') as [string, string];
    patch[section] ??= {};
    patch[section][key] = value;
  }
  return patch;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'X-Moshi-Token': resolveToken(),
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    detail?: { reason?: string };
  };
  if (!res.ok) {
    const reason = body.detail?.reason;
    const message = body.message ?? body.error ?? `HTTP ${String(res.status)}`;
    throw new Error(reason === undefined ? message : translate('settings.cfg.httpError', { message, reason }));
  }
  return body as T;
}

const panelStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  color: 'var(--color-text-secondary)',
  fontSize: 13,
};

const groupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '220px 1fr',
  gap: 10,
  alignItems: 'center',
  minHeight: 26,
};
const labelStyle: CSSProperties = { color: 'var(--color-text-secondary)', fontSize: 12 };
const inputStyle: CSSProperties = {
  background: 'var(--color-bg-overlay)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 12,
  width: '100%',
  boxSizing: 'border-box',
};
const buttonStyle: CSSProperties = {
  background: 'var(--color-info-dim)',
  color: 'var(--color-text-primary)',
  border: 'none',
  borderRadius: 8,
  padding: '6px 14px',
  fontSize: 12,
  cursor: 'pointer',
  alignSelf: 'flex-start',
};

export function ConfigForm(): ReactElement {
  const t = useT();
  const [loaded, setLoaded] = useState<FlatConfig | null>(null);
  const [draft, setDraft] = useState<FlatConfig>({});
  const [baseline, setBaseline] = useState<FlatConfig>({});
  const [configPath, setConfigPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [restart, setRestart] = useState<string[]>([]);

  const applyView = (view: ConfigView): void => {
    const flat = flatten(view.config);
    setLoaded(flat);
    setDraft(flat);
    setBaseline(flat);
    setConfigPath(view.meta.config_path);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getJson<ConfigView>('/api/config', { signal: controller.signal })
      .then((view) => {
        applyView(view);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, []);

  const changed = useMemo(() => {
    const diff: FlatConfig = {};
    for (const [path, value] of Object.entries(draft)) {
      if (baseline[path] !== value) diff[path] = value;
    }
    return diff;
  }, [draft, baseline]);

  const dirty = Object.keys(changed).length > 0;

  const setField = (path: string, value: LeafValue): void => {
    setDraft((prev) => ({ ...prev, [path]: value }));
    setToast(null);
  };

  const save = async (): Promise<void> => {
    if (!dirty || saving) return;
    const port = draft['http.port'];
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < PORT_MIN ||
      port > PORT_MAX
    ) {
      setError(t('settings.cfg.portRange', { min: PORT_MIN, max: PORT_MAX }));
      return;
    }
    setSaving(true);
    setError(null);
    setToast(null);
    try {
      const res = await getJson<{
        ok: boolean;
        applied: string[];
        restart_required: boolean;
      }>('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ patch: unflatten(changed) }),
      });
      setBaseline(draft);
      setRestart(res.restart_required ? res.applied : []);
      setToast(
        t('settings.cfg.saved', {
          count: res.applied.length,
          restart: res.restart_required ? t('settings.cfg.savedRestart') : '',
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="config-form" style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ color: 'var(--color-text-primary)', fontSize: 14, fontWeight: 600 }}>{t('settings.cfg.title')}</div>
        <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{configPath}</div>
      </div>

      {loading && <div style={{ color: 'var(--color-text-secondary)' }}>{t('settings.cfg.loading')}</div>}
      {error !== null && (
        <div
          data-testid="config-error"
          style={{ color: 'var(--color-danger-soft)', background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-dim)', borderRadius: 8, padding: '6px 8px' }}
        >
          {error}
        </div>
      )}
      {toast !== null && (
        <div
          data-testid="config-toast"
          style={{ color: 'var(--color-success-soft)', background: 'var(--color-success-bg)', border: '1px solid var(--color-success-dim)', borderRadius: 8, padding: '6px 8px' }}
        >
          {toast}
        </div>
      )}
      {restart.length > 0 && (
        <div
          data-testid="config-restart-hint"
          style={{ color: 'var(--color-warning-soft)', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-dim)', borderRadius: 8, padding: '6px 8px' }}
        >
          {t('settings.cfg.restartNeeded', { list: restart.join(', ') })}
        </div>
      )}

      {loaded !== null && FIELD_GROUPS.map((group) => (
        <div key={group.titleKey} style={groupStyle}>
          <div style={{ color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600 }}>{t(group.titleKey)}</div>
          {group.hintKey !== undefined && <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{t(group.hintKey)}</div>}
          {group.fields.map((field) => {
            const value = draft[field.path];
            const readOnly = STARTUP_PATHS.has(field.path);
            return (
              <label key={field.path} style={rowStyle} data-testid={`config-row-${field.path}`}>
                <span style={labelStyle}>{t(field.labelKey)}</span>
                {field.kind === 'toggle' ? (
                  <input
                    type="checkbox"
                    data-testid={`config-field-${field.path}`}
                    checked={value === true}
                    disabled={readOnly || saving}
                    onChange={(e) => { setField(field.path, e.target.checked); }}
                  />
                ) : (
                  <input
                    type={field.kind}
                    data-testid={`config-field-${field.path}`}
                    style={{ ...inputStyle, ...(readOnly ? { color: 'var(--color-text-muted)', cursor: 'not-allowed' } : {}) }}
                    value={String(value ?? '')}
                    readOnly={readOnly}
                    min={field.path === 'http.port' ? PORT_MIN : undefined}
                    max={field.path === 'http.port' ? PORT_MAX : undefined}
                    step={field.path.endsWith('confidence') ? 0.05 : 1}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setField(field.path, field.kind === 'number' ? (raw === '' ? 0 : Number(raw)) : raw);
                    }}
                  />
                )}
              </label>
            );
          })}
        </div>
      ))}

      {changed['http.port'] !== undefined && (
        <div
          data-testid="config-port-hint"
          style={{ color: 'var(--color-warning-soft)', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-dim)', borderRadius: 8, padding: '6px 8px', lineHeight: 1.6 }}
        >
          {t('settings.cfg.portNoticePrefix')}
          <code>http://127.0.0.1:{String(draft['http.port'])}/mcp</code>
          {t('settings.cfg.portNoticeSuffix')}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          data-testid="config-save"
          style={{ ...buttonStyle, opacity: !dirty || saving ? 0.5 : 1 }}
          disabled={!dirty || saving}
          onClick={() => { void save(); }}
        >
          {saving
            ? t('settings.cfg.saving')
            : dirty
              ? t('settings.cfg.saveCount', { count: Object.keys(changed).length })
              : t('settings.cfg.noChanges')}
        </button>
        {dirty && (
          <button
            type="button"
            data-testid="config-reset"
            style={{ ...buttonStyle, background: 'var(--color-bg-hover)' }}
            onClick={() => { setDraft(baseline); setToast(null); }}
          >
            {t('settings.cfg.reset')}
          </button>
        )}
      </div>
    </section>
  );
}
