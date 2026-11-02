/**
 * `/ui/graph` 的 React 入口。
 *
 * 职责只有"取数 + 视图切换 + 状态栏"：图怎么画全在 `graph/Graph3D.tsx` 与
 * `graph/Graph2D.tsx`，坐标全在 `/api/graph`，这里一行布局计算都没有（概设 §8.9 纪律 1）。
 *
 * 视图（`?view=3d|2d`）写回 URL：刷新与分享都不丢（P2-03 验收项）。
 * 表格视图是 P2-04，这里只放一个不可点的占位说明。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchGraph, type GraphPayload } from './api.js';
import { Graph2D, type Graph2DStats } from './graph/Graph2D.js';
import { Graph3D, type GraphStats } from './graph/Graph3D.js';
import { buildActivity, pickAccessRise } from './graph/pure/activity.js';
import { ACTIVITY_TTL_MS } from './graph/pure/encoding.js';
import { useActivity } from './state/activity.js';

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

type View = '3d' | '2d';
const VIEW_KEY = 'view';

function initialLimit(): number {
  const raw = new URLSearchParams(window.location.search).get('limit');
  const n = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), FULL_LIMIT);
}

/** 只认 `view=2d`，其余（缺省 / 拼错 / 未来的 view=table）一律 3D——深链不该白屏 */
function initialView(): View {
  return new URLSearchParams(window.location.search).get(VIEW_KEY) === '2d' ? '2d' : '3d';
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
      <span style={{ color: '#64748b' }}>{label}</span> <span style={{ color: '#e2e8f0' }}>{value}</span>
    </span>
  );
}

function switchStyle(active: boolean): CSSProperties {
  return {
    background: active ? '#1e293b' : '#0b1220',
    color: active ? '#f8fafc' : '#94a3b8',
    border: `1px solid ${active ? '#334155' : '#1f2937'}`,
    borderRadius: 4,
    padding: '2px 10px',
    cursor: active ? 'default' : 'pointer',
    font: 'inherit',
  };
}

const buttonStyle: CSSProperties = {
  background: '#111827',
  color: '#cbd5e1',
  border: '1px solid #1f2937',
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
      <div style={{ color: '#475569' }}>
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
    <div style={{ color: expired ? '#475569' : '#94a3b8' }}>
      最近调用：命中 {snapshot.activeNodes} 条（1 跳）+ {snapshot.activeEdges} 条边 ·{' '}
      {expired ? `已回落（${seconds} 秒前）` : `${seconds} 秒前`}
      {truncated}
    </div>
  );
}

function App(): JSX.Element {
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
    void load(initialLimit());
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  // 浏览器后退/前进回到上一个视图：URL 是唯一真相源，状态跟着它走
  useEffect(() => {
    const onPopState = (): void => {
      setView(initialView());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const showView = useCallback((next: View): void => {
    setView(next);
    window.history.pushState({ view: next }, '', viewHref(next));
  }, []);

  const meta = data?.meta;
  const fps = view === '2d' ? stats2d?.fps : stats3d?.fps;
  const is2d = view === '2d';
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
      {data !== null &&
        (is2d ? <Graph2D data={data} onStats={setStats2d} /> : <Graph3D data={data} onStats={setStats3d} />)}

      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '10px 14px',
          background: 'linear-gradient(180deg, rgba(5,7,13,0.92), rgba(5,7,13,0))',
          pointerEvents: 'none',
          fontSize: 12,
          lineHeight: 1.7,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, color: '#f8fafc', letterSpacing: 1 }}>
            默识 · 记忆图谱{' '}
            <span style={{ color: '#475569', fontSize: 12 }}>{is2d ? '2D / §8.7' : '3D / §10.3'}</span>
          </div>
          <span style={{ pointerEvents: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {(['3d', '2d'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => showView(v)}
                disabled={view === v}
                aria-pressed={view === v}
                title={v === '3d' ? '3D 发现视图：拖动旋转、点击选中' : '2D 确认视图：看清拓扑、精确点选'}
                style={switchStyle(view === v)}
              >
                {v === '3d' ? '3D' : '2D'}
              </button>
            ))}
            <span
              title="表格视图与虚拟滚动是 P2-04（台账 §3），本任务不做，这里只是占位"
              aria-disabled="true"
              style={{
                background: '#080c14',
                color: '#475569',
                border: '1px dashed #1f2937',
                borderRadius: 4,
                padding: '2px 10px',
                cursor: 'not-allowed',
                whiteSpace: 'nowrap',
              }}
            >
              表格（P2-04 未实现）
            </span>
          </span>
        </div>
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
                style={{ ...buttonStyle, background: '#0b1220', color: '#f59e0b', border: '1px solid #78350f', marginLeft: 6 }}
              >
                加载全量（{FULL_LIMIT}）
              </button>
            )}
          </span>
        </div>
        {meta !== undefined && meta.truncated && (
          <div style={{ color: '#f59e0b' }}>
            结果被截断：只返回了 {meta.returned_nodes} / {meta.total_nodes} 个节点（limit={meta.limit}）。
            点「加载全量」一次取满（{FULL_LIMIT}），或用 `?limit=` / cursor 分批取。
          </div>
        )}
        {meta !== undefined && meta.nodes_without_layout > 0 && (
          <div style={{ color: '#64748b' }}>
            另有 {meta.nodes_without_layout} 个活跃事实还没有 layout 坐标，未参与绘制。
          </div>
        )}
        {error !== null && <div style={{ color: '#ef4444' }}>取数失败：{error}</div>}
        <ActivityNote />
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: 14,
          color: '#475569',
          fontSize: 11,
          pointerEvents: 'none',
        }}
      >
        {is2d
          ? '拖动平移 · 滚轮缩放 · 点击节点 = 选中（放大 + 常显标签） · 点空白取消选中 · 坐标取布局表的 (x, z)，前端不跑布局'
          : '拖动旋转 · 滚轮缩放 · 点击节点 = 选中（放大 + 常显标签） · 标签只在活跃层、且离相机比整图半径更近时出现 · Y 四层 = strength'}
      </div>
    </div>
  );
}

const host = document.getElementById('root');
if (host === null) throw new Error('#root not found');
createRoot(host).render(<App />);
