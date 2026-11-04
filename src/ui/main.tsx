/**
 * 五个一级页面的 React 入口（P2-19-A，概设 §8.1 / 详设 §10.1）。
 *
 * 分派按 pathname：`pageFromPath` 把 `/ui/graph|memories|inbox|archive|settings` 映射到
 * 页面，`/ui` 与未知路径回落到图谱（服务端已把 `/ui` 302 到 `/ui/graph`）。仍不引路由库
 * （概设 §8.9），URL 是唯一真相源；`Shell` 负责常驻导航/搜索/三灯，页面组件只填 `<main>`。
 */
import './styles/app.css';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchGraph, resolveToken, type GraphPayload } from './api.js';
import { ArchivePage } from './archive/ArchivePage.js';
import { MemoriesPage } from './memories/MemoriesPage.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { Shell } from './shell/Shell.js';
import { focusHref, parseRoute, type RouteInfo } from './shell/pure.js';
import { Graph2D, type Graph2DStats } from './graph/Graph2D.js';
import { Graph3D, type GraphStats } from './graph/Graph3D.js';
import { buildActivity, pickAccessRise } from './graph/pure/activity.js';
import { ACTIVITY_TTL_MS } from './graph/pure/encoding.js';
import { traceSummary } from './graph/pure/trace.js';
import { HistoryPanel } from './history/HistoryPanel.js';
import { InboxPage } from './inbox/InboxPage.js';
import { useActivity } from './state/activity.js';
import { refreshLatestTrace, useTrace } from './state/trace.js';
import { useFilter } from './state/filter.js';
import { useSelection } from './state/selection.js';
import { FilterBar } from './filter/FilterBar.js';
import { FactsTable } from './table/FactsTable.js';
import { Inspector } from './inspector/Inspector.js';

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

/** 三个视图按钮：标题 / 说明都在这里，避免 JSX 里再写一遍三元 */
const VIEWS: readonly { v: View; label: string; title: string; tag: string }[] = [
  { v: '3d', label: '3D', title: '3D 发现视图：拖动旋转、点击选中', tag: '3D / §10.3' },
  { v: '2d', label: '2D', title: '2D 确认视图：看清拓扑、精确点选', tag: '2D / §8.7' },
  { v: 'table', label: '表格', title: '表格视图：游标分页 + 虚拟滚动（10k 行首屏 < 500ms）', tag: '表格 / §10.8' },
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
  return (
    <span style={{ marginRight: 14, whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span> <span style={{ color: 'var(--color-text-primary)' }}>{value}</span>
    </span>
  );
}

function switchStyle(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--color-bg-hover)' : 'var(--color-bg-raised)',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    border: `1px solid ${active ? 'var(--color-border-strong)' : 'var(--color-border-subtle)'}`,
    borderRadius: 4,
    padding: '2px 10px',
    cursor: active ? 'default' : 'pointer',
    font: 'inherit',
  };
}

const buttonStyle: CSSProperties = {
  background: 'var(--color-bg-overlay)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 4,
  padding: '2px 10px',
  cursor: 'pointer',
  font: 'inherit',
};

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
  const snapshot = useActivity((s) => s.snapshot);
  const hitId = useActivity((s) => s.hitId);
  const hitAt = useActivity((s) => s.hitAt);
  const live = snapshot !== null;
  const now = useNow(live);
  if (snapshot === null || hitId === null) {
    return (
      <div style={{ color: 'var(--color-text-faint)' }}>
        当前无活跃调用 · 画布默认沉默（点一个节点 = 一次命中，亮 4–6 秒）
      </div>
    );
  }
  const ageMs = Math.max(now - hitAt, 0);
  const seconds = (ageMs / 1000).toFixed(1);
  const expired = ageMs >= ACTIVITY_TTL_MS;
  const truncated =
    snapshot.truncatedNodes > 0 || snapshot.truncatedEdges > 0
      ? `（已截断 ${snapshot.truncatedNodes} 节点 / ${snapshot.truncatedEdges} 边，上限 64 / 256）`
      : '';
  return (
    <div style={{ color: expired ? 'var(--color-text-faint)' : 'var(--color-text-secondary)' }}>
      最近调用：命中 {snapshot.activeNodes} 条（1 跳）+ {snapshot.activeEdges} 条边 ·{' '}
      {expired ? `已回落（${seconds} 秒前）` : `${seconds} 秒前`}
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
  const trace = useTrace((s) => s.trace);
  const error = useTrace((s) => s.error);
  const mode = useTrace((s) => s.mode);
  const replayId = useTrace((s) => s.queryId);
  const summary = traceSummary(trace);
  if (summary === null) {
    return (
      <div style={{ color: 'var(--color-text-faint)' }}>
        证据链：无{error === null ? '' : `（${error}）`} · 查询一次后自动显示「直击 / 1 跳 / 2+ 跳」
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', color: 'var(--color-text-secondary)' }}>
      <span style={{ color: mode === 'replay' ? 'var(--color-warning)' : 'var(--color-text-faint)' }}>
        {mode === 'replay' ? `回放 ${replayId === null ? '' : replayId.slice(-8)}` : '实时'}
      </span>
      <span style={{ color: 'var(--color-text-secondary)' }}>证据链 {summary.query_id.slice(-8)}</span>
      <span>
        {summary.route} · {summary.source}/{summary.model_mode}
      </span>
      <span style={{ color: 'var(--color-text-primary)' }}>● 直击 {summary.direct}（亮节点 + 光晕，不画入射流）</span>
      <span style={{ color: 'var(--color-accent-soft)' }}>→ 1 跳 {summary.hop1}（快流）</span>
      <span style={{ color: 'var(--color-text-muted)' }}>→ 2+ 跳 {summary.hop2}（慢流）</span>
      <span>证据边 {summary.edges}</span>
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
      <button type="button" onClick={() => void preview()} disabled={busy} style={buttonStyle}>
        {busy ? '预览中…' : '预览影响'}
      </button>
      {counts !== null && (
        <span style={{ marginLeft: 8, color: 'var(--color-text-secondary)' }}>
          事实 {counts.facts} · 边 {counts.edges} · 主题 {counts.topics} · 级联失效{' '}
          {counts.invalidated_by_cascade}
        </span>
      )}
      {error !== null && <span style={{ marginLeft: 8, color: 'var(--color-danger)' }}>预览失败：{error}</span>}
    </span>
  );
}

function App({ route }: { route: RouteInfo }): JSX.Element {
  const [data, setData] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats3d, setStats3d] = useState<GraphStats | null>(null);
  const [stats2d, setStats2d] = useState<Graph2DStats | null>(null);
  const [view, setView] = useState<View>(initialView);
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

  const load = useCallback(async (requestLimit: number): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchGraph(requestLimit, controller.signal);
      // 事件源②：这一份比上一份多出来的访问计数 = 「刚刚被调用的那条」（详设 §10.3.1 / D-89）。
      // 首屏没有上一份 → `pickAccessRise` 返回 null，不点亮任何东西（默认沉默）。
      const rise = pickAccessRise(prevNodesRef.current, payload.nodes);
      prevNodesRef.current = payload.nodes;
      dataRef.current = payload;
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

  useEffect(() => {
    // 表格视图自己走 `/api/facts`（游标分页），这里不拉图：深链 `?view=table` 的
    // 首屏预算（< 500ms）不该被 1000 节点 / 3000 边的 `/api/graph` 占掉。
    if (view === 'table') return;
    // 图数据还在 → 切回来直接复用（表格卸载时并没有清空 data）
    if (dataRef.current !== null) return;
    void load(initialLimit());
  }, [view, load]);

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
  const [focusNote, setFocusNote] = useState<string | null>(null);
  useEffect(() => {
    if (route.focusId === null || data === null) {
      setFocusNote(null);
      return;
    }
    if (data.nodes.some((node) => node.id === route.focusId)) {
      setFocusNote(null);
      return;
    }
    useSelection.getState().clear();
    setFocusNote(`深链 focus=${route.focusId} 不在当前图中（limit=${limit}），已取消选中`);
  }, [data, route.focusId, limit]);

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
  const tag = VIEWS.find((v) => v.v === view)?.tag ?? '3D / §10.3';
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
      {!isTable && data !== null && (is2d ? <Graph2D data={data} onStats={setStats2d} /> : <Graph3D data={data} onStats={setStats3d} />)}

      {/* 检查器（P2-06）：右侧抽屉，三视图共用 focusId（表格行 / 3D / 2D 点选都写同一个 store） */}
      <Inspector />

      {/* 历史查询（P2-26）：点一条回放；回放期间实时轮询静默，不把回放顶掉 */}
      {!isTable && <HistoryPanel />}

      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '10px 14px',
          background: isTable ? 'transparent' : 'linear-gradient(180deg, color-mix(in srgb, var(--color-bg-base) 92%, transparent), transparent)',
          pointerEvents: 'none',
          fontSize: 12,
          lineHeight: 1.7,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, color: 'var(--color-text-primary)', letterSpacing: 1 }}>
            默识 · 记忆图谱{' '}
            <span style={{ color: 'var(--color-text-faint)', fontSize: 12 }}>{tag}</span>
          </div>
          <span style={{ pointerEvents: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {VIEWS.map((item) => (
              <button
                key={item.v}
                type="button"
                onClick={() => showView(item.v)}
                disabled={view === item.v}
                aria-pressed={view === item.v}
                title={item.title}
                style={switchStyle(view === item.v)}
              >
                {item.label}
              </button>
            ))}
          </span>
        </div>
        {/* 筛选条：三视图共享同一份状态（详设 §10.2），URL 是唯一真相源，写 URL 可分享可回退 */}
        <div style={{ pointerEvents: 'auto', marginTop: 6 }}>
          <FilterBar />
        </div>
        {/* 表格态的状态栏在表格自己的底栏里（行数 / 请求数 / fps 钩子），HUD 不再重复 */}
        {!isTable && (
          <div>
            <Badge label="节点" value={meta === undefined ? '—' : `${meta.returned_nodes} / ${meta.total_nodes}`} />
            <Badge label="边" value={meta === undefined ? '—' : `${meta.returned_edges} / ${meta.total_edges}`} />
            {!is2d && (
              <Badge
                label="draw calls"
                value={stats3d === null ? '—' : String(stats3d.renderCalls)}
              />
            )}
            <Badge label="fps" value={fps === undefined ? '—' : fps.toFixed(1)} />
            {!is2d && <Badge label="标签" value={stats3d === null ? '—' : String(stats3d.labelCount)} />}
            {is2d && <Badge label="选中" value={stats2d === null ? '—' : (stats2d.selectedId ?? '—')} />}
            <span style={{ pointerEvents: 'auto' }}>
              <button type="button" onClick={() => void load(limit)} style={buttonStyle}>
                {loading ? '加载中…' : '刷新'}
              </button>
              {meta !== undefined && meta.returned_nodes < meta.total_nodes && (
                <button
                  type="button"
                  onClick={() => void load(FULL_LIMIT)}
                  style={{ ...buttonStyle, background: 'var(--color-bg-raised)', color: 'var(--color-warning)', border: '1px solid var(--color-warning-dim)', marginLeft: 6 }}
                >
                  加载全量（{FULL_LIMIT}）
                </button>
              )}
              {selectedIds.size >= 2 && <ImpactPreview ids={[...selectedIds]} />}
            </span>
          </div>
        )}
        {!isTable && meta !== undefined && meta.truncated && (
          <div style={{ color: 'var(--color-warning)' }}>
            结果被截断：只返回了 {meta.returned_nodes} / {meta.total_nodes} 个节点（limit={meta.limit}）。
            点「加载全量」一次取满（{FULL_LIMIT}），或用 `?limit=` / cursor 分批取。
          </div>
        )}
        {!isTable && meta !== undefined && meta.nodes_without_layout > 0 && (
          <div style={{ color: 'var(--color-text-muted)' }}>
            另有 {meta.nodes_without_layout} 个活跃事实还没有 layout 坐标，未参与绘制。
          </div>
        )}
        {!isTable && error !== null && <div style={{ color: 'var(--color-danger)' }}>取数失败：{error}</div>}
        {!isTable && focusNote !== null && (
          <div style={{ color: 'var(--color-warning)' }} data-testid="focus-miss">
            {focusNote}
          </div>
        )}
        {!isTable && <ActivityNote />}
        {!isTable && <TraceNote />}
      </div>

      {/* 表格态的操作提示由表格自己的底栏承担（那边还有行数/请求数），这里不再叠一层 */}
      {!isTable && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 14,
            color: 'var(--color-text-faint)',
            fontSize: 11,
            pointerEvents: 'none',
          }}
        >
          {is2d
            ? '拖动平移 · 滚轮缩放 · 点击节点 = 选中（放大 + 常显标签） · 点空白取消选中 · 空白处拖框 = 框选（Shift 合并、Esc 清空） · 坐标取布局表的 (x, z)，前端不跑布局'
            : '拖动旋转 · 滚轮缩放 · 点击节点 = 选中（放大 + 常显标签） · 标签只在活跃层、且离相机比整图半径更近时出现 · Y 四层 = strength'}
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

  return (
    <Shell route={route.page}>
      {route.page === 'graph' ? <App route={route} /> : null}
      {route.page === 'memories' ? <MemoriesPage route={route} /> : null}
      {route.page === 'inbox' ? <InboxPage /> : null}
      {route.page === 'archive' ? <ArchivePage /> : null}
      {route.page === 'settings' ? <SettingsPage /> : null}
    </Shell>
  );
}

const host = document.getElementById('root');
if (host === null) throw new Error('#root not found');
createRoot(host).render(<Root />);
