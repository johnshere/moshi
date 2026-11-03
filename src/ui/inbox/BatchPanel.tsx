/**
 * 批量操作面板（概设 §8.3 两条硬规矩的落地点）。
 *
 * 面板只做展示与回调，所有状态（选中集 / 预览结果 / op / 倒计时 / 错误）都在
 * `InboxPage`——这样跨 tab 切换不会把"已经预览过的影响面"弄丢。
 *
 * 展示顺序刻意固定为「选了几条 → 预览影响面（含连带失效）→ 确认失效 → 撤销条」：
 * ① 影响面预览必达：`invalidated_by_cascade` 单独一行、用警示色，不能折进总数里；
 * ② 30 秒可撤销：确认后原地变成撤销条 + 倒计时，过期由页面处理（这里只显示剩余秒数）。
 */
import type { CSSProperties } from 'react';
import type { PreviewResult } from './api.js';

export interface BatchPanelProps {
  selectedCount: number;
  preview: PreviewResult | null;
  /** 当前可撤销的截止时刻（毫秒时间戳）；null = 没有待撤销的批量操作 */
  undoDeadlineMs: number | null;
  /** 距截止还剩多少毫秒（由页面每 250ms 重算，这里只显示） */
  remainingMs: number;
  busy: boolean;
  onPreview: () => void;
  onConfirm: () => void;
  onCancelPreview: () => void;
  onUndo: () => void;
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 20,
  background: 'rgba(8, 12, 22, 0.97)',
  borderTop: '1px solid #1f2937',
  padding: '10px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 13,
  color: '#cbd5e1',
};

function btn(primary = false): CSSProperties {
  return {
    background: primary ? '#1e3a8a' : '#111827',
    color: primary ? '#e0e7ff' : '#cbd5e1',
    border: `1px solid ${primary ? '#3b82f6' : '#1f2937'}`,
    borderRadius: 4,
    padding: '4px 14px',
    cursor: 'pointer',
    font: 'inherit',
  };
}

const warnStyle: CSSProperties = { color: '#f59e0b' };

export function BatchPanel(props: BatchPanelProps): JSX.Element | null {
  const { selectedCount, preview, undoDeadlineMs, remainingMs, busy } = props;

  // 撤销优先：窗口开着时，面板只显示撤销条（避免误点"再确认一次"）
  if (undoDeadlineMs !== null) {
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    return (
      <div style={panelStyle} role="status" aria-live="polite">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ color: '#f8fafc' }}>批量失效已执行</span>
          <span style={warnStyle}>撤销窗口剩余 {seconds} 秒</span>
          <span style={{ color: '#475569' }}>超时后本次失效不可再撤销（撤销 = 清回 valid_to）</span>
          <span style={{ marginLeft: 'auto' }}>
            <button type="button" style={btn(true)} disabled={busy} onClick={props.onUndo}>
              {busy ? '撤销中…' : '撤销'}
            </button>
          </span>
        </div>
      </div>
    );
  }

  if (preview !== null) {
    return (
      <div style={panelStyle} role="dialog" aria-label="影响面预览">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap' }}>
          <span style={{ color: '#f8fafc' }}>
            将影响 {preview.facts} 条事实、{preview.edges} 条边、{preview.topics} 个主题
          </span>
          {/* 这条必须单独显示：不显示连带失效 = 让人盲签（台账 §4 P2-07 坑） */}
          <span style={warnStyle}>
            连带失效 {preview.invalidated_by_cascade} 条依赖事实（它们依赖这批事实，会一起变 stale）
          </span>
        </div>
        {preview.preview_sample.length > 0 && (
          <div style={{ color: '#64748b', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {preview.preview_sample.map((item) => (
              <span key={item.id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                · {item.content || item.id}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={btn(true)} disabled={busy} onClick={props.onConfirm}>
            {busy ? '执行中…' : `确认失效（${preview.facts} 条）`}
          </button>
          <button type="button" style={btn()} disabled={busy} onClick={props.onCancelPreview}>
            取消
          </button>
        </div>
      </div>
    );
  }

  if (selectedCount === 0) return null;

  return (
    <div style={panelStyle} role="status">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ color: '#f8fafc' }}>已选 {selectedCount} 条事实</span>
        <span style={{ color: '#475569' }}>先看影响面，确认后才执行</span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" style={btn()} disabled={busy} onClick={props.onPreview}>
            {busy ? '计算影响面…' : '预览影响'}
          </button>
        </span>
      </div>
    </div>
  );
}
