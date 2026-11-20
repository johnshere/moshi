/**
 * 统一日志页（P4；开发方案 §7「日志页三段」）。
 *
 * 三段：①顶部状态条（只读读数 + 时间窗 + 「日志与保留」弹框入口）②按接入点统计列
 * ③统一日志流（两源合并、可搜索、瀑布流加载）。
 *
 * **本页没有任何写入控件**：配置唯一写入口是「日志与保留」弹框（`LogConfigModal` 里挂
 * `AccessLogsPanel`），右上角按钮只是打开它的快捷入口（用户 m02743；用户 m00882 把配置
 * 从设置挪进接入，用户 m01083 又把它从独立页改成弹框）。
 *
 * 视觉（w10）：页头读数 + 筛选货架 + 读数带；统计是四格小面板（`.tile`），日志流是
 * 等宽读数行（`.data-row`），状态靠 5px 方灯 + 色调类，不再用彩色文字堆卡片。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
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

/** 状态 → 色调类（只上色，不上底；底留给行 hover） */
function statusTone(status: string | null): string {
  if (status === 'ok' || status === 'ready') return 'tone-ok';
  if (status === 'degraded') return 'tone-warn';
  if (status === 'error') return 'tone-err';
  return 'tone-mute';
}

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
    <div className="spark" data-testid="logs-summary-spark" aria-hidden="true">
      {buckets.map((value, index) => (
        <span
          key={index}
          data-zero={value === 0 ? 'true' : 'false'}
          style={{ height: `${String(Math.max(value === 0 ? 0 : 2, Math.round((value / max) * 18)))}px` }}
        />
      ))}
    </div>
  );
}

function hitRate(group: LogsSummaryGroup): string {
  if (group.count === 0) return '—';
  return `${((group.ok / group.count) * 100).toFixed(0)}%`;
}

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
    <div className="ledger ledger-fill" data-testid="logs-page">
      {/* ① 顶部：只读读数 + 时间窗 + 「日志与保留」弹框入口（唯一写入口不在本页） */}
      <header className="ledger-head">
        <div className="ledger-title">{t('logs.title')}</div>
        <div className="head-meters">
          <span className="readout" data-testid="logs-total">
            {t('logs.total', { n: totals?.count ?? 0 })}
          </span>
          <span className="readout" data-testid="logs-ok">
            {t('logs.ok', { n: totals?.ok ?? 0 })}
          </span>
          <span className="readout" data-testid="logs-degraded">
            {t('logs.degraded', { n: totals?.degraded ?? 0 })}
          </span>
          <span className="readout" data-testid="logs-updated">
            {t('logs.updatedAt', {
              time:
                updatedAt === null
                  ? '—'
                  : new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false }),
            })}
          </span>
        </div>
        <div className="ledger-tools">
          <div className="seg" role="group">
            {(['1h', '24h', '7d'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className="seg-item"
                data-testid={`logs-window-${key}`}
                data-active={windowKey === key ? 'true' : 'false'}
                onClick={() => setWindowKey(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <button type="button" className="btn" data-testid="logs-settings-link" onClick={() => setConfigOpen(true)}>
            {t('logs.config')}
          </button>
        </div>
      </header>

      {/* 筛选：只筛不写，货架上一条线排开 */}
      <div className="ledger-shelf">
        <div className="btn-row">
          <select
            value={source}
            className="scope-select"
            data-testid="logs-filter-source"
            onChange={(event) => setSource(event.target.value as LogSourceFilter)}
          >
            <option value="all">{t('logs.filter.allSources')}</option>
            <option value="query">{t('logs.filter.source.query')}</option>
            <option value="trace">{t('logs.filter.source.trace')}</option>
          </select>
          <select
            value={status}
            className="scope-select"
            data-testid="logs-filter-status"
            onChange={(event) => setStatus(event.target.value)}
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
            className="input-line"
            data-testid="logs-filter-q"
            placeholder={t('logs.searchPlaceholder')}
            onChange={(event) => setQInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setQ(qInput.trim());
            }}
          />
          <button type="button" className="btn" onClick={() => setQ(qInput.trim())}>
            {t('logs.search')}
          </button>
          <button type="button" className="btn" data-testid="logs-refresh" onClick={() => loadFirstPage()}>
            {t('logs.refresh')}
          </button>
        </div>
      </div>

      <div className="station-body">
        {summaryError !== null ? (
          <div className="notice" data-tone="error">
            <span className="notice-text">{t('logs.summaryError', { error: summaryError })}</span>
          </div>
        ) : null}
        {listError !== null ? (
          <div className="notice" data-tone="error">
            <span className="notice-text">{t('logs.listError', { error: listError })}</span>
          </div>
        ) : null}

        {/* ② 按接入点统计：四格小面板，够几列排几列 */}
        <div className="tile-grid" data-testid="logs-summary">
          {groups.length === 0 ? (
            <div className="tile">
              <span className="tile-note">{t('logs.summaryEmpty')}</span>
            </div>
          ) : (
            groups.map((group) => (
              <div key={`${group.caller_id}:${group.caller_kind}`} className="tile" data-testid="logs-summary-card">
                <div className="tile-title">
                  <span>{kindLabel(group.caller_kind)}</span>
                  <span className="tone-mute">·</span>
                  <span>{group.caller_id}</span>
                </div>
                <div className="tile-num">
                  {group.count}
                  <span className="tile-unit">{t('logs.unit')}</span>
                </div>
                <div className="tile-line">
                  <span>{t('logs.hit', { rate: hitRate(group) })}</span>
                  <span className="tone-faint"> · </span>
                  <span>P95 {fmtMs(group.p95_ms)}</span>
                  <span className="tone-faint"> · </span>
                  <span>{t('logs.in', { bytes: fmtBytes(group.in_bytes) })}</span>
                  <span className="tone-faint"> · </span>
                  <span>{t('logs.out', { bytes: fmtBytes(group.out_bytes) })}</span>
                </div>
                <div className="tile-note">
                  {t('logs.last', { time: group.last_ts === null ? '—' : fmtTime(group.last_ts) })}
                </div>
                {sparkline(group.buckets)}
              </div>
            ))
          )}
        </div>

        {/* ③ 统一日志流 */}
        <div className="data-scroll">
          <div className="data-table" data-testid="logs-list">
            <div className="data-head cols-log">
              <span>{t('logs.row.source')}</span>
              <span>{t('logs.row.kind')}</span>
              <span>{t('logs.row.caller')}</span>
              <span data-num="true">{t('logs.row.in')}</span>
              <span data-num="true">{t('logs.row.out')}</span>
              <span>{t('logs.row.status')}</span>
              <span>{t('logs.row.when')}</span>
            </div>
            {items.length === 0 && !loading ? <div className="data-empty">{t('logs.listEmpty')}</div> : null}
            {items.map((item) => {
              const isOpen = expanded === item.id;
              return (
                <div key={item.id}>
                  <div
                    className="data-row cols-log"
                    role="button"
                    tabIndex={0}
                    data-click="true"
                    data-open={isOpen ? 'true' : 'false'}
                    data-testid="logs-row"
                    onClick={() => setExpanded(isOpen ? null : item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') setExpanded(isOpen ? null : item.id);
                    }}
                  >
                    <span className="readout">
                      <span className="cell-label">{t('logs.row.source')}</span>
                      {item.source === 'trace' ? t('logs.row.source.trace') : t('logs.row.source.query')}
                    </span>
                    <span className="tone-mute">
                      <span className="cell-label">{t('logs.row.kind')}</span>
                      {kindLabel(item.caller_kind)}
                    </span>
                    <span className="data-line">
                      <span className="cell-label">{t('logs.row.caller')}</span>
                      {item.caller_id}
                    </span>
                    <span className="data-num tone-mute">
                      <span className="cell-label">{t('logs.row.in')}</span>
                      {fmtBytes(item.in_bytes)}
                    </span>
                    <span className="data-num tone-mute">
                      <span className="cell-label">{t('logs.row.out')}</span>
                      {fmtBytes(item.out_bytes)}
                    </span>
                    <span className={`readout-status ${statusTone(item.status)}`}>
                      <span className="cell-label">{t('logs.row.status')}</span>
                      <i className="lamp" aria-hidden="true" />
                      {item.status === null || item.status === undefined
                        ? enumLabel('logStatus', 'unknown')
                        : enumLabel('logStatus', item.status)}
                    </span>
                    <span className="readout">
                      <span className="cell-label">{t('logs.row.when')}</span>
                      {fmtTime(item.ts)} · {fmtMs(item.latency_ms)}
                      {item.corr_id === null ? null : ` · corr ${item.corr_id.slice(0, 8)}`}
                    </span>
                  </div>
                  {isOpen ? (
                    <div className="data-detail" data-testid="logs-row-detail">
                      <span>id {item.id}</span>
                      <span>
                        {t('logs.row.meta', {
                          plugin: item.plugin_id ?? '—',
                          evidence: item.evidence ?? '—',
                          corr: item.corr_id ?? '—',
                        })}
                      </span>
                      {item.text === null ? (
                        <span className="tone-mute">{t('logs.row.noBody')}</span>
                      ) : (
                        <pre>{item.text}</pre>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {cursor !== null ? (
              <div className="data-foot">
                <button
                  type="button"
                  className="btn"
                  data-testid="logs-load-more"
                  onClick={loadMore}
                  disabled={loading}
                >
                  {loading ? t('table.footer.loading') : t('logs.more')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* 「日志与保留」弹框（用户 m01083：不再有独立菜单页） */}
      <LogConfigModal open={configOpen} onClose={() => setConfigOpen(false)} initialSection="query-log" />
    </div>
  );
}
