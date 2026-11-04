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
  { done: string; confirm: string; undoHint: string; previewVerb: string }
> = {
  invalidate: {
    done: '批量失效已执行',
    confirm: '确认失效',
    undoHint: '超时后本次失效不可再撤销（撤销 = 清回 valid_to）',
    previewVerb: '影响',
  },
  prune: {
    done: '批量剪枝已执行',
    confirm: '确认剪枝',
    undoHint: '超时后本次剪枝不可再撤销（撤销 = 还原 epistemic_status）',
    previewVerb: '剪枝',
  },
  alias_merge: {
    done: '单条并入已执行',
    confirm: '确认并入',
    undoHint: '超时后本次并入不可再撤销（撤销 = 还原 alias 的 source / confidence）',
    previewVerb: '并入',
  },
};

export function BatchPanel(props: BatchPanelProps): JSX.Element | null {
  const { action, selectedCount, preview, busy } = props;

  if (preview !== null) {
    const copy = COPY[action];
    return (
      <div style={panelStyle} role="dialog" aria-label="影响面预览">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--color-text-primary)' }}>
            将{copy.previewVerb} {preview.facts} 条事实、{preview.edges} 条边、{preview.topics} 个主题
          </span>
          {/* invalidate 必须单独显示连带失效：不显示 = 让人盲签（台账 §4 P2-07 坑）。
              prune 不连锁（cascade 恒 0），显示「0 条」只会误导，干脆不显示。 */}
          {action === 'invalidate' ? (
            <span style={warnStyle}>
              连带失效 {preview.invalidated_by_cascade} 条依赖事实（它们依赖这批事实，会一起变 stale）
            </span>
          ) : (
            <span style={{ color: 'var(--color-text-muted)' }}>
              软删：事实行与有效区间都保留，仅标注为 pruned（可撤销）
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
            {busy ? '执行中…' : `${copy.confirm}（${preview.facts} 条）`}
          </button>
          <button type="button" style={btn()} disabled={busy} onClick={props.onCancelPreview}>
            取消
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
        <span style={{ color: 'var(--color-text-primary)' }}>已选 {selectedCount} 条事实</span>
        <span style={{ color: 'var(--color-text-faint)' }}>
          将执行「{action === 'prune' ? '剪枝（软删）' : '失效'}」，先看影响面，确认后才执行
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" style={btn()} disabled={busy} onClick={props.onPreview}>
            {busy ? '计算影响面…' : '预览影响'}
          </button>
        </span>
      </div>
      {action === 'prune' && (
        <div style={{ color: 'var(--color-text-muted)' }}>
          剪枝只标注不删除；依赖它的下游由读侧收口（不会连带改写其它事实）
        </div>
      )}
      {action === 'invalidate' && (
        <div style={{ color: 'var(--color-text-muted)' }}>{copy.undoHint}</div>
      )}
    </div>
  );
}
