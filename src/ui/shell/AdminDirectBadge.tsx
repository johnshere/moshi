/**
 * 「管理面直读 · 不过 gate」标记（P2①）。
 *
 * 为什么需要它：`/api/search`、`/api/facts`、`/api/graph` 是**管理面直读**——实体 LIKE +
 * FTS5 bm25 直接出表，不过 gate、不产 evidence、不给 confidence/advice。它们本来的用途是
 * 排障与编辑，但界面上和图谱并排放着，很容易被当成「召回入口」，于是有人拿直查结果当
 * 「系统认为可信的记忆」。召回语义只有一条链（`runMemoryQuery`，界面上是召回页），
 * 这枚角标就是那里的反向指路牌：行为不变，但把口径写在脸上。
 *
 * 角标本身可点，直接跳召回页——看完直读表想验证「该采信什么」，一步能到。
 */
import type { CSSProperties, ReactElement } from 'react';
import { pageHref } from './pure.js';
import { useT } from '../i18n/index.js';

const badgeStyle: CSSProperties = {
  pointerEvents: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  border: '1px solid var(--color-border-strong)',
  borderRadius: 999,
  padding: '2px 10px',
  fontSize: 11,
  lineHeight: 1.6,
  color: 'var(--color-warning)',
  background: 'color-mix(in srgb, var(--color-warning) 12%, var(--color-bg-overlay))',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

export function AdminDirectBadge(): ReactElement {
  const t = useT();
  return (
    <a
      data-testid="admin-direct-badge"
      href={pageHref('recall', window.location.search)}
      title={t('adminDirect.title')}
      style={badgeStyle}
    >
      {t('adminDirect.badge')}
    </a>
  );
}
