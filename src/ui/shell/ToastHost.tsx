/**
 * 全局 Toast 宿主（P2-19A-07b，详设 §10.1：`<ToastHost>` 常驻）。
 *
 * 右下角堆叠、inline style（P2-19-B 再统一视觉）；`undo` 类显示倒计时秒数，
 * 到期由 `useToast.sweep` 移除。按钮回调统一走 `useToast.runAction`（先 dismiss 再执行）。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { useToast, type Toast, type ToastKind } from '../state/toast.js';

const stackStyle: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 80,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 380,
  pointerEvents: 'none',
};

const KIND_STYLE: Record<ToastKind, CSSProperties> = {
  info: { background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-secondary)' },
  success: { background: 'var(--color-success-bg)', border: '1px solid var(--color-success-dim)', color: 'var(--color-success-soft)' },
  error: { background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-dim)', color: 'var(--color-danger-soft)' },
  undo: { background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-dim)', color: 'var(--color-warning-soft)' },
};

const toastStyle: CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 12px',
  borderRadius: 8,
  boxShadow: 'var(--shadow-menu)',
  fontSize: 12,
  lineHeight: 1.4,
};

function secondsLeft(toast: Toast, now: number): number | null {
  if (toast.kind !== 'undo') return null;
  return Math.max(0, Math.ceil((toast.deadline - now) / 1000));
}

function ToastRow({ toast, now }: { toast: Toast; now: number }): ReactElement {
  const seconds = secondsLeft(toast, now);
  return (
    <div style={{ ...toastStyle, ...KIND_STYLE[toast.kind] }} role="status" aria-live="polite">
      <span style={{ flex: 1, minWidth: 0 }}>{toast.text}</span>
      {seconds === null ? null : <span style={{ color: 'var(--color-warning)', fontVariantNumeric: 'tabular-nums' }}>{seconds}s</span>}
      {toast.actionLabel === undefined ? null : (
        <button
          type="button"
          onClick={() => useToast.getState().runAction(toast.id)}
          style={{
            background: 'var(--color-bg-raised)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-text-faint)',
            borderRadius: 8,
            padding: '2px 10px',
            font: 'inherit',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  );
}

export function ToastHost(): ReactElement | null {
  const toasts = useToast((s) => s.toasts);
  const [now, setNow] = useState(() => Date.now());

  // 只在有 toast 时挂定时器：250ms 同时驱动倒计时与到期清理，静默时不空转
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = window.setInterval(() => {
      useToast.getState().sweep(Date.now());
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  return (
    <div style={stackStyle} data-testid="toast-host">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} now={now} />
      ))}
    </div>
  );
}
