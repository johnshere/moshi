/**
 * `.proposed.md` 三选一对话框（P2-19A-05b）。
 *
 * 只负责展示与选择：三个 action 的后果文案照详设 §9.4；请求由父组件发，
 * 这里不直接 fetch，方便页面统一处理 loading / 错误 / 列表刷新。
 */
import type { CSSProperties, ReactElement } from 'react';
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

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'color-mix(in srgb, var(--color-bg-base) 72%, transparent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 40,
};

const cardStyle: CSSProperties = {
  width: 560,
  maxWidth: 'calc(100vw - 40px)',
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 8,
  padding: 18,
  color: 'var(--color-text-secondary)',
  boxShadow: 'var(--shadow-panel)',
};

const optionStyle = (busy: boolean): CSSProperties => ({
  width: '100%',
  textAlign: 'left',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  background: 'var(--color-bg-overlay)',
  color: 'var(--color-text-primary)',
  padding: '10px 12px',
  marginBottom: 8,
  cursor: busy ? 'wait' : 'pointer',
  font: 'inherit',
  opacity: busy ? 0.6 : 1,
});

export function ProposedDialog(props: ProposedDialogProps): ReactElement {
  const t = useT();
  const { slug, title, busy, error, onClose, onAction } = props;
  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" data-testid="archive-proposed-dialog">
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: 'var(--color-text-primary)' }}>{t('archive.dialog.title')}</h3>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{title ?? slug}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            data-testid="archive-proposed-close"
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              cursor: busy ? 'wait' : 'pointer',
              fontSize: 16,
            }}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
        <p style={{ margin: '8px 0 12px', color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
          {t('archive.dialog.desc')}
        </p>
        {proposalActions(t).map((item) => (
          <button
            key={item.action}
            type="button"
            disabled={busy}
            data-testid={`archive-action-${item.action}`}
            style={optionStyle(busy)}
            onClick={() => onAction(item.action)}
          >
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{item.label}</div>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.55 }}>{item.consequence}</div>
          </button>
        ))}
        {busy ? (
          <div style={{ color: 'var(--color-warning-soft)', fontSize: 12 }} data-testid="archive-proposed-busy">
            {t('common.submitting')}
          </div>
        ) : null}
        {error !== null ? (
          <div
            data-testid="archive-proposed-error"
            style={{
              border: '1px solid var(--color-danger-dim)',
              background: 'var(--color-danger-bg)',
              color: 'var(--color-danger-soft)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
