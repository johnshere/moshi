/**
 * 全局 Toast 宿主（P2-19A-07b，详设 §10.1：`<ToastHost>` 常驻）。
 *
 * 右下角堆叠、inline style（P2-19-B 再统一视觉）；`undo` 类显示倒计时秒数，
 * 到期由 `useToast.sweep` 移除。按钮回调统一走 `useToast.runAction`（先 dismiss 再执行）。
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useToast, type Toast } from '../state/toast.js';

function secondsLeft(toast: Toast, now: number): number | null {
  if (toast.kind !== 'undo') return null;
  return Math.max(0, Math.ceil((toast.deadline - now) / 1000));
}

function ToastRow({ toast, now }: { toast: Toast; now: number }): ReactElement {
  const seconds = secondsLeft(toast, now);
  return (
    <div className="toast" data-kind={toast.kind} role="status" aria-live="polite">
      <span style={{ flex: 1, minWidth: 0 }}>{toast.text}</span>
      {seconds === null ? null : (
        <span className="moshi-value" style={{ color: 'var(--color-warning)' }}>
          {seconds}s
        </span>
      )}
      {toast.actionLabel === undefined ? null : (
        <button type="button" className="btn" onClick={() => useToast.getState().runAction(toast.id)}>
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
    <div className="toast-stack" data-testid="toast-host">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} now={now} />
      ))}
    </div>
  );
}
