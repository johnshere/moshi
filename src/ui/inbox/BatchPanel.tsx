/**
 * 批量操作面板（概设 §8.3 两条硬规矩的落地点）。
 *
 * 面板只做展示与回调，所有状态（选中集 / 预览结果 / op / 倒计时 / 错误）都在
 * `InboxPage`——这样跨 tab 切换不会把"已经预览过的影响面"弄丢。
 *
 * 展示顺序刻意固定为「选了几条 → 预览影响面（含连带失效）→ 确认」：
 * ① 影响面预览必达：invalidate 的 `invalidated_by_cascade` 单独一行、用警示色，
 *    不能折进总数里；prune 不连锁（cascade 恒 0），所以不显示那一行；
 * ② 30 秒可撤销：P2-19A-07b 起撤销条移到全局 `ToastHost`（`src/ui/state/toast.ts`），
 *    本面板不再内联渲染；提交后由 `InboxPage` push 一条 `kind='undo'` 的 toast。
 *
 * P2-13 起同一面板支持两种批量动作（文案与撤销语义都不同）：
 * - `invalidate`：失效（清 valid_to，撤销 = 清回 valid_to）；
 * - `prune`：剪枝（软删 epistemic_status='pruned'，撤销 = 还原 epistemic_status）。
 * P2-19-A 起撤销还可能是单条 `alias_merge`（resolve 队列「并入」）：
 * 它不是批量动作，但共用同一 toast 文案表与撤销 fetch。
 */
import type { CSSProperties } from 'react';
import type { BatchAction, PreviewResult, UndoAction } from './api.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

export interface BatchPanelProps {
  /** 当前选择对应的批量动作：由页面按选中集判定（全是淘汰候选 → prune，否则 invalidate） */
  action: BatchAction;
  selectedCount: number;
  preview: PreviewResult | null;
  busy: boolean;
  onPreview: () => void;
  onConfirm: () => void;
  onCancelPreview: () => void;
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 20,
  background: 'color-mix(in srgb, var(--color-bg-raised) 97%, transparent)',
  borderTop: '1px solid var(--color-border-subtle)',
  padding: '10px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 13,
  color: 'var(--color-text-secondary)',
};

function btn(primary = false): CSSProperties {
  return {
    background: primary ? 'var(--color-info-bg)' : 'var(--color-bg-overlay)',
    color: primary ? 'var(--color-info-text)' : 'var(--color-text-secondary)',
    border: `1px solid ${primary ? 'var(--color-info-strong)' : 'var(--color-border-subtle)'}`,
    borderRadius: 4,
    padding: '4px 14px',
    cursor: 'pointer',
    font: 'inherit',
  };
}

const warnStyle: CSSProperties = { color: 'var(--color-warning)' };

/** 动作 → 文案。集中一处，避免"剪枝按钮写着失效"这类错配 */
const COPY: Record<
  UndoAction,
  { done: DictKey; confirm: DictKey; undoHint: DictKey; previewVerb: DictKey }
> = {
  invalidate: {
    done: 'batch.copy.invalidate.done',
    confirm: 'batch.copy.invalidate.confirm',
    undoHint: 'batch.copy.invalidate.undoHint',
    previewVerb: 'batch.copy.invalidate.verb',
  },
  prune: {
    done: 'batch.copy.prune.done',
    confirm: 'batch.copy.prune.confirm',
    undoHint: 'batch.copy.prune.undoHint',
    previewVerb: 'batch.copy.prune.verb',
  },
  alias_merge: {
    done: 'batch.copy.aliasMerge.done',
    confirm: 'batch.copy.aliasMerge.confirm',
    undoHint: 'batch.copy.aliasMerge.undoHint',
    previewVerb: 'batch.copy.aliasMerge.verb',
  },
};

export function BatchPanel(props: BatchPanelProps): JSX.Element | null {
  const t = useT();
  const { action, selectedCount, preview, busy } = props;

  if (preview !== null) {
    const copy = COPY[action];
    return (
      <div style={panelStyle} role="dialog" aria-label={t('batch.preview.aria')}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--color-text-primary)' }}>
            {t('batch.preview.line', {
              verb: t(copy.previewVerb),
              facts: preview.facts,
              edges: preview.edges,
              topics: preview.topics,
            })}
          </span>
          {/* invalidate 必须单独显示连带失效：不显示 = 让人盲签（台账 §4 P2-07 坑）。
              prune 不连锁（cascade 恒 0），显示「0 条」只会误导，干脆不显示。 */}
          {action === 'invalidate' ? (
            <span style={warnStyle}>
              {t('batch.cascade', { count: preview.invalidated_by_cascade })}
            </span>
          ) : (
            <span style={{ color: 'var(--color-text-muted)' }}>
              {t('batch.softDelete')}
            </span>
          )}
        </div>
        {preview.preview_sample.length > 0 && (
          <div style={{ color: 'var(--color-text-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {preview.preview_sample.map((item) => (
              <span key={item.id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                · {item.content || item.id}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={btn(true)} disabled={busy} onClick={props.onConfirm}>
            {busy
              ? t('batch.running')
              : t('batch.confirmWithCount', { confirm: t(copy.confirm), facts: preview.facts })}
          </button>
          <button type="button" style={btn()} disabled={busy} onClick={props.onCancelPreview}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (selectedCount === 0) return null;

  const copy = COPY[action];
  return (
    <div style={panelStyle} role="status">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ color: 'var(--color-text-primary)' }}>{t('batch.selected', { count: selectedCount })}</span>
        <span style={{ color: 'var(--color-text-faint)' }}>
          {t('batch.willRun', {
            verb: action === 'prune' ? t('batch.copy.prune.verb') : t('batch.copy.invalidate.verb'),
          })}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" style={btn()} disabled={busy} onClick={props.onPreview}>
            {busy ? t('batch.previewBusy') : t('batch.preview')}
          </button>
        </span>
      </div>
      {action === 'prune' && (
        <div style={{ color: 'var(--color-text-muted)' }}>
          {t('batch.pruneNote')}
        </div>
      )}
      {action === 'invalidate' && (
        <div style={{ color: 'var(--color-text-muted)' }}>{t(copy.undoHint)}</div>
      )}
    </div>
  );
}
