/**
 * 记忆页（W8 索引台）：页头（标题 + 直读标记 + 搜索 + 作用域）→ 筛选架 → 台账 → 右侧档案抽屉。
 *
 * 布局从「表格铺满 + 顶部覆盖层」改成三段式台账：表格不再需要为覆盖层让出 148px，
 * 自己就是正常文档流里的一格。数据流与深链行为完全不变：
 * - `?fact=<id>`：选中并滚到该行（行是虚拟滚动，必须轮询等它进 DOM）
 * - `?canonical_key=<k>`：/api/facts 没有该筛选参数（D-89 不改契约），
 *   Root 会把 `<k>` 归一成 `q` 近似检索，本页只标明这一降级。
 */
import { useEffect, type ReactElement } from 'react';
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
import { AdminDirectBadge } from '../shell/AdminDirectBadge.js';

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
    <div className="ledger">
      <div className="ledger-head">
        <div className="ledger-title">{t('memories.title')}</div>
        <AdminDirectBadge />
        <div className="ledger-tools">
          {/* 全局搜索与作用域下拉从顶栏下移到这里（V-10，用户 m01201）：顶栏只留 语言+三灯+角标 */}
          <SearchBox />
          <ScopeSwitcher />
        </div>
      </div>

      <div className="ledger-shelf">
        <FilterBar />
      </div>

      <div className="ledger-body">
        <FactsTable key={route.query} topInset={0} />
        <Inspector />
        {route.canonicalKey === null ? null : (
          <div className="canonical-note" data-testid="canonical-note">
            {t('memories.canonicalApprox', { key: route.canonicalKey })}
          </div>
        )}
      </div>

      <EntityMergePanel />
    </div>
  );
}
