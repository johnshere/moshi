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
import { useNav } from '../state/nav.js';
import { useSelection } from '../state/selection.js';
import { useT } from '../i18n/index.js';
import type { RouteInfo } from '../shell/pure.js';
import { EntityMergePanel } from './EntityMergePanel.js';
import { SearchBox } from '../shell/SearchBox.js';
import { ScopeSwitcher } from '../shell/ScopeSwitcher.js';

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
  background: 'linear-gradient(color-mix(in srgb, var(--color-bg-base) 96%, transparent), color-mix(in srgb, var(--color-bg-base) 72%, transparent))',
  borderBottom: '1px solid var(--color-border-subtle)',
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
  const t = useT();
  const factId = route.factId;

  useEffect(() => {
    if (factId === null) return;
    useSelection.getState().select(factId);
    return scrollToFact(factId);
  }, [factId]);

  // 行 id 注册给 j/k 导航：FactsTable 是虚拟滚动，行 id 只写在 DOM 的 title 里
  // （`content\n\nid`），不改表格组件，用 MutationObserver 跟随渲染/滚动变化。
  useEffect(() => {
    const readIds = (): string[] => {
      const rows = document.querySelectorAll<HTMLElement>('[role="row"][title]');
      const ids: string[] = [];
      for (const row of rows) {
        const title = row.getAttribute('title') ?? '';
        const id = title.split('\n\n').pop() ?? '';
        if (id !== '') ids.push(id);
      }
      return ids;
    };
    useNav.getState().setItems(readIds());
    const observer = new MutationObserver(() => {
      useNav.getState().setItems(readIds());
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['title'],
    });
    return () => {
      observer.disconnect();
      useNav.getState().clear();
    };
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <FactsTable key={route.query} />
      <Inspector />
      <div style={overlayStyle}>
        <div style={{ color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600, padding: '4px 2px', whiteSpace: 'nowrap' }}>
          {t('memories.title')}
        </div>
        {/* 全局搜索与作用域下拉从顶栏下移到这里（V-10，用户 m01201）：顶栏只留 语言+三灯+角标 */}
        <SearchBox />
        <ScopeSwitcher />
        <div style={{ flex: 1, minWidth: 0 }}>
          <FilterBar />
        </div>
      </div>
      {route.canonicalKey === null ? null : (        <div
          data-testid="canonical-note"
          style={{
            position: 'absolute',
            left: 12,
            bottom: 12,
            zIndex: 9,
            background: 'var(--color-bg-overlay)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 5,
            color: 'var(--color-text-secondary)',
            fontSize: 11,
            padding: '5px 9px',
            maxWidth: '50vw',
          }}
        >
          {t('memories.canonicalApprox', { key: route.canonicalKey })}
        </div>
      )}
      <EntityMergePanel />
    </div>
  );
}
