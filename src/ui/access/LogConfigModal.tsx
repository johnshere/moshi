/**
 * 「日志与保留」弹框（用户 m01083：取消独立菜单页，改成日志页右上角的弹框）。
 *
 * 内容仍是 `settings/AccessLogsPanel`（唯一写入口）——这里只提供外壳：遮罩、
 * 居中面板、关闭（×／Esc／点遮罩）、打开时聚焦面板并按 `initialSection` 滚到对应段。
 * 弹框只在 `open` 时挂载，避免日志页常驻时先拉一次配置。
 */
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import { AccessLogsPanel } from '../settings/AccessLogsPanel.js';

export interface LogConfigModalProps {
  open: boolean;
  onClose: () => void;
  /** 打开时滚到哪一段（日志页进来时是查询日志） */
  initialSection?: 'query-log' | 'plugin-trace';
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  background: 'rgba(8, 12, 18, 0.78)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const panelStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  padding: '16px 18px',
  maxWidth: 760,
  width: 'calc(100% - 40px)',
  maxHeight: '82vh',
  overflow: 'auto',
  outline: 'none',
  boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
};

const titleStyle: CSSProperties = {
  color: 'var(--color-text-primary)',
  fontSize: 15,
  fontWeight: 600,
  margin: 0,
};

const hintStyle: CSSProperties = {
  color: 'var(--color-text-muted)',
  fontSize: 12,
  marginTop: 4,
};

const closeStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--color-text-muted)',
  fontSize: 18,
  lineHeight: 1,
  padding: '2px 6px',
  cursor: 'pointer',
};

export function LogConfigModal({ open, onClose, initialSection = 'query-log' }: LogConfigModalProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Esc 关闭：只在打开时挂，卸载即移除
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 打开时聚焦面板（tabIndex=-1）并滚到指定段
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    panel.focus();
    const section = panel.querySelector(`#${initialSection}`);
    section?.scrollIntoView({ block: 'start' });
  }, [open, initialSection]);

  if (!open) return null;

  return (
    <div
      style={overlayStyle}
      data-testid="log-config-modal"
      // 点遮罩关闭；面板内点击不关（target 只有落在遮罩本身时才算点外）
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="日志与保留"
        style={panelStyle}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <h3 style={titleStyle}>日志与保留</h3>
            <div style={hintStyle}>
              查询日志保留与清空、插件运行日志档位；这是唯一写入口，日志页只展示与跳转。
            </div>
          </div>
          <button type="button" aria-label="关闭" data-testid="log-config-modal-close" style={closeStyle} onClick={onClose}>
            ×
          </button>
        </div>
        <AccessLogsPanel />
      </div>
    </div>
  );
}
