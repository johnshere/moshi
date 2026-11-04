/**
 * 历史查询面板（P2-26，D-118）。
 *
 * 解决的是「实时 TTL 一过就没了」的缺口：`/api/trace` 只是 daemon 内存里的最近 64 次
 * （P2-24 契约，不落库、不加 SSE/WebSocket）。外部再查一次就会把图上的证据链顶掉，
 * 于是这里给一份可选回放的列表：点一条 → `GET /api/trace/:query_id` → 图按同一条
 * 渲染通道回放（不另开传输通道）。
 *
 * 数据源：
 * - 列表：`GET /api/trace?limit=20`（新→旧）；
 * - 回放：`GET /api/trace/:query_id`，404 是正常降级（ring buffer 淘汰 / daemon 重启）；
 * - 实时：`useTrace` 的 3s 轮询（`refreshLatestTrace`）。回放期间轮询静默，
 *   见 `state/trace.ts` 的 `shouldPollLatest`。
 *
 * 渲染规则集中在 `./pure.ts`（node 测试环境可单测）；本组件只做取数与 JSX。
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fetchTraceList, type TraceListEntry } from '../api.js';
import { backToLiveTrace, replayTrace, useTrace } from '../state/trace.js';
import { HISTORY_LIMIT, historyEmptyText, historyRows, selectedIdOf } from './pure.js';

const panelStyle: CSSProperties = {
  position: 'absolute',
  left: 14,
  bottom: 34,
  width: 320,
  maxHeight: '42vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(5, 7, 13, 0.92)',
  border: '1px solid #1f2937',
  borderRadius: 6,
  fontSize: 11,
  color: '#94a3b8',
  pointerEvents: 'auto',
  overflow: 'hidden',
};

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 8px',
  borderBottom: '1px solid #1f2937',
  background: 'rgba(17, 24, 39, 0.85)',
};

const smallButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  background: '#111827',
  color: '#f59e0b',
  border: '1px solid #78350f',
  borderRadius: 4,
  padding: '1px 8px',
  cursor: 'pointer',
  font: 'inherit',
};

const MISS_STYLE: CSSProperties = { padding: '6px 8px', color: '#f59e0b' };

export function HistoryPanel(): JSX.Element {
  const [entries, setEntries] = useState<TraceListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mode = useTrace((s) => s.mode);
  const liveId = useTrace((s) => (s.mode === 'live' ? (s.trace?.query_id ?? null) : null));
  const selected = useTrace(selectedIdOf);
  const missMessage = useTrace((s) => (s.mode === 'replay' && s.trace === null ? s.error : null));

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await fetchTraceList(HISTORY_LIMIT);
      setEntries(payload.queries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 实时 trace 换了（外部查询 / 刷新）就补一次列表，其它时候靠 10s 轮询。
  useEffect(() => {
    if (liveId === null) return;
    void load();
  }, [liveId, load]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const rows = historyRows(entries);

  return (
    <section style={panelStyle} aria-label="历史查询">
      <div style={headStyle}>
        <span style={{ color: '#cbd5e1' }}>历史查询</span>
        <span style={{ color: '#475569' }}>最近 {HISTORY_LIMIT} 次</span>
        {mode === 'replay' && (
          <button type="button" onClick={() => void backToLiveTrace()} style={smallButtonStyle}>
            回到实时
          </button>
        )}
      </div>
      {mode === 'replay' && (
        <div style={MISS_STYLE}>
          回放中{selected === null ? '' : ` · ${selected.slice(-8)}`}
          {missMessage === null ? '' : ` · ${missMessage}`}
        </div>
      )}
      <div style={{ overflowY: 'auto', padding: '3px 6px 6px' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '3px 2px', color: '#475569' }}>{historyEmptyText(rows, error)}</div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {rows.map((row) => {
              const active = row.id === selected;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => void replayTrace(row.id)}
                    aria-pressed={active}
                    title={row.id}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      background: active ? '#1e293b' : 'transparent',
                      border: 'none',
                      borderRadius: 4,
                      padding: '3px 4px',
                      cursor: 'pointer',
                      color: active ? '#f8fafc' : '#94a3b8',
                      font: 'inherit',
                    }}
                  >
                    <span style={{ color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{row.clock}</span>
                    <span style={{ color: '#7dd3fc' }}>{row.shortId}</span>
                    <span style={{ marginLeft: 'auto', color: '#475569' }}>{row.meta}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div style={{ padding: '0 8px 5px', color: '#334155' }}>
        {mode === 'live' ? '实时：跟随最近一次查询 · 点一条回放' : '回放：显示选中的历史 trace'}
      </div>
    </section>
  );
}
