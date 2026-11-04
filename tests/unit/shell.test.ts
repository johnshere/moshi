/**
 * 应用外壳纯函数（P2-19-A，概设 §8.1）。
 *
 * 钉住四件事：
 * 1. 路由/深链解析：`/ui` 默认页、五页、`?fact`/`?canonical_key`/`?focus`/`?q`；
 * 2. 导航 href 只带 token，不把筛选串到别的页面；
 * 3. 待办角标：三队列求和；队列打满一页时只能显示 `N+`（后端没有 total）；
 * 4. 三灯：ok/warn/off/error 映射，数据缺失显式降级。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE,
  PAGES,
  factHref,
  focusHref,
  isSearchShortcut,
  isTypingTarget,
  lightColor,
  memoriesHref,
  pageFromPath,
  pageHref,
  parseRoute,
  queueBadge,
  statusLights,
} from '../../src/ui/shell/pure.js';

describe('路由解析', () => {
  it('/ui 与 /ui/ 默认到 graph', () => {
    expect(pageFromPath('/ui')).toBe('graph');
    expect(pageFromPath('/ui/')).toBe('graph');
    expect(DEFAULT_PAGE).toBe('graph');
  });

  it('五个一级页面都认，且忽略末尾斜杠', () => {
    for (const page of PAGES) {
      expect(pageFromPath(page.path)).toBe(page.key);
      expect(pageFromPath(`${page.path}/`)).toBe(page.key);
    }
  });

  it('未知路径回落 graph（深链拼错不白屏）', () => {
    expect(pageFromPath('/ui/nope')).toBe('graph');
    expect(pageFromPath('/somewhere')).toBe('graph');
  });

  it('记忆页深链：?fact 与 ?canonical_key', () => {
    const fact = parseRoute('/ui/memories', '?fact=01JABC');
    expect(fact.page).toBe('memories');
    expect(fact.factId).toBe('01JABC');
    expect(fact.canonicalKey).toBeNull();

    const canon = parseRoute('/ui/memories', '?canonical_key=environment.pwsh');
    expect(canon.canonicalKey).toBe('environment.pwsh');
    expect(canon.factId).toBeNull();
  });

  it('图谱页深链：?focus；搜索：?q', () => {
    const focus = parseRoute('/ui/graph', '?focus=f-1&view=2d');
    expect(focus.page).toBe('graph');
    expect(focus.focusId).toBe('f-1');

    const search = parseRoute('/ui/memories', '?q=%E5%8D%8F%E5%95%86');
    expect(search.query).toBe('协商');
  });

  it('空串参数归一到 null / 空查询', () => {
    const route = parseRoute('/ui/graph', '?focus=&fact=%20');
    expect(route.focusId).toBeNull();
    expect(route.factId).toBeNull();
    expect(route.query).toBe('');
  });
});

describe('导航 href', () => {
  it('pageHref 只保留 token，丢掉筛选/深链参数', () => {
    expect(pageHref('archive', '?token=t0k&q=x&view=2d')).toBe('/ui/archive?token=t0k');
    expect(pageHref('settings', '?q=x')).toBe('/ui/settings');
  });

  it('memoriesHref 把搜索词编码进 q', () => {
    expect(memoriesHref('pwsh 7', '?token=t')).toBe('/ui/memories?token=t&q=pwsh+7');
    expect(memoriesHref('   ', '')).toBe('/ui/memories');
  });

  it('factHref 生成 ?fact= 深链并保留 token', () => {
    expect(factHref('f-9', '?token=t')).toBe('/ui/memories?token=t&fact=f-9');
  });
});

describe('选中态 ↔ URL（?focus=）', () => {
  it('URL → 选中态：parseRoute 读出 focusId', () => {
    expect(parseRoute('/ui/graph', '?focus=f-1&view=2d').focusId).toBe('f-1');
  });

  it('选中态 → URL：保留其它参数，只写 focus', () => {
    expect(focusHref('/ui/graph', '?token=t&view=2d', 'f-1')).toBe('/ui/graph?token=t&view=2d&focus=f-1');
  });

  it('取消选中 → 从 URL 删除 focus，其它参数不动', () => {
    expect(focusHref('/ui/graph', '?token=t&focus=f-1&view=2d', null)).toBe('/ui/graph?token=t&view=2d');
    expect(focusHref('/ui/graph', '?focus=f-1', null)).toBe('/ui/graph');
  });

  it('双向往返：写进 URL 再解析回来是同一个 id', () => {
    const href = focusHref('/ui/graph', '?token=t', 'f-42');
    const q = href.slice(href.indexOf('?'));
    expect(parseRoute('/ui/graph', q).focusId).toBe('f-42');
  });
});

describe('待办角标', () => {
  it('三队列求和，不满一页给精确值', () => {
    expect(queueBadge([3, 2, 0])).toEqual({ total: 5, capped: false, label: '5' });
  });

  it('任一队列打满单页上限时显示 N+（total 只是下界）', () => {
    const badge = queueBadge([200, 4, 0]);
    expect(badge.capped).toBe(true);
    expect(badge.total).toBe(204);
    expect(badge.label).toBe('204+');
  });

  it('空队列显示 0', () => {
    expect(queueBadge([]).label).toBe('0');
  });
});

describe('快捷键', () => {
  it('输入类元素里不抢 `/`', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('只认裸 `/`，带修饰键不算', () => {
    expect(isSearchShortcut({ key: '/' })).toBe(true);
    expect(isSearchShortcut({ key: '/', ctrlKey: true })).toBe(false);
    expect(isSearchShortcut({ key: '/', metaKey: true })).toBe(false);
    expect(isSearchShortcut({ key: 'a' })).toBe(false);
  });
});

describe('三灯', () => {
  it('全正常：daemon ok / sidecar ready / 向量已索引', () => {
    const lights = statusLights({
      daemon: 'ok',
      sidecar: { state: 'ready', mode: 'on' },
      vector: { state: 'on', indexed: 10, total: 10 },
    });
    expect(lights.map((l) => [l.key, l.state])).toEqual([
      ['daemon', 'ok'],
      ['sidecar', 'ok'],
      ['vector', 'ok'],
    ]);
  });

  it('sidecar 未配置与关闭都是 off，不装绿', () => {
    expect(statusLights({ daemon: 'ok' })[1]?.state).toBe('off');
    expect(statusLights({ daemon: 'ok', sidecar: { state: 'stopped', mode: 'off' } })[1]?.state).toBe('off');
  });

  it('sidecar 启动中 = warn，失败 = error', () => {
    expect(statusLights({ sidecar: { state: 'starting', mode: 'on' } })[1]?.state).toBe('warn');
    expect(statusLights({ sidecar: { state: 'failed', mode: 'on' } })[1]?.state).toBe('error');
  });

  it('取数失败：daemon error + 向量未知 warn，不渲染成正常', () => {
    const lights = statusLights(null);
    expect(lights[0]?.state).toBe('error');
    expect(lights[1]?.state).toBe('off');
    expect(lights[2]?.state).toBe('warn');
    expect(lightColor('error')).not.toBe(lightColor('ok'));
  });
});
