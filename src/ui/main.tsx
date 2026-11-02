/**
 * `/ui/graph` 的 React 入口。
 *
 * 职责只有"取数 + 状态栏"：图怎么画全在 `graph/Graph3D.tsx`，坐标全在 `/api/graph`，
 * 这里一行布局计算都没有（概设 §8.9 纪律 1）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchGraph, type GraphPayload } from './api.js';
import { Graph3D, type GraphStats } from './graph/Graph3D.js';

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

function initialLimit(): number {
  const raw = new URLSearchParams(window.location.search).get('limit');
  const n = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), FULL_LIMIT);
}

function Badge({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span style={{ marginRight: 14, whiteSpace: 'nowrap' }}>
      <span style={{ color: '#64748b' }}>{label}</span> <span style={{ color: '#e2e8f0' }}>{value}</span>
    </span>
  );
}

function App(): JSX.Element {
  const [data, setData] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [limit, setLimit] = useState<number>(initialLimit);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (requestLimit: number): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchGraph(requestLimit, controller.signal);
      setData(payload);
      setLimit(requestLimit);
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

  const meta = data?.meta;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {data !== null && <Graph3D data={data} onStats={setStats} />}

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
        <div style={{ fontSize: 14, color: '#f8fafc', letterSpacing: 1 }}>
          默识 · 记忆图谱 <span style={{ color: '#475569', fontSize: 12 }}>3D / §10.3</span>
        </div>
        <div>
          <Badge label="节点" value={meta === undefined ? '—' : `${meta.returned_nodes} / ${meta.total_nodes}`} />
          <Badge label="边" value={meta === undefined ? '—' : `${meta.returned_edges} / ${meta.total_edges}`} />
          <Badge label="draw calls" value={stats === undefined || stats === null ? '—' : String(stats.renderCalls)} />
          <Badge label="fps" value={stats === undefined || stats === null ? '—' : stats.fps.toFixed(1)} />
          <Badge label="标签" value={stats === undefined || stats === null ? '—' : String(stats.labelCount)} />
          <span style={{ pointerEvents: 'auto' }}>
            <button
              type="button"
              onClick={() => void load(limit)}
              style={{
                background: '#111827',
                color: '#cbd5e1',
                border: '1px solid #1f2937',
                borderRadius: 4,
                padding: '2px 10px',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {loading ? '加载中…' : '刷新'}
            </button>
            {meta !== undefined && meta.returned_nodes < meta.total_nodes && (
              <button
                type="button"
                onClick={() => void load(FULL_LIMIT)}
                style={{
                  background: '#0b1220',
                  color: '#f59e0b',
                  border: '1px solid #78350f',
                  borderRadius: 4,
                  padding: '2px 10px',
                  marginLeft: 6,
                  cursor: 'pointer',
                  font: 'inherit',
                }}
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
        拖动旋转 · 滚轮缩放 · 点击节点脉冲 · 标签只在活跃层、且离相机比整图半径更近时出现 ·
        Y 四层 = strength
      </div>
    </div>
  );
}

const host = document.getElementById('root');
if (host === null) throw new Error('#root not found');
createRoot(host).render(<App />);
