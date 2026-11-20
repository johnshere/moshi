/**
 * `.proposed.md` 三选一对话框（P2-19A-05b）。
 *
 * 只负责展示与选择：三个 action 的后果文案照详设 §9.4；请求由父组件发，
 * 这里不直接 fetch，方便页面统一处理 loading / 错误 / 列表刷新。
 */
import type { ReactElement } from 'react';
import { proposalActions, type ArchiveProposalAction } from './pure.js';
import { useT } from '../i18n/index.js';

export interface ProposedDialogProps {
  slug: string;
  title: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onAction: (action: ArchiveProposalAction) => void;
}

export function ProposedDialog(props: ProposedDialogProps): ReactElement {
  const t = useT();
  const { slug, title, busy, error, onClose, onAction } = props;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" data-testid="archive-proposed-dialog">
      <div className="modal archive-dialog">
        <div className="archive-dialog-head">
          <h3 className="modal-title">{t('archive.dialog.title')}</h3>
          <span className="archive-dialog-topic">{title ?? slug}</span>
          <button
            type="button"
            className="icon-btn archive-dialog-close"
            onClick={onClose}
            disabled={busy}
            data-testid="archive-proposed-close"
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
        <p className="modal-note archive-dialog-desc">{t('archive.dialog.desc')}</p>
        <div className="archive-options">
          {proposalActions(t).map((item) => (
            <button
              key={item.action}
              type="button"
              className="archive-option"
              disabled={busy}
              data-testid={`archive-action-${item.action}`}
              onClick={() => onAction(item.action)}
            >
              <span className="archive-option-label">{item.label}</span>
              <span className="archive-option-why">{item.consequence}</span>
            </button>
          ))}
        </div>
        {busy ? (
          <div className="archive-dialog-busy" data-testid="archive-proposed-busy">
            {t('common.submitting')}
          </div>
        ) : null}
        {error !== null ? (
          <div className="archive-dialog-error" data-testid="archive-proposed-error">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
