/**
 * React 入口（P2-19-A 起；Z-01C-g 加接入页与设置二级）。
 *
 * 分派按 pathname（不引路由库，概设 §8.9，URL 是唯一真相源）：
 * - `/ui/graph|memories|inbox|archive` → 四个一级页；
 * - `/ui/settings` 与 `/ui/settings/<二级>` → `SettingsPage`（二级由 URL 决定，默认配置）；
 * - `/ui/access` → `LogsPage` / `EndpointsPage`（按二级；P4；「日志与保留」按用户 m01083 改为日志页弹框，不再是二级）；
 *   `/ui/hook` → `AccessPage` 独立整页（设计 §16.5.5）。
 *
 * `Shell` 负责常驻导航/搜索/三灯，页面组件只填 `<main>`。
 */
import './styles/app.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchGraph, resolveToken, type GraphPayload } from './api.js';
import { AccessPage } from './access/AccessPage.js';
import { EndpointsPage } from './access/EndpointsPage.js';
import { LogsPage } from './access/LogsPage.js';
import { ArchivePage } from './archive/ArchivePage.js';
import { MemoriesPage } from './memories/MemoriesPage.js';
import { RecallPage } from './recall/RecallPage.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { Shell } from './shell/Shell.js';
import { AdminDirectBadge } from './shell/AdminDirectBadge.js';
import {
  DEFAULT_SETTINGS_SECTION,
  focusHref,
  parseRoute,
  type RouteInfo,
} from './shell/pure.js';
import { Graph2D, type Graph2DStats } from './graph/Graph2D.js';
import { Graph3D, type GraphStats } from './graph/Graph3D.js';
import { buildActivity, pickAccessRise } from './graph/pure/activity.js';
import { ACTIVITY_TTL_MS } from './graph/pure/encoding.js';
import { traceSummary } from './graph/pure/trace.js';
import { HistoryPanel } from './history/HistoryPanel.js';
import { InboxPage } from './inbox/InboxPage.js';
import { useActivity } from './state/activity.js';
import { refreshLatestTrace, useTrace } from './state/trace.js';
import { resetPaletteCache } from './graph/pure/palette.js';
import { applyMode, storedMode, subscribeMode, watchSystem } from './theme.js';
import { useFilter } from './state/filter.js';
import { useSelection } from './state/selection.js';
import { FilterBar } from './filter/FilterBar.js';
import { FactsTable } from './table/FactsTable.js';
import { Inspector } from './inspector/Inspector.js';
import { useT } from './i18n/index.js';
import type { DictKey } from './i18n/dict.js';

/**
 * 首屏默认页大小：与服务端 `DEFAULT_GRAPH_LIMIT` 对齐。
 *
 * 台账 D-75 的规矩是「默认 1000，一次别拉全量」——首屏 1000 只要几十毫秒，
 * 全量 5000（含 15000 边）要多花一个数量级的传输与建对象时间，
 * 所以只在用户显式点「加载全量」或带 `?limit=` 时才请求上限（P2-02 返工 H1）。
 */
const DEFAULT_LIMIT = 1000;
/** 与服务端 `MAX_LIMIT` 对齐；调大只会被服务端夹回上限 */
const FULL_LIMIT = 5000;

type View = '3d' | '2d' | 'table';
const VIEW_KEY = 'view';

/** 三个视图按钮：标题 / 说明都在这里，避免 JSX 里再写一遍三元（V-10 起存 key，渲染时再取文案） */
const VIEWS: readonly { v: View; labelKey: DictKey; titleKey: DictKey; tagKey: DictKey }[] = [
  { v: '3d', labelKey: 'graph.view.d3.label', titleKey: 'graph.view.d3.title', tagKey: 'graph.view.d3.tag' },
  { v: '2d', labelKey: 'graph.view.d2.label', titleKey: 'graph.view.d2.title', tagKey: 'graph.view.d2.tag' },
  { v: 'table', labelKey: 'graph.view.table.label', titleKey: 'graph.view.table.title', tagKey: 'graph.view.table.tag' },
];

function initialLimit(): number {
  const raw = new URLSearchParams(window.location.search).get('limit');
  const n = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), FULL_LIMIT);
}

/** 只认 `view=2d|table`，其余（缺省 / 拼错）一律 3D——深链不该白屏 */
function initialView(): View {
  const raw = new URLSearchParams(window.location.search).get(VIEW_KEY);
  if (raw === '2d') return '2d';
  if (raw === 'table') return 'table';
  return '3d';
}

/** 切视图时保留 `limit` / `token` 等其它参数，只改 `view` */
function viewHref(view: View): string {
  const url = new URL(window.location.href);
  url.searchParams.set(VIEW_KEY, view);
  return `${url.pathname}${url.search}${url.hash}`;
}

function Badge({ label, value }: { label: string; value: string }): JSX.Element {
  const previous = useRef(value);
  const [flash, setFlash] = useState(false);

  // 数值变化时 150ms 高亮淡出（P2-19-B）：只闪一次，随后回到常态颜色。
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 160);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <span className="graph-readout">
      <span className="graph-readout-key">{label}</span>{' '}
      <span
        className={`moshi-value${flash ? ' moshi-value-flash' : ''}`}
      >
        {value}
      </span>
    </span>
  );
}

/** 活跃态文案要跟着时间走（"3.2 秒前"），所以按 500ms 重渲染一次；沉默时不挂定时器 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * 状态栏的"最近调用"一行（详设 §10.3.1 注脚）。
 *
 * 沉默时必须显式写出来：不发光的图看起来像坏了/像随机闪烁，一句"当前无活跃调用"是
 * 那条闪烁的因果关系。活跃时必须带条数与时间，否则用户不知道亮的是谁引起的。
 */
function ActivityNote(): JSX.Element {
  const t = useT();
  const snapshot = useActivity((s) => s.snapshot);
  const hitId = useActivity((s) => s.hitId);
  const hitAt = useActivity((s) => s.hitAt);
  const live = snapshot !== null;
  const now = useNow(live);
  if (snapshot === null || hitId === null) {
    return (
      <div className="graph-notice" data-tone="muted">{t('graph.activity.idle')}</div>
    );
  }
  const ageMs = Math.max(now - hitAt, 0);
  const seconds = (ageMs / 1000).toFixed(1);
  const expired = ageMs >= ACTIVITY_TTL_MS;
  const truncated =
    snapshot.truncatedNodes > 0 || snapshot.truncatedEdges > 0
      ? t('graph.activity.truncated', { nodes: snapshot.truncatedNodes, edges: snapshot.truncatedEdges })
      : '';
  return (
    <div className="graph-notice" data-tone={expired ? 'muted' : 'live'}>
      {t('graph.activity.hit', { nodes: snapshot.activeNodes, edges: snapshot.activeEdges })}
      {expired ? t('graph.activity.expired', { seconds }) : t('graph.activity.ago', { seconds })}
      {truncated}
    </div>
  );
}

/**
 * 证据链图例（P2-25，详设 §10.3.2）。
 *
 * 三态必须能被文字读出来，不能只靠颜色：
 * - 直击（hop0）：亮节点 + 光晕，**不画入射流动**（证据从这里出发）；
 * - 1 跳：aFlow = 0.6 的快流（种子 → 一跳邻居）；
 * - 2+ 跳：aFlow = 0.3 的慢流 + 相位更滞后（更远、更弱、更晚到）。
 *
 * 无 trace 时明确写「无」：留白会被当成"渲染坏了"，而"还没查询"本是正常状态。
 */
function TraceNote(): JSX.Element {
  const t = useT();
  const trace = useTrace((s) => s.trace);
  const error = useTrace((s) => s.error);
  const mode = useTrace((s) => s.mode);
  const replayId = useTrace((s) => s.queryId);
  const summary = traceSummary(trace);
  if (summary === null) {
    return (
      <div className="graph-notice" data-tone="muted">
        {t('graph.trace.empty', {
            err: error === null ? '' : t('common.paren', { text: error }),
          })}
      </div>
    );
  }
  return (
    <div className="graph-legend">
      <span
        className="graph-legend-mode"
        style={{ color: mode === 'replay' ? 'var(--color-warning)' : 'var(--color-text-faint)' }}
      >
        {mode === 'replay'
          ? t('graph.trace.replay', { id: replayId === null ? '' : replayId.slice(-8) })
          : t('graph.trace.live')}
      </span>
      <span style={{ color: 'var(--color-text-secondary)' }}>
        {t('graph.trace.title', { id: summary.query_id.slice(-8) })}
      </span>
      <span className="graph-legend-sep" aria-hidden="true" />
      <span>
        {summary.route} · {summary.source}/{summary.model_mode}
      </span>
      <span className="moshi-trace-badge" style={{ color: 'var(--color-text-primary)' }}>
        {t('graph.trace.direct', { count: summary.direct })}
      </span>
      <span className="moshi-trace-badge" style={{ color: 'var(--color-accent-soft)' }}>
        {t('graph.trace.hop1', { count: summary.hop1 })}
      </span>
      <span className="moshi-trace-badge" style={{ color: 'var(--color-text-muted)' }}>
        {t('graph.trace.hop2', { count: summary.hop2 })}
      </span>
      <span>{t('graph.trace.edges', { count: summary.edges })}</span>
    </div>
  );
}

/**
 * 批量影响预览入口（P2-19A-18 / 概设 §8.1「框选 → 跳批量影响预览」）。
 *
 * 只在选中 ≥2 个节点时出现；点击后调 `POST /api/facts/batch/preview`（**只预览不执行**），
 * 把 `facts / edges / topics / invalidated_by_cascade` 四个计数摆在 HUD 里。
 * 节点 → fact 的映射：`/api/graph` 的节点 id 本身就是 `fact.id`（`graphRepo` 的
 * `NODE_COLUMNS` 从 fact 表取 id），所以框选出来的 id 集可以直接当 fact id 用，
 * 不必先走 `/api/graph/neighbors` 反查。
 */
interface ImpactPreviewCounts {
  facts: number;
  edges: number;
  topics: number;
  invalidated_by_cascade: number;
}

function ImpactPreview({ ids }: { ids: readonly string[] }): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<ImpactPreviewCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectionKey = ids.join('\u0000');

  // 选中集变了，旧的影响面数字就不再对应当前框选——立刻清掉，不让它冒充新结果
  useEffect(() => {
    setCounts(null);
    setError(null);
  }, [selectionKey]);

  const preview = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/facts/batch/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Moshi-Token': resolveToken() },
        body: JSON.stringify({ action: 'invalidate', ids: [...ids] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
      }
      setCounts((await res.json()) as ImpactPreviewCounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>
      <button type="button" onClick={() => void preview()} disabled={busy} className="btn-quiet">
        {busy ? t('graph.preview.running') : t('graph.preview.title')}
      </button>
      {counts !== null && (
        <span style={{ marginLeft: 8, color: 'var(--color-text-secondary)' }}>
          {t('graph.preview.counts', {
            facts: counts.facts,
            edges: counts.edges,
            topics: counts.topics,
            cascade: counts.invalidated_by_cascade,
          })}
        </span>
      )}
      {error !== null && (
        <span style={{ marginLeft: 8, color: 'var(--color-danger)' }}>{t('graph.preview.error', { error })}</span>
      )}
    </span>
  );
}

function App({ route }: { route: RouteInfo }): JSX.Element {
  const t = useT();
  const [data, setData] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats3d, setStats3d] = useState<GraphStats | null>(null);
  const [stats2d, setStats2d] = useState<Graph2DStats | null>(null);
  const [view, setView] = useState<View>(initialView);
  /** 主题每次切换自增：画布里的颜色是建场景时取的，得重建才跟上新主题 */
  const [themeTick, setThemeTick] = useState(0);
  const [limit, setLimit] = useState<number>(initialLimit);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 上一份数据的访问计数快照：事件源②要拿它比出「谁刚被调用」（首屏为 `null`）。
   *
   * 放在取数处而不是渲染器里：渲染器只负责"给定焦点画什么"，不该自己攒历史、定义
   * "什么算一次调用"；而且一次刷新可能多条 `access_count` 上涨，只有这里才知道
   * 该挑哪一条当主角（`pickAccessRise`：增量最大者，并列取 importance 高者）。
   */
  const prevNodesRef = useRef<GraphPayload['nodes'] | null>(null);
  /**
   * 已拿到的图数据镜像：切到表格再切回来时**不重拉**。
   *
   * 用 ref 而不是依赖 `data` 判断，是为了让取数副作用只挂 `view`：`setData` 不该
   * 反过来触发一次取数（否则刷新按钮每点一次都会自增两轮请求）。
   */
  const dataRef = useRef<GraphPayload | null>(null);
  /** 已拿到的图数据对应的 scope：scope 变了要重拉，切视图回来则复用 */
  const loadedScopeRef = useRef<string | null | undefined>(undefined);
  /** 当前生效的作用域筛选（V-02）：列表与图谱读同一份 */
  const scope = useFilter((s) => s.filter.scope);

  const load = useCallback(async (requestLimit: number, requestScope: string | null): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchGraph(requestLimit, requestScope, controller.signal);
      // 事件源②：这一份比上一份多出来的访问计数 = 「刚刚被调用的那条」（详设 §10.3.1 / D-89）。
      // 首屏没有上一份 → `pickAccessRise` 返回 null，不点亮任何东西（默认沉默）。
      const rise = pickAccessRise(prevNodesRef.current, payload.nodes);
      prevNodesRef.current = payload.nodes;
      dataRef.current = payload;
      loadedScopeRef.current = requestScope;
      setData(payload);
      setLimit(requestLimit);
      if (rise !== null) useActivity.getState().hit(rise);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 主题切换：清掉 palette 的进程内缓存，并让画布重建一次（不动数据、不动筛选）
  useEffect(() => {
    const off = subscribeMode(() => {
      resetPaletteCache();
      setThemeTick((v) => v + 1);
    });
    return off;
  }, []);

  useEffect(() => {
    // 表格视图自己走 `/api/facts`（游标分页），这里不拉图：深链 `?view=table` 的
    // 首屏预算（< 500ms）不该被 1000 节点 / 3000 边的 `/api/graph` 占掉。
    if (view === 'table') return;
    // 图数据还在且 scope 未变 → 切回来直接复用（表格卸载时并没有清空 data）
    if (dataRef.current !== null && loadedScopeRef.current === scope) return;
    void load(initialLimit(), scope);
  }, [view, scope, load]);

  // P2-25：每 3s 拉一次「最近查询」的 trace（daemon 内存 ring buffer，无落库）。
  // 外部查询没有推送通道（D-118 不加 SSE/WebSocket），轮询是唯一能让"刚查完"立刻
  // 出现在图上的办法；`query_id` 没变时 `refreshLatestTrace` 原地不动，渲染器不会被
  // 每 3 秒重建一次 trace 对象。后台标签页跳过，避免无意义的请求。
  useEffect(() => {
    void refreshLatestTrace();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshLatestTrace();
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // 浏览器后退/前进：视图与筛选都跟 URL 走（URL 是唯一真相源，P2-05 验收项）
  useEffect(() => {
    const onPopState = (): void => {
      setView(initialView());
      useFilter.getState().syncFromURL();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const showView = useCallback((next: View): void => {
    setView(next);
    window.history.pushState({ view: next }, '', viewHref(next));
  }, []);

  // P2-19-A 深链：`/ui/graph?focus=<id>` 选中该节点（3D/2D/表格/Inspector 共用 selection）。
  useEffect(() => {
    if (route.focusId === null) return;
    useSelection.getState().select(route.focusId);
  }, [route.focusId]);

  // 选中态 → URL：点节点/表格行/取消选中都走同一个 store，这里用 replaceState 同步
  // `?focus=`（不新增历史条目，后退仍按页面而不是按每次点选回退）。
  const selectedFocusId = useSelection((s) => s.focusId);
  // 框选多选（P2-19A-18）：≥2 个节点时 HUD 出现「预览影响」，把选中 id 当 fact id 传给批量预览
  const selectedIds = useSelection((s) => s.selectedIds);
  useEffect(() => {
    const current = `${window.location.pathname}${window.location.search}`;
    const next = focusHref(window.location.pathname, window.location.search, selectedFocusId);
    if (next !== current) window.history.replaceState(null, '', next);
  }, [selectedFocusId]);

  // 深链有 id 但当前图里没有（被 limit 截掉 / 已删除）→ 取消选中并提示，不装作选中。
  const [focusMiss, setFocusMiss] = useState(false);
  useEffect(() => {
    if (route.focusId === null || data === null) {
      setFocusMiss(false);
      return;
    }
    if (data.nodes.some((node) => node.id === route.focusId)) {
      setFocusMiss(false);
      return;
    }
    useSelection.getState().clear();
    setFocusMiss(true);
  }, [data, route.focusId]);

  // 表格视图的「聚焦」= 选中 + 滚到行；行是虚拟滚动的，等它进 DOM 再滚。
  useEffect(() => {
    if (view !== 'table' || route.focusId === null) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const rows = document.querySelectorAll<HTMLElement>('[role="row"][title]');
      for (const row of rows) {
        if ((row.getAttribute('title') ?? '').endsWith(route.focusId ?? '')) {
          row.scrollIntoView({ block: 'center' });
          window.clearInterval(timer);
          return;
        }
      }
      if (attempts >= 50) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [view, route.focusId]);

  const meta = data?.meta;
  const fps = view === '2d' ? stats2d?.fps : stats3d?.fps;
  const is2d = view === '2d';
  const isTable = view === 'table';
  const tagKey = VIEWS.find((v) => v.v === view)?.tagKey ?? 'graph.view.d3.tag';
  const hitId = useActivity((s) => s.hitId);
  const seq = useActivity((s) => s.seq);

  // 活跃集只算这一次：3D / 2D / 状态栏读的是同一份快照（D-89 的"单一事件源"）。
  // `seq` 进依赖是为了同一节点重复命中时也能刷新 `hitAt`（重置计时，不叠加）。
  useEffect(() => {
    if (data === null) {
      useActivity.getState().setSnapshot(null);
      return;
    }
    const state = useActivity.getState();
    useActivity.getState().setSnapshot(buildActivity(data.nodes, data.edges, state.hitId, state.hitAt));
  }, [data, hitId, seq]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* 表格是第三态：切过去时图整体卸载（不保留 3D 场景、也不保留表格的分页状态） */}
      {isTable && <FactsTable />}
      {!isTable && data !== null && (is2d ? (
        <Graph2D key={themeTick} data={data} onStats={setStats2d} />
      ) : (
        <Graph3D key={themeTick} data={data} onStats={setStats3d} />
      ))}

      {/* 检查器（P2-06）：右侧抽屉，三视图共用 focusId（表格行 / 3D / 2D 点选都写同一个 store） */}
      <Inspector />

      {/* 历史查询（P2-26）：点一条回放；回放期间实时轮询静默，不把回放顶掉 */}
      {!isTable && <HistoryPanel />}

      <div
        className="moshi-hud"
        data-plain={isTable ? 'true' : 'false'}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '16px 22px 12px',
          // 底色见 app.css 的 .moshi-hud：亮色主题下画布是深场，HUD 需要更实的底才读得清
          pointerEvents: 'none',
          fontSize: 12,
          lineHeight: 1.7,
        }}
      >
        <div className="graph-head">
          <div className="graph-head-title">{t('graph.title')}</div>
          <span className="graph-head-tag">{t(tagKey)}</span>
          <span className="graph-switch" style={{ pointerEvents: 'auto' }}>
            {VIEWS.map((item) => (
              <button
                key={item.v}
                type="button"
                onClick={() => showView(item.v)}
                disabled={view === item.v}
                aria-pressed={view === item.v}
                title={t(item.titleKey)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </span>
          <AdminDirectBadge />
          <span style={{ marginLeft: 'auto' }}>
            {loading && <span className="moshi-spinner" data-testid="hud-spinner" role="status" aria-label={t('common.loading')} />}
          </span>
        </div>
        {/* 筛选条：三视图共享同一份状态（详设 §10.2），URL 是唯一真相源，写 URL 可分享可回退 */}
        <div style={{ pointerEvents: 'auto', marginTop: 10 }}>
          <FilterBar />
        </div>
        {/* 表格态的状态栏在表格自己的底栏里（行数 / 请求数 / fps 钩子），HUD 不再重复 */}
        {!isTable && (
          <div>
            <Badge label={t('graph.stat.nodes')} value={meta === undefined ? '—' : `${meta.returned_nodes} / ${meta.total_nodes}`} />
            <Badge label={t('graph.stat.edges')} value={meta === undefined ? '—' : `${meta.returned_edges} / ${meta.total_edges}`} />
            {!is2d && (
              <Badge
                label="draw calls"
                value={stats3d === null ? '—' : String(stats3d.renderCalls)}
              />
            )}
            <Badge label="fps" value={fps === undefined ? '—' : fps.toFixed(1)} />
            {!is2d && <Badge label={t('graph.stat.labels')} value={stats3d === null ? '—' : String(stats3d.labelCount)} />}
            {is2d && <Badge label={t('graph.stat.selected')} value={stats2d === null ? '—' : (stats2d.selectedId ?? '—')} />}
            <span style={{ pointerEvents: 'auto' }}>
              <button type="button" onClick={() => void load(limit, scope)} className="btn-quiet">
                {loading ? t('common.loading') : t('graph.refresh')}
              </button>
              {meta !== undefined && meta.returned_nodes < meta.total_nodes && (
                <button
                  type="button"
                  onClick={() => void load(FULL_LIMIT, scope)}
                  className="btn-quiet graph-loadall"
                >
                  {t('graph.loadAll', { limit: FULL_LIMIT })}
                </button>
              )}
              {selectedIds.size >= 2 && <ImpactPreview ids={[...selectedIds]} />}
            </span>
          </div>
        )}
        {!isTable && meta !== undefined && meta.truncated && (
          <div className="graph-notice" data-tone="warn">
            {t('graph.truncated', {
              returned: meta.returned_nodes,
              total: meta.total_nodes,
              limit: meta.limit,
              full: FULL_LIMIT,
            })}
          </div>
        )}
        {!isTable && meta !== undefined && meta.nodes_without_layout > 0 && (
          <div className="graph-notice" data-tone="muted">
            {t('graph.noLayout', { count: meta.nodes_without_layout })}
          </div>
        )}
        {!isTable && error !== null && <div className="graph-notice" data-tone="danger">{t('graph.loadError', { error })}</div>}
        {!isTable && focusMiss && (
          <div className="graph-notice" data-tone="warn" data-testid="focus-miss">
            {t('graph.focusMiss', { focus: route.focusId ?? '', limit })}
          </div>
        )}
        {!isTable && <ActivityNote />}
        {!isTable && <TraceNote />}
      </div>

      {/* 舞台取景器（四角准星 + 顶部刻度尺）由 Graph2D/Graph3D 自己挂进画布 host：
          放在 page 层级会被 HUD 盖住顶边，且切图时位置会跳 */}

      {/* 表格态的操作提示由表格自己的底栏承担（那边还有行数/请求数），这里不再叠一层 */}
      {!isTable && (
        <div
          className="moshi-stage-note"
          style={{
            position: 'absolute',
            bottom: 8,
            left: 14,
            fontSize: 11,
            pointerEvents: 'none',
          }}
        >
          {is2d ? t('graph.help.d2') : t('graph.help.d3')}
        </div>
      )}
    </div>
  );
}

/**
 * 解析当前 URL；`?canonical_key=` 在记忆页归一到 `?q=`（`/api/facts` 没有该筛选参数，
 * 见 `MemoriesPage` 的页内说明）。归一是 replaceState：不产生额外历史、不打断后退。
 */
function currentRoute(): RouteInfo {
  let route = parseRoute(window.location.pathname, window.location.search);
  if (route.page === 'memories' && route.canonicalKey !== null && route.query === '') {
    const url = new URL(window.location.href);
    url.searchParams.set('q', route.canonicalKey);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    route = parseRoute(url.pathname, url.search);
  }
  return route;
}

function Root(): JSX.Element {
  const [route, setRoute] = useState<RouteInfo>(currentRoute);

  useEffect(() => {
    const onPopState = (): void => {
      useFilter.getState().syncFromURL();
      setRoute(currentRoute());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 首启弹窗装完会跳 `/ui/hook?from=onboard&result=ok|fail`（§16.4 第 4 步）
  const onboardResult = onboardResultOf(window.location.search);
  const standalone = route.standalone === 'hook';

  return (
    <Shell route={route.page} section={route.section} accessSection={route.accessSection}>
      {standalone ? <AccessPage standalone onboardResult={onboardResult} /> : null}
      {!standalone && route.page === 'graph' ? <App route={route} /> : null}
      {!standalone && route.page === 'recall' ? <RecallPage /> : null}
      {!standalone && route.page === 'memories' ? <MemoriesPage route={route} /> : null}
      {!standalone && route.page === 'inbox' ? <InboxPage /> : null}
      {!standalone && route.page === 'archive' ? <ArchivePage /> : null}
      {!standalone && route.page === 'access' && route.accessSection === 'endpoints' ? <EndpointsPage /> : null}
      {!standalone && route.page === 'access' && route.accessSection === 'logs' ? <LogsPage /> : null}
      {!standalone && route.page === 'settings' ? (
        <SettingsPage section={route.section ?? DEFAULT_SETTINGS_SECTION} />
      ) : null}
    </Shell>
  );
}

/** `?from=onboard&result=ok|fail` → 结果条；其它来源一律 null（不显示任何结果条）。 */
function onboardResultOf(search: string): 'ok' | 'fail' | null {
  const params = new URLSearchParams(search);
  if (params.get('from') !== 'onboard') return null;
  const result = params.get('result');
  return result === 'ok' || result === 'fail' ? result : null;
}

const host = document.getElementById('root');
if (host === null) throw new Error('#root not found');
// 首屏把主题落到 <html> 上（index.html 已经先做过一次，这里接管系统偏好变化）
applyMode(storedMode());
watchSystem();

createRoot(host).render(<Root />);
