/**
 * 应用外壳的纯函数（P2-19-A，概设 §8.1 / 详设 §10.1）。
 *
 * 这一层不碰 DOM、不 import React：路由解析、导航 href、待办角标、`/` 快捷键判定、
 * 三灯映射都在这里，单测可以直接钉（`tests/unit/shell.test.ts`）。
 *
 * 路由仍是「按 pathname 前缀分派」，不引路由库（概设 §8.9：不加没必要的依赖）。
 * URL 是唯一真相源：页面、筛选、深链都从 pathname + search 解析，不回写 store。
 */
import type { DictKey } from '../i18n/dict.js';

/**
 * 七个一级页面（概设 §8.1；P4 新增「接入」；P2① 新增「召回」）。顺序即左侧导航顺序。
 *
 * 「召回」放在图谱之后、记忆之前：它是**唯一读取链**的入口，记忆页是管理面直读，
 * 两者的先后顺序就是在告诉用户「问问题走召回，翻事实才走记忆」。
 */
export type PageKey = 'graph' | 'recall' | 'memories' | 'inbox' | 'archive' | 'access' | 'settings';

export interface PageDef {
  key: PageKey;
  /** 菜单文案（D-184：只存 key，渲染时经 `t()` 取当前语言） */
  labelKey: DictKey;
  /** 概设 §8.1 的页面路径；`/ui` 默认重定向到 graph。 */
  path: string;
  titleKey: DictKey;
}

export const PAGES: readonly PageDef[] = [
  { key: 'graph', labelKey: 'nav.graph', path: '/ui/graph', titleKey: 'nav.graph.title' },
  // 召回是唯一读取链的界面入口（P2①）：内部走 POST /api/recall → runMemoryQuery
  { key: 'recall', labelKey: 'nav.recall', path: '/ui/recall', titleKey: 'nav.recall.title' },
  { key: 'memories', labelKey: 'nav.memories', path: '/ui/memories', titleKey: 'nav.memories.title' },
  { key: 'inbox', labelKey: 'nav.inbox', path: '/ui/inbox', titleKey: 'nav.inbox.title' },
  { key: 'archive', labelKey: 'nav.archive', path: '/ui/archive', titleKey: 'nav.archive.title' },
  // 接入是**树节点**：日志 / 接入点两个二级（P4；用户 m00882 并入接入相关全部；用户 m01083 把「日志与保留」改成日志页弹框）
  { key: 'access', labelKey: 'nav.access', path: '/ui/access', titleKey: 'nav.access.title' },
  // 设置是**树节点**：二级在 SETTINGS_SECTIONS（设计 §16.5.2 / §16.5.3）
  { key: 'settings', labelKey: 'nav.settings', path: '/ui/settings', titleKey: 'nav.settings.title' },
];

export const DEFAULT_PAGE: PageKey = 'graph';

const PAGE_KEYS: readonly string[] = PAGES.map((p) => p.key);

/**
 * 设置的四个二级（设计 §16.5.3，用户 m01506/m02743 裁决）。
 *
 * **顺序即菜单顺序，第一项也是 `/ui/settings` 的默认落地页**：先调参数，
 * 然后维护/隐私/诊断。原「接入与日志」已按用户 m00882 并入一级「接入」。
 */
export type SettingsSection = 'config' | 'maintain' | 'privacy' | 'diagnose';

export interface SettingsSectionDef {
  key: SettingsSection;
  labelKey: DictKey;
  /** `/ui/settings/<key>` */
  path: string;
  titleKey: DictKey;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { key: 'config', labelKey: 'settings.section.config', path: '/ui/settings/config', titleKey: 'settings.section.config.title' },
  { key: 'maintain', labelKey: 'settings.section.maintain', path: '/ui/settings/maintain', titleKey: 'settings.section.maintain.title' },
  { key: 'privacy', labelKey: 'settings.section.privacy', path: '/ui/settings/privacy', titleKey: 'settings.section.privacy.title' },
  { key: 'diagnose', labelKey: 'settings.section.diagnose', path: '/ui/settings/diagnose', titleKey: 'settings.section.diagnose.title' },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'config';

/** 接入页的两个二级（P4；开发方案 §7）。「日志与保留」按用户 m01083 改成日志页弹框，不再是二级。 */
export type AccessSection = 'logs' | 'endpoints';

export interface AccessSectionDef {
  key: AccessSection;
  labelKey: DictKey;
  /** `/ui/access/<key>` */
  path: string;
  titleKey: DictKey;
}

export const ACCESS_SECTIONS: readonly AccessSectionDef[] = [
  { key: 'logs', labelKey: 'access.section.logs', path: '/ui/access/logs', titleKey: 'access.section.logs.title' },
  { key: 'endpoints', labelKey: 'access.section.endpoints', path: '/ui/access/endpoints', titleKey: 'access.section.endpoints.title' },
];

export const DEFAULT_ACCESS_SECTION: AccessSection = 'logs';

const SECTION_KEYS: readonly string[] = SETTINGS_SECTIONS.map((s) => s.key);
const ACCESS_KEYS: readonly string[] = ACCESS_SECTIONS.map((s) => s.key);

/**
 * 接入页的**独立整页**路径（设计 §16.5.5）。与接入二级 `/ui/access/endpoints`
 * （`EndpointsPage` 内嵌同一个 `AccessPage`）是同一个组件、两个外壳；这个地址是
 * 外部契约（`magpie.cmd` 用它拉起界面）。
 */
export const HOOK_UI_PATH = '/ui/hook';

/** 解析后的路由态：页面 + 深链参数（全部已 trim，空串归一为 null）。 */
export interface RouteInfo {
  page: PageKey;
  /** 设置二级；非设置页恒为 null（`/ui/settings` 无二级 → 默认 config） */
  section: SettingsSection | null;
  /** 接入二级；非接入页恒为 null（`/ui/access` → 默认 logs，`/ui/hook` → endpoints） */
  accessSection: AccessSection | null;
  /** `/ui/hook`：接入页独立整页（不属于一级页的子路由，单独一个屏幕位） */
  standalone: 'hook' | null;
  /** `/ui/memories?fact=<id>`：选中并滚到可见 */
  factId: string | null;
  /** `/ui/memories?canonical_key=<k>`：按规范化键过滤（后端只有 q，见页内说明） */
  canonicalKey: string | null;
  /** `/ui/graph?focus=<id>`：选中图节点 */
  focusId: string | null;
  /** `/ui/memories?q=<查询>`：记忆页搜索词 */
  query: string;
}

function nonEmpty(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  return v === '' ? null : v;
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+/g, '/').replace(/\/+$/, '');
}

/**
 * pathname → 页面。`/ui`、`/ui/`、未知子路径都回落默认页（深链拼错不该白屏）；
 * 末尾斜杠忽略，`/ui/memories/` 与 `/ui/memories` 等价。
 *
 * 两处**不是**五页但归到 settings 的路径（设计 §16.5.1 / §16.5.5）：
 * - `/ui/settings/<section>`：二级深链，归 settings 且由 `sectionFromPath` 决定哪个二级；
 * - `/ui/hook`：接入页独立整页，导航高亮跟着一级「接入」走。
 */
export function pageFromPath(pathname: string): PageKey {
  const normalized = normalizePath(pathname);
  if (normalized === '' || normalized === '/ui') return DEFAULT_PAGE;
  if (normalized === HOOK_UI_PATH) return 'access';
  if (/^\/ui\/access(\/[A-Za-z0-9_-]+)?$/.test(normalized)) return 'access';
  if (/^\/ui\/settings\/[A-Za-z0-9_-]+$/.test(normalized)) return 'settings';
  const match = /^\/ui\/([A-Za-z0-9_-]+)$/.exec(normalized);
  const key = match?.[1];
  if (key !== undefined && PAGE_KEYS.includes(key)) return key as PageKey;
  return DEFAULT_PAGE;
}

/** `/ui/access/<section>` → 二级；`/ui/access` 与未知二级回落默认 logs。 */
export function accessSectionFromPath(pathname: string): AccessSection | null {
  const normalized = normalizePath(pathname);
  const match = /^\/ui\/access\/([A-Za-z0-9_-]+)$/.exec(normalized);
  if (match === null) return null;
  const key = match[1];
  return ACCESS_KEYS.includes(key ?? '') ? (key as AccessSection) : DEFAULT_ACCESS_SECTION;
}

/**
 * `/ui/settings/<section>` → 二级。三种情况：
 * - 命中枚举 → 该二级；
 * - **未知 section → 默认二级**（设计 §16.5.1：跳去图谱会让人以为自己点错了）；
 * - 不是设置二级路径（含 `/ui/settings` 本身）→ null，由调用方按默认二级处理。
 *
 * 已删掉的 `access-logs` 不在枚举里，按未知 section 归 `config`（不为旧方案做兼容）。
 */
export function sectionFromPath(pathname: string): SettingsSection | null {
  const normalized = normalizePath(pathname);
  const match = /^\/ui\/settings\/([A-Za-z0-9_-]+)$/.exec(normalized);
  const key = match?.[1];
  if (key === undefined) return null;
  return SECTION_KEYS.includes(key) ? (key as SettingsSection) : DEFAULT_SETTINGS_SECTION;
}

/** `/ui/hook` 与其查询串 → 独立整页。`?from=magpie` 的连接语义在服务端（server.ts）。 */
export function isStandaloneHook(pathname: string): boolean {
  return normalizePath(pathname) === HOOK_UI_PATH;
}

export function parseRoute(pathname: string, search: string): RouteInfo {
  const params = new URLSearchParams(search);
  const page = pageFromPath(pathname);
  const standalone = isStandaloneHook(pathname) ? 'hook' : null;
  const section: SettingsSection | null =
    page === 'settings' ? (sectionFromPath(pathname) ?? DEFAULT_SETTINGS_SECTION) : null;
  const accessSection: AccessSection | null =
    page === 'access'
      ? standalone === 'hook'
        ? 'endpoints'
        : (accessSectionFromPath(pathname) ?? DEFAULT_ACCESS_SECTION)
      : null;
  return {
    page,
    section,
    accessSection,
    standalone,
    factId: nonEmpty(params.get('fact')),
    canonicalKey: nonEmpty(params.get('canonical_key')),
    focusId: nonEmpty(params.get('focus')),
    query: nonEmpty(params.get('q')) ?? '',
  };
}

/** 只把 `token` 带过页面导航（dev 模式从 `?token=` 进入时刷新/跳页不丢鉴权）。 */
function tokenOf(currentSearch: string): string | null {
  return nonEmpty(new URLSearchParams(currentSearch).get('token'));
}

function hrefWith(path: string, entries: readonly (readonly [string, string])[]): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.set(key, value);
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

/** 左侧导航目标：保留 token，丢掉其它页面参数（筛选/深链不该跨页泄漏）。 */
export function pageHref(page: PageKey, currentSearch = ''): string {
  const token = tokenOf(currentSearch);
  return hrefWith(`/ui/${page}`, token === null ? [] : [['token', token]]);
}

/** 设置二级导航目标（与 `pageHref` 同口径：只带 token）。 */
export function settingsHref(section: SettingsSection, currentSearch = ''): string {
  const token = tokenOf(currentSearch);
  return hrefWith(`/ui/settings/${section}`, token === null ? [] : [['token', token]]);
}

/** 接入二级导航目标（与 `pageHref` 同口径：只带 token）。 */
export function accessHref(section: AccessSection, currentSearch = ''): string {
  const token = tokenOf(currentSearch);
  return hrefWith(`/ui/access/${section}`, token === null ? [] : [['token', token]]);
}

/** 任意站内路径 + 只保留 token（树节点子项共用）。 */
export function hrefForPath(path: string, currentSearch = ''): string {
  const token = tokenOf(currentSearch);
  return hrefWith(path, token === null ? [] : [['token', token]]);
}

/** 左侧菜单树的一个子节点（设置二级 / 接入二级） */
export interface NavChild {
  key: string;
  labelKey: DictKey;
  path: string;
}

/** 左侧菜单树的一个节点：有 children 的节点可展开（设置） */
export interface NavNode {
  key: PageKey;
  labelKey: DictKey;
  path: string;
  titleKey: DictKey;
  children?: readonly NavChild[];
}

/**
 * 菜单树（设计 §16.5.2，用户 m01506 要求「左侧菜单树展开」）。
 *
 * 展开态由 URL 驱动，不落 localStorage：在设置下（`page==='settings'`）就展开，
 * 离开就收起——「URL 是唯一真相源」（本文件头）。
 */
export const NAV: readonly NavNode[] = PAGES.map((page) => {
  if (page.key === 'settings') {
    return {
      key: page.key,
      labelKey: page.labelKey,
      path: page.path,
      titleKey: page.titleKey,
      children: SETTINGS_SECTIONS.map((section) => ({
        key: section.key,
        labelKey: section.labelKey,
        path: section.path,
      })),
    };
  }
  if (page.key === 'access') {
    return {
      key: page.key,
      labelKey: page.labelKey,
      path: page.path,
      titleKey: page.titleKey,
      children: ACCESS_SECTIONS.map((section) => ({
        key: section.key,
        labelKey: section.labelKey,
        path: section.path,
      })),
    };
  }
  return { key: page.key, labelKey: page.labelKey, path: page.path, titleKey: page.titleKey };
});

/** 顶部搜索回车目标：`/ui/memories?q=<输入>`。 */
export function memoriesHref(query: string, currentSearch = ''): string {
  const token = tokenOf(currentSearch);
  const entries: (readonly [string, string])[] = token === null ? [] : [['token', token]];
  const q = query.trim();
  if (q !== '') entries.push(['q', q]);
  return hrefWith('/ui/memories', entries);
}

/**
 * 选中态 → 地址栏（`?focus=` 双向同步用）：`history.replaceState` 的目标 URL。
 *
 * 保留 pathname 上的其它参数（`token`、`view`、`limit`…），只增删 `focus`；
 * `id === null` 表示取消选中，删除该参数。与 `parseRoute` 构成 URL ↔ 选中态往返。
 */
export function focusHref(pathname: string, search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id === null) params.delete('focus');
  else params.set('focus', id);
  const qs = params.toString();
  return qs === '' ? pathname : `${pathname}?${qs}`;
}

/** 搜索建议点一条：跳到记忆页并选中该事实（深链 `?fact=`）。 */
export function factHref(id: string, currentSearch = ''): string {
  const token = tokenOf(currentSearch);
  return hrefWith('/ui/memories', [
    ...(token === null ? [] : ([['token', token]] as const)),
    ['fact', id],
  ]);
}

/** 队列单页上限：与 `/api/queues/*` 的 MAX_LIMIT 对齐（角标是按此估算的，不是精确 total）。 */
export const QUEUE_PAGE_LIMIT = 200;

export interface QueueBadge {
  /** 三队列条数之和；有队列打满一页时是下界 */
  total: number;
  /** 是否有队列达到单页上限（此时 total 只是下界） */
  capped: boolean;
  /** 角标显示文本：不满一页用精确值，打满用 `N+` */
  label: string;
}

/**
 * 待办角标 N = resolve + lowconf + prune。
 *
 * 后端三个 GET 只回 `items`、没有 `total`（`routes/queues.ts`），D-89 又不许改契约，
 * 所以只能按单页上限估算：任一队列打满 200 条时显示 `N+`，不假装是精确总数。
 */
export function queueBadge(counts: readonly number[], cap = QUEUE_PAGE_LIMIT): QueueBadge {
  let total = 0;
  let capped = false;
  for (const n of counts) {
    total += Math.max(0, Math.floor(n));
    if (n >= cap) capped = true;
  }
  return { total, capped, label: capped ? `${String(total)}+` : String(total) };
}

/** 决定 `/` 快捷键是否该让位给输入：焦点在可编辑元素里时不能抢字符。 */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** `/` 唤起搜索：不带 Ctrl/Alt/Meta（`Ctrl+/` 是浏览器/编辑器快捷键）。 */
export function isSearchShortcut(event: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): boolean {
  if (event.key !== '/') return false;
  return event.ctrlKey !== true && event.altKey !== true && event.metaKey !== true;
}

export type LightState = 'ok' | 'warn' | 'off' | 'error';

export interface StatusLight {
  key: 'daemon' | 'sidecar' | 'vector';
  labelKey: DictKey;
  state: LightState;
  /** 灯旁的一句话（key + 变量）；hover title 与无障碍文本都用它 */
  textKey: DictKey;
  textVars?: Readonly<Record<string, string | number>>;
}

/** `GET /api/status` 的最小读取契约（server.ts 内联路由，字段全可选）。 */
export interface DaemonStatus {
  daemon?: unknown;
  sidecar?: { state?: unknown; mode?: unknown };
  vector?: { state?: unknown; indexed?: unknown; total?: unknown };
  fts?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 三灯 = daemon 存活 / sidecar / 向量（或模型）。
 *
 * 状态数据缺失一律显式降级（「未连接」「未配置」「未知」），不把 undefined 渲染成亮灯——
 * 灯是用来区分"坏了"和"没配"的，不能两个都绿。
 */
export function statusLights(status: DaemonStatus | null): StatusLight[] {
  const daemon = status === null ? null : asString(status.daemon);
  const sidecarState = status?.sidecar === undefined ? null : asString(status.sidecar.state);
  const sidecarMode = status?.sidecar === undefined ? null : asString(status.sidecar.mode);
  const vectorState = status?.vector === undefined ? null : asString(status.vector.state);
  const indexed = asCount(status?.vector?.indexed);
  const total = asCount(status?.vector?.total);

  const daemonLight: StatusLight =
    daemon === 'ok'
      ? { key: 'daemon', labelKey: 'light.daemon.label', state: 'ok', textKey: 'light.daemon.ok' }
      : {
          key: 'daemon',
          labelKey: 'light.daemon.label',
          state: 'error',
          textKey: status === null ? 'light.daemon.error' : 'light.daemon.abnormal',
          ...(status === null ? {} : { textVars: { state: daemon ?? 'unknown' } }),
        };

  let sidecarLight: StatusLight;
  if (sidecarState === null) {
    sidecarLight = { key: 'sidecar', labelKey: 'light.sidecar.label', state: 'off', textKey: 'light.sidecar.unset' };
  } else if (sidecarMode === 'off') {
    sidecarLight = { key: 'sidecar', labelKey: 'light.sidecar.label', state: 'off', textKey: 'light.sidecar.off' };
  } else if (sidecarState === 'ready') {
    sidecarLight = { key: 'sidecar', labelKey: 'light.sidecar.label', state: 'ok', textKey: 'light.sidecar.ready' };
  } else if (sidecarState === 'starting') {
    sidecarLight = { key: 'sidecar', labelKey: 'light.sidecar.label', state: 'warn', textKey: 'light.sidecar.starting' };
  } else if (sidecarState === 'failed') {
    sidecarLight = { key: 'sidecar', labelKey: 'light.sidecar.label', state: 'error', textKey: 'light.sidecar.failed' };
  } else {
    // 后端给了没登记的 state：原样透出（不翻译），标 off 而不是假装正常
    sidecarLight = {
      key: 'sidecar',
      labelKey: 'light.sidecar.label',
      state: 'off',
      textKey: 'light.sidecar.other',
      textVars: { state: sidecarState },
    };
  }

  let vectorLight: StatusLight;
  if (vectorState === 'on') {
    const hasCounts = indexed !== null && total !== null;
    vectorLight = {
      key: 'vector',
      labelKey: 'light.vector.label',
      state: total !== null && total > 0 && indexed === 0 ? 'warn' : 'ok',
      textKey: hasCounts ? 'light.vector.indexed' : 'light.vector.enabled',
      ...(hasCounts ? { textVars: { indexed: indexed ?? 0, total: total ?? 0 } } : {}),
    };
  } else if (vectorState === 'off') {
    vectorLight = { key: 'vector', labelKey: 'light.vector.label', state: 'off', textKey: 'light.vector.off' };
  } else {
    vectorLight = { key: 'vector', labelKey: 'light.vector.label', state: 'warn', textKey: 'light.vector.unknown' };
  }

  return [daemonLight, sidecarLight, vectorLight];
}

/** 灯色（inline 风格沿用现状，P2-19-B 再统一 token）。 */
export function lightColor(state: LightState): string {
  if (state === 'ok') return 'var(--color-success)';
  if (state === 'warn') return 'var(--color-warning)';
  if (state === 'error') return 'var(--color-danger)';
  return 'var(--color-text-faint)';
}
