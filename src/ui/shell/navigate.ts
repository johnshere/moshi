/**
 * 外壳的导航副作用（P2-19-A）。
 *
 * 纯函数只算 href；真正改地址栏只在这一处：pushState 后广播 popstate，
 * 让 `Root` 统一重新解析 URL（不引入路由库，也不在组件里散落 history 调用）。
 */
import type { PageKey } from './pure.js';
import { pageHref } from './pure.js';

export function navigate(href: string): void {
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function navigatePage(page: PageKey): void {
  navigate(pageHref(page, window.location.search));
}
