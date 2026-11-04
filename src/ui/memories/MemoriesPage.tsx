/**
 * 记忆页（P2-19-A，概设 §8.1 / 详设 §10.1）：FilterBar + FactsTable + Inspector。
 *
 * 深链：
 * - `?fact=<id>`：选中并滚到该行（行是虚拟滚动，必须轮询等它进 DOM）
 * - `?canonical_key=<k>`：/api/facts 没有该筛选参数（D-89 不改契约），
 *   Root 会把 `<k>` 归一成 `q` 近似检索，本页只标明这一降级。
 */
import { useEffect, type CSSProperties, type ReactElement } from 'react';
import { FactsTable } from '../table/FactsTable.js';
import { FilterBar } from '../filter/FilterBar.js';
import { Inspector } from '../inspector/Inspector.js';
import { useSelection } from '../state/selection.js';
import type { RouteInfo } from '../shell/pure.js';

const overlayStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 8,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '7px 12px',
  background: 'linear-gradient(rgba(7,12,22,.96), rgba(7,12,22,.72))',
  borderBottom: '1px solid #1e293b',
  boxSizing: 'border-box',
};

function scrollToFact(factId: string): (() => void) | undefined {
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const rows = document.querySelectorAll<HTMLElement>('[role="row"][title]');
    for (const row of rows) {
      const title = row.getAttribute('title') ?? '';
      if (title.endsWith(factId)) {
        row.scrollIntoView({ block: 'center' });
        window.clearInterval(timer);
        return;
      }
    }
    if (attempts >= 50) window.clearInterval(timer);
  }, 200);
  return () => window.clearInterval(timer);
}

export interface MemoriesPageProps {
  route: RouteInfo;
}

export function MemoriesPage({ route }: MemoriesPageProps): ReactElement {
  const factId = route.factId;

  useEffect(() => {
    if (factId === null) return;
    useSelection.getState().select(factId);
    return scrollToFact(factId);
  }, [factId]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <FactsTable key={route.query} />
      <Inspector />
      <div style={overlayStyle}>
        <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600, padding: '4px 2px', whiteSpace: 'nowrap' }}>
          记忆
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <FilterBar />
        </div>
      </div>
      {route.canonicalKey === null ? null : (
        <div
          data-testid="canonical-note"
          style={{
            position: 'absolute',
            left: 12,
            bottom: 12,
            zIndex: 9,
            background: '#111827',
            border: '1px solid #334155',
            borderRadius: 5,
            color: '#94a3b8',
            fontSize: 11,
            padding: '5px 9px',
            maxWidth: '50vw',
          }}
        >
          canonical_key={route.canonicalKey} · 后端 /api/facts 无该筛选参数，已按 q 近似检索
        </div>
      )}
    </div>
  );
}
