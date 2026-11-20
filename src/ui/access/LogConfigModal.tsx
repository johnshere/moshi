/**
 * 「日志与保留」弹框（用户 m01083：取消独立菜单页，改成日志页右上角的弹框）。
 *
 * 内容仍是 `settings/AccessLogsPanel`（唯一写入口）——这里只提供外壳：遮罩、
 * 居中面板、关闭（×／Esc／点遮罩）、打开时聚焦面板并按 `initialSection` 滚到对应段。
 * 弹框只在 `open` 时挂载，避免日志页常驻时先拉一次配置。
 *
 * 视觉（w10）：外壳只用 `.modal-backdrop` + `.modal`（1px 强边、顶部 1px 信号线、四角准星），
 * 不再自带颜色字面量。
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { useT } from '../i18n/index.js';
import { AccessLogsPanel } from '../settings/AccessLogsPanel.js';

export interface LogConfigModalProps {
  open: boolean;
  onClose: () => void;
  /** 打开时滚到哪一段（日志页进来时是查询日志） */
  initialSection?: 'query-log' | 'plugin-trace';
}

export function LogConfigModal({ open, onClose, initialSection = 'query-log' }: LogConfigModalProps): ReactElement | null {
  const t = useT();
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
      className="modal-backdrop"
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
        aria-label={t('access.logConfig.title')}
        className="modal log-config-modal"
      >
        <div className="modal-head">
          <div className="modal-head-body">
            <h3 className="modal-title">{t('access.logConfig.title')}</h3>
            <div className="modal-note">{t('access.logConfig.hint')}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('common.close')}
            data-testid="log-config-modal-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <AccessLogsPanel />
      </div>
    </div>
  );
}
