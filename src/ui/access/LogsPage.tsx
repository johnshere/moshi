/**
 * 统一日志页（P4；开发方案 §7「日志页三段」）。
 *
 * 三段：①顶部状态条（只读 chip + 时间窗 + 「日志与保留」弹框入口）②按接入点统计卡片
 * ③统一日志流（两源合并、可搜索、瀑布流加载）。
 *
 * **本页没有任何写入控件**：配置唯一写入口是「日志与保留」弹框（`LogConfigModal` 里挂
 * `AccessLogsPanel`），右上角按钮只是打开它的快捷入口（用户 m02743；用户 m00882 把配置
 * 从设置挪进接入，用户 m01083 又把它从独立页改成弹框）。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { LogConfigModal } from './LogConfigModal.js';
import { useT } from '../i18n/index.js';
import { enumLabel } from '../i18n/enums.js';
import {
  fetchLogs,
  fetchLogsSummary,
  type LogItem,
  type LogSourceFilter,
  type LogsSummary,
  type LogsSummaryGroup,
  type SummaryWindow,
} from './api.js';

const REFRESH_MS = 10_000;
const PAGE_SIZE = 20;

const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--color-success, #3fb950)',
  ready: 'var(--color-success, #3fb950)',
  degraded: 'var(--color-warning, #d29922)',
  empty: 'var(--color-text-muted)',
  skipped: 'var(--color-text-muted)',
  error: 'var(--color-danger, #f85149)',
};

function fmtBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${String(value)}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function fmtMs(value: number | null): string {
  return value === null ? '—' : `${String(Math.round(value))}ms`;
}

function kindLabel(kind: string): string {
  return enumLabel('logKind', kind);
}

/** 卡片右下角的小折线：12 段计数按最大值归一，纯 CSS 柱状（不引图表库） */
function sparkline(buckets: readonly number[]): ReactElement {
  const max = Math.max(1, ...buckets);
  return (
    <div
      data-testid="logs-summary-spark"
      aria-hidden="true"
      style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 18, marginTop: 4 }}
    >
      {buckets.map((value, index) => (
        <span
          key={index}
          style={{
            flex: '1 1 auto',
            height: `${String(Math.max(value === 0 ? 0 : 2, Math.round((value / max) * 18)))}px`,
            background: value === 0 ? 'var(--color-border, #2a333d)' : 'var(--color-accent, #58a6ff)',
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

function hitRate(group: LogsSummaryGroup): string {
  if (group.count === 0) return '—';
  return `${((group.ok / group.count) * 100).toFixed(0)}%`;
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--color-border, #2a333d)',
  borderRadius: 8,
  background: 'var(--color-bg-raised)',
  padding: '10px 12px',
  minWidth: 200,
};

const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 9px',
  borderRadius: 999,
  border: '1px solid var(--color-border, #2a333d)',
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const tabStyle = (active: boolean): CSSProperties => ({
  padding: '3px 10px',
  borderRadius: 8,
  border: '1px solid ' + (active ? 'var(--color-border-strong, #3a4a5a)' : 'transparent'),
  background: active ? 'var(--color-bg-raised)' : 'transparent',
  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  fontSize: 12,
  cursor: 'pointer',
});

export function LogsPage(): ReactElement {
  const t = useT();
  const [windowKey, setWindowKey] = useState<SummaryWindow>('24h');
  const [summary, setSummary] = useState<LogsSummary | null>(null);
  const [items, setItems] = useState<LogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [source, setSource] = useState<LogSourceFilter>('all');
  const [status, setStatus] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const loadSummary = useCallback(
    (signal?: AbortSignal) => {
      fetchLogsSummary(windowKey, signal)
        .then((value) => {
          setSummary(value);
          setSummaryError(null);
        })
        .catch((err: unknown) => setSummaryError(err instanceof Error ? err.message : String(err)));
    },
    [windowKey],
  );

  const loadFirstPage = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      fetchLogs({ limit: PAGE_SIZE, source, status: status === '' ? null : status, q: q === '' ? null : q }, signal)
        .then((page) => {
          setItems(page.items);
          setCursor(page.next_cursor);
          setListError(null);
        })
        .catch((err: unknown) => setListError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    },
    [source, status, q],
  );

  const loadMore = useCallback(() => {
    if (cursor === null || loading) return;
    setLoading(true);
    fetchLogs({ limit: PAGE_SIZE, cursor, source, status: status === '' ? null : status, q: q === '' ? null : q })
      .then((page) => {
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.next_cursor);
      })
      .catch((err: unknown) => setListError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [cursor, loading, source, status, q]);

  useEffect(() => {
    const controller = new AbortController();
    loadSummary(controller.signal);
    loadFirstPage(controller.signal);
    const timer = window.setInterval(() => {
      loadSummary();
      loadFirstPage();
    }, REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadSummary, loadFirstPage]);

  const totals = summary?.totals;
  const updatedAt = summary?.generated_at ?? null;

  const groups = useMemo(() => summary?.groups ?? [], [summary]);

  return (
    <div
      data-testid="logs-page"
      style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--color-bg-base)' }}
    >
      {/* ① 顶部：只读状态条 + 时间窗 + 「日志与保留」弹框入口（唯一写入口不在本页） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px 0', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--color-text-primary)', fontSize: 15, fontWeight: 600 }}>{t('logs.title')}</span>
        <span style={chipStyle} data-testid="logs-total">
          {t('logs.total', { n: totals?.count ?? 0 })}
        </span>
        <span style={chipStyle} data-testid="logs-ok">
          {t('logs.ok', { n: totals?.ok ?? 0 })}
        </span>
        <span style={chipStyle} data-testid="logs-degraded">
          {t('logs.degraded', { n: totals?.degraded ?? 0 })}
        </span>
        <span style={chipStyle} data-testid="logs-updated">
          {t('logs.updatedAt', { time: updatedAt === null ? '—' : new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) })}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {(['1h', '24h', '7d'] as const).map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`logs-window-${key}`}
              data-active={windowKey === key ? 'true' : 'false'}
              style={tabStyle(windowKey === key)}
              onClick={() => setWindowKey(key)}
            >
              {key}
            </button>
          ))}
          <button type="button" style={tabStyle(false)} data-testid="logs-settings-link" onClick={() => setConfigOpen(true)}>
            {t('logs.config')}
          </button>
        </div>
      </div>
      {summaryError !== null ? (
        <div style={{ color: 'var(--color-danger, #f85149)', fontSize: 12, padding: '6px 18px 0' }}>
          {t('logs.summaryError', { error: summaryError })}
        </div>
      ) : null}

      {/* ② 按接入点统计 */}
      <div
        data-testid="logs-summary"
        style={{ display: 'flex', gap: 10, padding: '10px 18px 0', overflowX: 'auto', flexWrap: 'wrap' }}
      >
        {groups.length === 0 ? (
          <div style={{ ...cardStyle, color: 'var(--color-text-muted)', fontSize: 12 }}>
            {t('logs.summaryEmpty')}
          </div>
        ) : (
          groups.map((group) => (
            <div key={`${group.caller_id}:${group.caller_kind}`} style={cardStyle} data-testid="logs-summary-card">
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {kindLabel(group.caller_kind)} · {group.caller_id}
              </div>
              <div style={{ fontSize: 20, color: 'var(--color-text-primary)', margin: '2px 0' }}>
                {group.count}
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 6 }}>{t('logs.unit')}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>{t('logs.hit', { rate: hitRate(group) })}</span>
                <span>P95 {fmtMs(group.p95_ms)}</span>
                <span>{t('logs.in', { bytes: fmtBytes(group.in_bytes) })}</span>
                <span>{t('logs.out', { bytes: fmtBytes(group.out_bytes) })}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                {t('logs.last', { time: group.last_ts === null ? '—' : fmtTime(group.last_ts) })}
              </div>
              {sparkline(group.buckets)}
            </div>
          ))
        )}
      </div>

      {/* ③ 统一日志流 */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 18px 6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={source}
          data-testid="logs-filter-source"
          onChange={(event) => setSource(event.target.value as LogSourceFilter)}
          style={{ fontSize: 12, padding: '3px 6px' }}
        >
          <option value="all">{t('logs.filter.allSources')}</option>
          <option value="query">{t('logs.filter.source.query')}</option>
          <option value="trace">{t('logs.filter.source.trace')}</option>
        </select>
        <select
          value={status}
          data-testid="logs-filter-status"
          onChange={(event) => setStatus(event.target.value)}
          style={{ fontSize: 12, padding: '3px 6px' }}
        >
          <option value="">{t('logs.filter.allStatus')}</option>
          {(['ok', 'degraded', 'ready', 'empty', 'skipped'] as const).map((value) => (
            <option key={value} value={value}>
              {enumLabel('logStatus', value)}
            </option>
          ))}
        </select>
        <input
          value={qInput}
          data-testid="logs-filter-q"
          placeholder={t('logs.searchPlaceholder')}
          onChange={(event) => setQInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setQ(qInput.trim());
          }}
          style={{ fontSize: 12, padding: '3px 6px', minWidth: 200 }}
        />
        <button type="button" style={tabStyle(false)} onClick={() => setQ(qInput.trim())}>
          {t('logs.search')}
        </button>
        <button type="button" style={tabStyle(false)} data-testid="logs-refresh" onClick={() => loadFirstPage()}>
          {t('logs.refresh')}
        </button>
      </div>
      {listError !== null ? (
        <div style={{ color: 'var(--color-danger, #f85149)', fontSize: 12, padding: '0 18px' }}>
          {t('logs.listError', { error: listError })}
        </div>
      ) : null}

      <div data-testid="logs-list" style={{ padding: '0 18px 24px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.length === 0 && !loading ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{t('logs.listEmpty')}</div>
        ) : null}
        {items.map((item) => {
          const isOpen = expanded === item.id;
          return (
            <div
              key={item.id}
              data-testid="logs-row"
              style={{
                border: '1px solid var(--color-border, #2a333d)',
                borderRadius: 8,
                background: 'var(--color-bg-raised)',
                fontSize: 12,
              }}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpanded(isOpen ? null : item.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setExpanded(isOpen ? null : item.id);
                }}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '70px 96px 1fr 72px 72px 84px 1fr',
                  gap: 8,
                  padding: '6px 10px',
                  alignItems: 'center',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: item.source === 'trace' ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
                  }}
                >
                  {item.source === 'trace' ? t('logs.row.source.trace') : t('logs.row.source.query')}
                </span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{kindLabel(item.caller_kind)}</span>
                <span style={{ color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.caller_id}
                </span>
                <span style={{ color: 'var(--color-text-muted)' }}>{fmtBytes(item.in_bytes)}</span>
                <span style={{ color: 'var(--color-text-muted)' }}>{fmtBytes(item.out_bytes)}</span>
                <span style={{ color: STATUS_COLOR[item.status ?? ''] ?? 'var(--color-text-secondary)' }}>
                  {item.status === null || item.status === undefined ? enumLabel('logStatus', 'unknown') : enumLabel('logStatus', item.status)}
                </span>
                <span style={{ color: 'var(--color-text-muted)', display: 'flex', gap: 8 }}>
                  <span>{fmtTime(item.ts)}</span>
                  <span>{fmtMs(item.latency_ms)}</span>
                  {item.corr_id === null ? null : <span>corr {item.corr_id.slice(0, 8)}</span>}
                </span>
              </div>
              {isOpen ? (
                <div
                  data-testid="logs-row-detail"
                  style={{
                    borderTop: '1px solid var(--color-border, #2a333d)',
                    padding: '6px 10px',
                    color: 'var(--color-text-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <span>id {item.id}</span>
                  <span>{t('logs.row.meta', { plugin: item.plugin_id ?? '—', evidence: item.evidence ?? '—', corr: item.corr_id ?? '—' })}</span>
                  {item.text === null ? (
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {t('logs.row.noBody')}
                    </span>
                  ) : (
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{item.text}</pre>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {cursor !== null ? (
          <button type="button" style={tabStyle(false)} data-testid="logs-load-more" onClick={loadMore} disabled={loading}>
            {loading ? t('table.footer.loading') : t('logs.more')}
          </button>
        ) : null}
      </div>

      {/* 「日志与保留」弹框（用户 m01083：不再有独立菜单页） */}
      <LogConfigModal open={configOpen} onClose={() => setConfigOpen(false)} initialSection="query-log" />
    </div>
  );
}
