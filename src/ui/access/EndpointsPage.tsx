/**
 * 接入点页（P4；开发方案 §7）。
 *
 * 上排是四类接入点的运行态（数据来自同一份 `GET /api/logs/summary`），
 * 中间是「历史会话导入」（把已有会话记录扫进记忆库，后台执行 + 轮询状态），
 * 下半屏内嵌 Magpie 插件的安装/连接面板（原 `/ui/hook` 与设置里的「接入」
 * 共用 `AccessPage`，用户 m02743 把它迁到这里）。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { AccessPage } from './AccessPage.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';
import {
  fetchCollectSources,
  fetchImportStatus,
  fetchLogsSummary,
  postImport,
  type CollectSourcesState,
  type ImportStatus,
  type LogsSummaryGroup,
} from './api.js';

const ENDPOINTS: readonly { kind: string; labelKey: DictKey; descKey: DictKey }[] = [
  { kind: 'gateway', labelKey: 'endpoints.def.gateway.label', descKey: 'endpoints.def.gateway.desc' },
  { kind: 'mcp', labelKey: 'endpoints.def.mcp.label', descKey: 'endpoints.def.mcp.desc' },
  { kind: 'cli', labelKey: 'endpoints.def.cli.label', descKey: 'endpoints.def.cli.desc' },
  { kind: 'ui', labelKey: 'endpoints.def.ui.label', descKey: 'endpoints.def.ui.desc' },
];

const cardStyle: CSSProperties = {
  border: '1px solid var(--color-border, #2a333d)',
  borderRadius: 8,
  background: 'var(--color-bg-raised)',
  padding: '10px 12px',
  minWidth: 220,
  flex: '1 1 220px',
};

function fmtTime(ts: string | null): string {
  if (ts === null) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString('zh-CN', { hour12: false });
}

type ImportRange = '1d' | '3d' | '7d' | 'all';

const IMPORT_RANGES: readonly { value: ImportRange; labelKey: DictKey }[] = [
  { value: '1d', labelKey: 'endpoints.import.range.1d' },
  { value: '3d', labelKey: 'endpoints.import.range.3d' },
  { value: '7d', labelKey: 'endpoints.import.range.7d' },
  { value: 'all', labelKey: 'endpoints.import.range.all' },
];

const importButtonStyle: CSSProperties = {
  background: 'var(--color-bg-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

const importSelectStyle: CSSProperties = {
  background: 'var(--color-bg-base)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border, #2a333d)',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 12,
};

/** 范围 → `POST /api/import` 的 since：按天换算成 ISO 时刻，「全部历史」直接传 `all`。 */
function sinceFor(range: ImportRange): string {
  if (range === 'all') return 'all';
  const days = range === '1d' ? 1 : range === '3d' ? 3 : 7;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 已用时 mm:ss（从 started_at 起算；started_at 缺失或不合法时显示 —）。 */
function fmtElapsed(startedAt: string | null, now: number): string {
  if (startedAt === null) return '—';
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return '—';
  const total = Math.max(0, Math.floor((now - started) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 状态行文案：空闲 / 执行中（已用时 mm:ss）/ 完成摘要 / 失败。 */
function importStatusText(t: (key: DictKey, vars?: Readonly<Record<string, string | number>>) => string, status: ImportStatus | null, now: number): string {
  if (status === null) return t('endpoints.import.status.loading');
  if (status.running) return t('endpoints.import.status.running', { elapsed: fmtElapsed(status.started_at, now) });
  if (status.error !== null) return t('endpoints.import.status.failed', { error: status.error });
  const result = status.result;
  if (result === null) return t('endpoints.import.status.idle');
  return t('endpoints.import.status.done', {
    sessions: result.sessions,
    turns: result.turns,
    facts: result.facts,
    quarantined: result.quarantined,
    failed: result.failed,
    ms: Math.round(result.ms / 1000),
  });
}

export function EndpointsPage(): ReactElement {
  const t = useT();
  const [groups, setGroups] = useState<LogsSummaryGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 历史会话导入：范围、后端状态、POST 失败原因、提交中标记、秒级心跳（算「已用时」）
  const [range, setRange] = useState<ImportRange>('1d');
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [importActionError, setImportActionError] = useState<string | null>(null);
  const [importPollError, setImportPollError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 采集源状态（`GET /api/collect/sources`）：没有可用源时导入按钮置灰（用户 m00882） */
  const [sources, setSources] = useState<CollectSourcesState | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  const importRunning = (importStatus?.running ?? false) || starting;
  const noSource = sources !== null && !sources.available;

  useEffect(() => {
    const controller = new AbortController();
    fetchLogsSummary('24h', controller.signal)
      .then((value) => {
        setGroups(value.groups);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    fetchCollectSources(controller.signal)
      .then((value) => {
        setSources(value);
        setSourcesError(null);
      })
      .catch((err: unknown) => setSourcesError(err instanceof Error ? err.message : String(err)));
    return () => controller.abort();
  }, []);

  // 页面打开期间轮询导入状态：执行中 2s 一拍，空闲 5s 一拍；卸载时取消在途请求。
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const tick = (): void => {
      fetchImportStatus(controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          setImportStatus(value);
          setImportPollError(null);
          timer = window.setTimeout(tick, value.running ? 2000 : 5000);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setImportPollError(err instanceof Error ? err.message : String(err));
          timer = window.setTimeout(tick, 5000);
        });
    };
    tick();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // 执行中每秒刷一次「已用时」。
  useEffect(() => {
    if (!importRunning) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [importRunning]);

  const startImport = async (): Promise<void> => {
    if (importRunning) return;
    setStarting(true);
    setImportActionError(null);
    try {
      await postImport(sinceFor(range));
      // 起表后立刻刷一次状态，不必等下一拍轮询才从「空闲」翻成「执行中」。
      fetchImportStatus()
        .then(setImportStatus)
        .catch(() => undefined);
    } catch (err) {
      setImportActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const importStatusLine =
    importActionError !== null
      ? t('endpoints.import.notStarted', { error: importActionError })
      : importPollError !== null
        ? t('endpoints.import.pollError', { error: importPollError })
        : importStatusText(t, importStatus, now);
  const importStatusDanger =
    importActionError !== null ||
    importPollError !== null ||
    (importStatus !== null && importStatus.error !== null);

  const byKind = new Map<string, LogsSummaryGroup[]>();
  for (const group of groups) {
    const list = byKind.get(group.caller_kind) ?? [];
    list.push(group);
    byKind.set(group.caller_kind, list);
  }

  return (
    <div
      data-testid="endpoints-page"
      style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--color-bg-base)' }}
    >
      <div style={{ padding: '14px 18px 0', color: 'var(--color-text-primary)', fontSize: 15, fontWeight: 600 }}>
        {t('endpoints.title')}
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '4px 18px 10px' }}>
        {t('endpoints.intro')}
      </div>
      {error !== null ? (
        <div style={{ color: 'var(--color-danger, #f85149)', fontSize: 12, padding: '0 18px 8px' }}>
          {t('endpoints.summaryError', { error })}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 10, padding: '0 18px', flexWrap: 'wrap' }}>
        {ENDPOINTS.map((endpoint) => {
          const list = byKind.get(endpoint.kind) ?? [];
          const count = list.reduce((sum, item) => sum + item.count, 0);
          const ok = list.reduce((sum, item) => sum + item.ok, 0);
          const last = list.reduce<string | null>((acc, item) => {
            if (item.last_ts === null) return acc;
            return acc === null || item.last_ts > acc ? item.last_ts : acc;
          }, null);
          return (
            <div key={endpoint.kind} data-testid={`endpoint-card-${endpoint.kind}`} style={cardStyle}>
              <div style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>{t(endpoint.labelKey)}</div>
              <div style={{ fontSize: 20, color: 'var(--color-text-primary)', margin: '2px 0' }}>
                {count}
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 6 }}>{t('endpoints.unit')}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t('endpoints.card.ok', { ok, last: fmtTime(last) })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>{t(endpoint.descKey)}</div>
              {list.map((group) => (
                <div key={`${group.caller_id}:${group.caller_kind}`} style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  {t('endpoints.card.row', { id: group.caller_id, n: group.count })}
                  {group.p95_ms === null ? '—' : `${String(Math.round(group.p95_ms))}ms`}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ padding: '12px 18px 0' }}>
        <div data-testid="import-card" style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>{t('endpoints.import.title')}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
            {t('endpoints.import.desc')}
          </div>
          <div
            data-testid="import-sources"
            data-available={sources === null ? 'unknown' : String(sources.available)}
            style={{
              fontSize: 11,
              marginTop: 6,
              color: noSource ? 'var(--color-warning)' : 'var(--color-text-secondary)',
            }}
          >
            {sources === null
              ? t('endpoints.import.sources.loading')
              : sources.available
                ? t('endpoints.import.sources.available', {
                    ids: sources.sources
                      .filter((source) => source.available)
                      .map((source) => source.id)
                      .join(t('common.listSep')),
                  })
                : t('endpoints.import.sources.none')}
          </div>
          {sourcesError !== null ? (
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--color-danger, #f85149)' }}>
              {t('endpoints.import.sources.error', { error: sourcesError })}
            </div>
          ) : null}
          {sources !== null && !sources.available ? (
            <div data-testid="import-source-list" style={{ fontSize: 11, marginTop: 4 }}>
              {sources.sources.length === 0 ? (
                <div style={{ color: 'var(--color-text-muted)' }}>{t('endpoints.import.sources.unconfigured')}</div>
              ) : (
                sources.sources.map((source) => (
                  <div key={source.id} style={{ color: 'var(--color-text-secondary)' }}>
                    {source.id} · {source.adapter} ·{' '}
                    <span style={{ color: source.available ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                      {source.available ? t('endpoints.import.source.available') : t('endpoints.import.source.unavailable')}
                    </span>
                  </div>
                ))
              )}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              {t('endpoints.import.range')}
              <select
                data-testid="import-range"
                value={range}
                onChange={(e) => setRange(e.target.value as ImportRange)}
                style={{ ...importSelectStyle, marginLeft: 6 }}
              >
                {IMPORT_RANGES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {t(item.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="import-run"
              style={{ ...importButtonStyle, opacity: importRunning || noSource ? 0.5 : 1 }}
              disabled={importRunning || noSource}
              title={noSource ? t('endpoints.import.sources.none') : undefined}
              onClick={() => {
                void startImport();
              }}
            >
              {importRunning ? t('endpoints.import.running') : t('endpoints.import.run')}
            </button>
          </div>
          <div
            data-testid="import-status"
            style={{
              fontSize: 11,
              marginTop: 8,
              color: importStatusDanger ? 'var(--color-danger, #f85149)' : 'var(--color-text-secondary)',
            }}
          >
            {importStatusLine}
          </div>
        </div>
      </div>

      <div style={{ padding: '16px 18px 6px', color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600 }}>
        {t('endpoints.hook.title')}
      </div>
      <div style={{ padding: '0 18px 24px' }}>
        <AccessPage standalone={false} onboardResult={null} />
      </div>
    </div>
  );
}
