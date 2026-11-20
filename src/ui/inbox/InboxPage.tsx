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
 * P2-19A-07b：
 * - 撤销条收口到全局 `ToastHost`（`useToast.push({kind:'undo'})`），本页不再内联渲染，
 *   但 undo fetch 仍在这里（`runUndo`）；
 * - 当前 tab 的队列 id 注册到 `useNav`，j/k 用既有 `useSelection` 选中并高亮。
 *
 * 状态全在本组件：批量操作是"跨 tab 的一件事"，放进子组件会让切 tab 丢掉预览结果。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  InboxApiError,
  decideQueue,
  fetchLowConfQueue,
  fetchPruneQueue,
  fetchResolveQueue,
  previewBatch,
  submitBatch,
  undoBatch,
  type BatchAction,
  type DecideAction,
  type LowConfRow,
  type PreviewResult,
  type PruneRow,
  type PruneThresholds,
  type QueueKind,
  type ResolveRow,
} from './api.js';
import { BatchPanel } from './BatchPanel.js';
import { useNav } from '../state/nav.js';
import { useSelection } from '../state/selection.js';
import { useToast, type ToastInput } from '../state/toast.js';
import { useT, type Translator } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

type Tab = 'resolve' | 'lowconf' | 'prune';

const TABS: readonly { key: Tab; labelKey: DictKey; hintKey: DictKey }[] = [
  { key: 'resolve', labelKey: 'inbox.tab.resolve', hintKey: 'inbox.tab.resolveHint' },
  { key: 'lowconf', labelKey: 'inbox.tab.lowconf', hintKey: 'inbox.tab.lowconfHint' },
  { key: 'prune', labelKey: 'inbox.tab.prune', hintKey: 'inbox.tab.pruneHint' },
];

/** 每页取多少条：与服务端默认 limit 一致 */
const QUEUE_LIMIT = 50;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 单条决策成功后的提示：说清"改了什么"，而不是只弹「成功」 */
function decideNotice(
  action: DecideAction,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  t: Translator,
): string {
  const val = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (action) {
    case 'merge':
      return t('inbox.notice.merged', { alias: val(before['alias']), entity: val(before['entity_id']) });
    case 'keep':
      return t('inbox.notice.kept');
    case 'reject':
      return t('inbox.notice.rejected');
    case 'promote':
      return t('inbox.notice.promoted', { value: val(after['confidence']) });
    default:
      return t('inbox.notice.invalidated');
  }
}

/** 行内小按钮：只做单条决策，视觉上收成读数带内的微型控件 */
function RowButton(props: {
  label: string;
  tone?: 'plain' | 'primary' | 'danger';
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  const toneClass =
    props.tone === 'danger' ? ' btn-danger' : props.tone === 'primary' ? ' inbox-act-primary' : '';
  return (
    <button
      type="button"
      className={`btn inbox-act${toneClass}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function FactCheckbox(props: {
  id: string;
  checked: boolean;
  onToggle: (id: string) => void;
}): JSX.Element {
  const t = useT();
  return (
    <input
      type="checkbox"
      className="inbox-check"
      checked={props.checked}
      onChange={() => props.onToggle(props.id)}
      aria-label={t('inbox.selectRow', { id: props.id })}
    />
  );
}

export function InboxPage(): JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<Tab>('resolve');
  const [resolveRows, setResolveRows] = useState<ResolveRow[]>([]);
  const [lowConfRows, setLowConfRows] = useState<LowConfRow[]>([]);
  const [pruneRows, setPruneRows] = useState<PruneRow[]>([]);
  const [pruneThresholds, setPruneThresholds] = useState<PruneThresholds | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 正在处理的单条行 id（行内按钮只锁自己那一行，不锁整页） */
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const focusId = useSelection((s) => s.focusId);
  const pushToast = useCallback((input: ToastInput): void => {
    useToast.getState().push(input);
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [resolve, lowconf, prune] = await Promise.all([
        fetchResolveQueue(QUEUE_LIMIT),
        fetchLowConfQueue(QUEUE_LIMIT),
        fetchPruneQueue(QUEUE_LIMIT),
      ]);
      setResolveRows(resolve.items);
      setLowConfRows(lowconf.items);
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

  // 当前 tab 的行 id 注册给 j/k 导航（useNav.move 内部用 useSelection.select 选中）
  useEffect(() => {
    const ids =
      tab === 'resolve'
        ? resolveRows.map((row) => row.id)
        : tab === 'lowconf'
          ? lowConfRows.map((row) => row.id)
          : pruneRows.map((row) => row.id);
    useNav.getState().setItems(ids);
  }, [tab, resolveRows, lowConfRows, pruneRows]);

  // 离开页面时清空导航项，避免 j/k 跨页残留
  useEffect(() => () => useNav.getState().clear(), []);

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
      setError(t('inbox.preview.failed', { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  }, [action, selected, t]);

  /** 撤销一次 op：toast 按钮触发；410 = 撤销窗口已过，只刷新队列 */
  const runUndo = useCallback(
    async (opId: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const result = await undoBatch(opId);
        pushToast({ kind: 'success', text: t('inbox.undo.done', { count: result.restored }) });
        await loadAll();
      } catch (e) {
        if (e instanceof InboxApiError && e.status === 410) {
          pushToast({ kind: 'info', text: t('inbox.undo.expired') });
          await loadAll();
        } else {
          setError(t('inbox.undo.failed', { error: errorText(e) }));
          pushToast({ kind: 'error', text: t('inbox.undo.failed', { error: errorText(e) }) });
        }
      } finally {
        setBusy(false);
      }
    },
    [loadAll, pushToast],
  );

  const onConfirm = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await submitBatch(action, [...selected]);
      setPreview(null);
      setSelected(new Set());
      pushToast({
        kind: 'undo',
        text:
          action === 'prune'
            ? t('inbox.confirm.pruned', { count: result.facts })
            : t('inbox.confirm.invalidated', {
                count: result.facts,
                cascade: result.invalidated_by_cascade,
              }),
        actionLabel: t('inbox.undo'),
        deadline: Date.parse(result.undo_deadline),
        onAction: () => {
          void runUndo(result.op_id);
        },
      });
      await loadAll();
    } catch (e) {
      setError(t('inbox.exec.failed', { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  }, [action, selected, loadAll, pushToast, runUndo, t]);

  /** 单条决策（P2-19-A）：merge / invalidate 会拿到 op_id → 生成同款撤销 toast */
  const onDecide = useCallback(
    async (kind: QueueKind, id: string, decideAction: DecideAction): Promise<void> => {
      setRowBusy(id);
      setError(null);
      try {
        const result = await decideQueue(kind, id, decideAction);
        const text = decideNotice(decideAction, result.before, result.after, t);
        if (result.op_id !== undefined && result.undo_deadline !== undefined) {
          const opId = result.op_id;
          pushToast({
            kind: 'undo',
            text,
            actionLabel: t('inbox.undo'),
            deadline: Date.parse(result.undo_deadline),
            onAction: () => {
              void runUndo(opId);
            },
          });
        } else {
          pushToast({ kind: 'success', text });
        }
        await loadAll();
      } catch (e) {
        setError(t('inbox.decideFailed', { error: errorText(e) }));
      } finally {
        setRowBusy(null);
      }
    },
    [loadAll, pushToast, runUndo],
  );

  const rows: JSX.Element[] =
    tab === 'resolve'
      ? resolveRows.map((row) => (
          <div
            key={row.id}
            data-fact-id={row.id}
            className="inbox-row"
            data-kind="resolve"
            data-focus={row.id === focusId}
          >
            <span className="inbox-lamp" aria-hidden="true" />
            <span className="inbox-alias" title={row.alias}>
              {row.alias}
            </span>
            <span className="inbox-arrow" aria-hidden="true">
              →
            </span>
            <span className="inbox-canonical">{row.canonical_name}</span>
            <span className="inbox-entity" title={row.entity_id}>
              {row.entity_id}
            </span>
            <span className="inbox-num">{row.confidence.toFixed(3)}</span>
            <span className="inbox-actions">
              <RowButton
                label={t('inbox.row.merge')}
                tone="primary"
                disabled={rowBusy !== null}
                onClick={() => void onDecide('resolve', row.id, 'merge')}
              />
              <RowButton
                label={t('inbox.row.keep')}
                disabled={rowBusy !== null}
                onClick={() => void onDecide('resolve', row.id, 'keep')}
              />
              <RowButton
                label={t('inbox.row.reject')}
                tone="danger"
                disabled={rowBusy !== null}
                onClick={() => void onDecide('resolve', row.id, 'reject')}
              />
            </span>
          </div>
        ))
      : tab === 'lowconf'
        ? lowConfRows.map((row) => (
            <div
              key={row.id}
              data-fact-id={row.id}
              className="inbox-row"
              data-kind="lowconf"
              data-focus={row.id === focusId}
            >
              <FactCheckbox id={row.id} checked={selected.has(row.id)} onToggle={toggle} />
              <span className="inbox-lamp" aria-hidden="true" />
              <span className="inbox-content">{row.content}</span>
              <span className="inbox-num inbox-num-muted">{row.confidence.toFixed(2)}</span>
              <span className="inbox-num">{row.importance.toFixed(2)}</span>
              <span className="inbox-actions">
                <RowButton
                  label={t('inbox.row.promote')}
                  tone="primary"
                  disabled={rowBusy !== null}
                  onClick={() => void onDecide('lowconf', row.id, 'promote')}
                />
                <RowButton
                  label={t('inbox.row.invalidate')}
                  tone="danger"
                  disabled={rowBusy !== null}
                  onClick={() => void onDecide('lowconf', row.id, 'invalidate')}
                />
              </span>
            </div>
          ))
        : pruneRows.map((row) => (
            <div
              key={row.id}
              data-fact-id={row.id}
              className="inbox-row"
              data-kind="prune"
              data-focus={row.id === focusId}
            >
              <FactCheckbox id={row.id} checked={selected.has(row.id)} onToggle={toggle} />
              <span className="inbox-lamp" aria-hidden="true" />
              <span className="inbox-content">{row.content}</span>
              <span className="inbox-num inbox-str">{row.strength.toFixed(2)}</span>
              <span className="inbox-time">{row.last_access_at ?? t('inbox.neverAccessed')}</span>
            </div>
          ));

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];
  const counts: Record<Tab, number> = {
    resolve: resolveRows.length,
    lowconf: lowConfRows.length,
    prune: pruneRows.length,
  };

  return (
    <div className="ledger inbox-page">
      <div className="ledger-head inbox-head">
        <div className="ledger-title">{t('inbox.title')}</div>
        <div className="ledger-meta">{t('inbox.subtitle')}</div>
        <div className="seg inbox-tabs" role="group" aria-label={t('inbox.title')}>
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="seg-item"
              data-active={item.key === tab}
              onClick={() => setTab(item.key)}
              disabled={item.key === tab}
              aria-pressed={item.key === tab}
              title={t(item.hintKey)}
            >
              {t('inbox.tabCount', { label: t(item.labelKey), count: counts[item.key] })}
            </button>
          ))}
        </div>
        <div className="ledger-tools">
          <button
            type="button"
            className="btn inbox-refresh"
            onClick={() => void loadAll()}
            disabled={loading}
          >
            {loading ? t('common.loading') : t('inbox.refresh')}
          </button>
        </div>
      </div>

      <div className="ledger-shelf inbox-hint">
        {(activeTab === undefined ? '' : t(activeTab.hintKey)) + t('inbox.hint.tail', { limit: QUEUE_LIMIT })}
        {tab === 'prune' && pruneThresholds !== null
          ? t('inbox.hint.prune', {
              strength: pruneThresholds.strength.toFixed(2),
              days: pruneThresholds.idle_days,
            })
          : ''}
        {tab === 'resolve' && t('inbox.hint.resolve')}
      </div>

      {error !== null && (
        <div className="inbox-error" role="alert">
          {t('inbox.errorGeneric', { error })}
        </div>
      )}

      <div className="inbox-body">
        {rows.length === 0 ? (
          <div className="inbox-empty">
            <div className="inbox-empty-title">{t('inbox.empty')}</div>
            <div className="inbox-empty-readout">
              0 / {QUEUE_LIMIT}
            </div>
          </div>
        ) : (
          <>
            <div className="inbox-cols" data-kind={tab} aria-hidden="true">
              {tab === 'resolve' ? (
                <>
                  <span />
                  <span>alias</span>
                  <span />
                  <span>canonical</span>
                  <span>entity</span>
                  <span>conf</span>
                  <span />
                </>
              ) : tab === 'lowconf' ? (
                <>
                  <span />
                  <span />
                  <span>content</span>
                  <span>conf</span>
                  <span>imp</span>
                  <span />
                </>
              ) : (
                <>
                  <span />
                  <span />
                  <span>content</span>
                  <span>str</span>
                  <span>last_access</span>
                </>
              )}
            </div>
            <div className="inbox-rows">{rows}</div>
          </>
        )}
      </div>

      <BatchPanel
        action={action}
        selectedCount={selected.size}
        preview={preview}
        busy={busy}
        onPreview={() => void onPreview()}
        onConfirm={() => void onConfirm()}
        onCancelPreview={() => setPreview(null)}
      />
    </div>
  );
}
