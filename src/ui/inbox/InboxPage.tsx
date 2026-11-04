/**
 * `/ui/inbox` 待办页（P2-07 / P2-13，详设 §10.1、§10.6、概设 §8.1、§8.3.4）。
 *
 * 三个队列收在一页（QueueTabs + QueueList + BatchPanel）：
 * - 消解确认：纯信息展示（单条确认/合并属 P2-19-A，本页不给批量按钮）；
 * - 低置信 / 淘汰候选：可复选，且**跨 tab 累加**（选中集是 fact id 的 Set，切 tab 不清）；
 * - 选中 > 0 时底部 `BatchPanel`：先「预览影响」再「确认」。
 *   动作按选中集判定：**全部来自淘汰候选 → 剪枝（软删 pruned）**，否则失效（清 valid_to）。
 *   这样跨 tab 夹选时永远退化成更保守的失效，绝不会把低置信事实误剪枝。
 *
 * 状态全在本组件：批量操作是"跨 tab 的一件事"，放进子组件会让切 tab 丢掉预览结果。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  InboxApiError,
  fetchLowConfQueue,
  fetchPruneQueue,
  fetchResolveQueue,
  previewBatch,
  submitBatch,
  undoBatch,
  type BatchAction,
  type LowConfRow,
  type PreviewResult,
  type PruneRow,
  type PruneThresholds,
  type ResolveRow,
} from './api.js';
import { BatchPanel } from './BatchPanel.js';

type Tab = 'resolve' | 'lowconf' | 'prune';

const TABS: readonly { key: Tab; label: string; hint: string }[] = [
  { key: 'resolve', label: '消解确认', hint: 'alias 相似度 0.60–0.92 · 只读展示' },
  { key: 'lowconf', label: '低置信', hint: 'confidence < 0.45 · 可勾选失效' },
  { key: 'prune', label: '淘汰候选', hint: 'strength < 0.15 且 60 天未访问 · 可勾选剪枝' },
];

/** 每页取多少条：与服务端默认 limit 一致 */
const QUEUE_LIMIT = 50;
/** 倒计时刷新间隔；撤销窗口只有 30 秒，250ms 足够跟手又不浪费 */
const TICK_MS = 250;

interface ActiveOp {
  opId: string;
  deadlineMs: number;
  /** 这笔 op 的动作：撤销条文案与"当前选中集动作"无关，必须记在 op 上 */
  action: BatchAction;
}

const pageStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  padding: '14px 18px 120px',
  boxSizing: 'border-box',
} as const;

const tabStyle = (active: boolean): CSSProperties => ({
  background: active ? '#1e293b' : '#0b1220',
  color: active ? '#f8fafc' : '#94a3b8',
  border: `1px solid ${active ? '#334155' : '#1f2937'}`,
  borderRadius: 4,
  padding: '4px 12px',
  cursor: active ? 'default' : 'pointer',
  font: 'inherit',
});

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
  padding: '7px 4px',
  borderBottom: '1px solid #111827',
};

const muted: CSSProperties = { color: '#64748b' };
const warn: CSSProperties = { color: '#f59e0b' };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function FactCheckbox(props: {
  id: string;
  checked: boolean;
  onToggle: (id: string) => void;
}): JSX.Element {
  return (
    <input
      type="checkbox"
      checked={props.checked}
      onChange={() => props.onToggle(props.id)}
      aria-label={`选择 ${props.id}`}
      style={{ marginTop: 3, accentColor: '#3b82f6' }}
    />
  );
}

export function InboxPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('resolve');
  const [resolveRows, setResolveRows] = useState<ResolveRow[]>([]);
  const [lowConfRows, setLowConfRows] = useState<LowConfRow[]>([]);
  const [pruneRows, setPruneRows] = useState<PruneRow[]>([]);
  const [pruneThresholds, setPruneThresholds] = useState<PruneThresholds | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [op, setOp] = useState<ActiveOp | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadAll = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [resolve, lowconf, prune] = await Promise.all([
        fetchResolveQueue(QUEUE_LIMIT),
        fetchLowConfQueue(QUEUE_LIMIT),
        fetchPruneQueue(QUEUE_LIMIT),
      ]);
      setResolveRows(resolve);
      setLowConfRows(lowconf);
      setPruneRows(prune.items);
      setPruneThresholds(prune.thresholds);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 撤销窗口倒计时：只有窗口开着时才挂定时器（沉默时不空转）
  useEffect(() => {
    if (op === null) return;
    setNowTs(Date.now());
    const timer = window.setInterval(() => setNowTs(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [op]);

  // 过期：撤销窗口走完 → 提示 + 刷新（服务端同样会 410，这里只是不让 UI 挂着假按钮）
  useEffect(() => {
    if (op === null || nowTs < op.deadlineMs) return;
    setOp(null);
    setNotice('撤销已过期，已刷新队列');
    void loadAll();
  }, [op, nowTs, loadAll]);

  const toggle = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // 选中集变了，之前算的影响面就作废，必须重新预览（防止"预览 3 条、执行 5 条"）
    setPreview(null);
  }, []);

  // 选中集对应的批量动作：全部来自淘汰候选 → prune；只要混入别的来源就退化成 invalidate
  const action: BatchAction = useMemo(() => {
    if (selected.size === 0) return 'invalidate';
    const pruneIds = new Set(pruneRows.map((row) => row.id));
    for (const id of selected) if (!pruneIds.has(id)) return 'invalidate';
    return 'prune';
  }, [selected, pruneRows]);

  const onPreview = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewBatch(action, [...selected]));
    } catch (e) {
      setError(`预览失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }, [action, selected]);

  const onConfirm = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await submitBatch(action, [...selected]);
      setOp({ opId: result.op_id, deadlineMs: Date.parse(result.undo_deadline), action });
      setPreview(null);
      setSelected(new Set());
      setNotice(
        action === 'prune'
          ? `已剪枝 ${result.facts} 条事实（软删，可撤销）`
          : `已失效 ${result.facts} 条事实（连带失效 ${result.invalidated_by_cascade} 条）`,
      );
      await loadAll();
    } catch (e) {
      setError(`执行失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }, [action, selected, loadAll]);

  const onUndo = useCallback(async (): Promise<void> => {
    if (op === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await undoBatch(op.opId);
      setOp(null);
      setNotice(`已撤销，恢复 ${result.restored} 条事实`);
      await loadAll();
    } catch (e) {
      if (e instanceof InboxApiError && e.status === 410) {
        setOp(null);
        setNotice('撤销已过期，已刷新队列');
        await loadAll();
      } else {
        setError(`撤销失败：${errorText(e)}`);
      }
    } finally {
      setBusy(false);
    }
  }, [op, loadAll]);

  const rows: JSX.Element[] =
    tab === 'resolve'
      ? resolveRows.map((row) => (
          <div key={`${row.alias}|${row.entity_id}`} style={rowStyle}>
            <span style={{ ...muted, width: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {row.alias}
            </span>
            <span style={{ color: '#94a3b8' }}>→</span>
            <span style={{ color: '#e2e8f0', flex: 1 }}>{row.canonical_name}</span>
            <span style={{ ...muted, fontFamily: 'monospace' }}>{row.entity_id}</span>
            <span style={{ color: '#60a5fa', width: 60, textAlign: 'right' }}>
              {row.confidence.toFixed(3)}
            </span>
          </div>
        ))
      : tab === 'lowconf'
        ? lowConfRows.map((row) => (
            <div key={row.id} style={rowStyle}>
              <FactCheckbox id={row.id} checked={selected.has(row.id)} onToggle={toggle} />
              <span style={{ color: '#e2e8f0', flex: 1 }}>{row.content}</span>
              <span style={{ ...muted, width: 110, textAlign: 'right' }}>conf {row.confidence.toFixed(2)}</span>
              <span style={{ color: '#60a5fa', width: 110, textAlign: 'right' }}>
                imp {row.importance.toFixed(2)}
              </span>
            </div>
          ))
        : pruneRows.map((row) => (
            <div key={row.id} style={rowStyle}>
              <FactCheckbox id={row.id} checked={selected.has(row.id)} onToggle={toggle} />
              <span style={{ color: '#e2e8f0', flex: 1 }}>{row.content}</span>
              <span style={{ color: '#f59e0b', width: 110, textAlign: 'right' }}>
                str {row.strength.toFixed(2)}
              </span>
              <span style={{ ...muted, width: 170, textAlign: 'right' }}>
                {row.last_access_at ?? '从未访问'}
              </span>
            </div>
          ));

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];
  const counts: Record<Tab, number> = {
    resolve: resolveRows.length,
    lowconf: lowConfRows.length,
    prune: pruneRows.length,
  };

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, color: '#f8fafc', letterSpacing: 1 }}>
          默识 · 待办 <span style={{ ...muted, fontSize: 12 }}>三队列 / §10.6</span>
        </div>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              disabled={item.key === tab}
              aria-pressed={item.key === tab}
              title={item.hint}
              style={tabStyle(item.key === tab)}
            >
              {item.label}（{counts[item.key]}）
            </button>
          ))}
        </span>
        <button
          type="button"
          onClick={() => void loadAll()}
          style={{ ...tabStyle(false), marginLeft: 'auto' }}
          disabled={loading}
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      <div style={{ ...muted, marginTop: 6 }}>
        {activeTab?.hint ?? ''} · 队列取前 {QUEUE_LIMIT} 条 · 低置信/淘汰候选可跨 tab 累加勾选
        {tab === 'prune' && pruneThresholds !== null
          ? ` · 判据来自服务端：strength < ${pruneThresholds.strength.toFixed(2)} 且 ${String(pruneThresholds.idle_days)} 天未访问`
          : ''}
        {tab === 'resolve' && ' · 单条确认/合并属 P2-19-A，本页先只展示候选'}
      </div>

      {error !== null && <div style={{ color: '#ef4444', marginTop: 8 }}>出错了：{error}</div>}
      {notice !== null && <div style={{ ...warn, marginTop: 8 }}>{notice}</div>}

      <div style={{ marginTop: 10, overflowY: 'auto', flex: 1 }}>
        {rows.length === 0 ? (
          <div style={{ ...muted, padding: '24px 4px' }}>没有待处理项</div>
        ) : (
          rows
        )}
      </div>

      <BatchPanel
        action={action}
        selectedCount={selected.size}
        preview={preview}
        undoDeadlineMs={op === null ? null : op.deadlineMs}
        remainingMs={op === null ? 0 : op.deadlineMs - nowTs}
        undoAction={op === null ? null : op.action}
        busy={busy}
        onPreview={() => void onPreview()}
        onConfirm={() => void onConfirm()}
        onCancelPreview={() => setPreview(null)}
        onUndo={() => void onUndo()}
      />
    </div>
  );
}
