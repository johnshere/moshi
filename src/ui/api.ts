/**
 * `/api/graph` 与 `/api/trace` 的客户端契约 + token 解析。
 *
 * token 三处来源（优先级从高到低）：
 * 1. `?token=`（dev 模式唯一入口：Vite dev server 不经过 static.ts，没人注入）
 * 2. `window.__MOSHI_TOKEN__`（生产：`static.ts` 吐 index.html 时替换进去）
 * 3. `localStorage['moshi-token']`（`?token=` 落到 localStorage，刷新不掉）
 */
import type { TraceEdgeReadout, TraceRecord, TraceSummary } from './graph/pure/trace.js';

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  z: number;
  ftype: string;
  importance: number;
  strength: number;
  community_id: number | null;
  label: string;
  access_count: number;
}

export interface GraphEdge {
  src: string;
  dst: string;
  etype: string;
  confidence: number;
}

export interface GraphMeta {
  total_nodes: number;
  returned_nodes: number;
  total_edges: number;
  returned_edges: number;
  truncated: boolean;
  nodes_without_layout: number;
  layout_version: number;
  limit: number;
  next_cursor: string | null;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: GraphMeta;
}

declare global {
  interface Window {
    __MOSHI_TOKEN__?: string;
    __moshiGraph?: {
      fps: number;
      renderCalls: number;
      nodeCount: number;
      edgeCount: number;
      labelCount: number;
      /** 上屏的光晕实例数：沉默态为 0（详设 §10.3.1 验收 ①） */
      halos: number;
      /** 活跃集规模：命中 + 1-hop，≤64 节点 / ≤256 边（验收 ③/⑥） */
      activeNodes: number;
      activeEdges: number;
      /** 3D 当前画着的选中节点（= 共享 store 的 focusId）：跨视图联动的读数证据 */
      focusId: string | null;
      /** P2-25：`renderCalls` 的别名（台账验收口述的是 `calls`，两个都发布，脚本任选） */
      calls: number;
      /**
       * P2-26：`live` = 跟随最近一次查询；`replay` = 用户在历史面板里选中的回放。
       * 脚本据此区分「回放成功」与「实时跟着跑」。
       */
      mode: 'live' | 'replay';
      /** P2-26：回放时为回放的 query_id；实时时为图上 trace 的 query_id（无 trace 为 null） */
      query_id: string | null;
      /** P2-25 证据链摘要：`null` = 无证据链（还没查询 / trace 已被 ring buffer 淘汰） */
      trace: TraceSummary | null;
      /**
       * P2-25 证据链边属性（仅 hop>0 的边，每条证据边一项；直击态 hop=0 只亮节点，
       * 没有入射边）。脚本据此证明「三态同图」：aFlow 同时出现 0.6 与 0.3。
       */
      edges: TraceEdgeReadout;
    };
    /**
     * 2D 视图的可测性钩子（P2-03）：与 3D 的 `__moshiGraph` 同形，外加
     * `screenPos(id)`——验收脚本要证明"节点屏幕位置随 layout 表变"，
     * 只靠截图比坐标稳。
     */
    __moshiGraph2d?: {
      fps: number;
      nodeCount: number;
      edgeCount: number;
      selectedId: string | null;
      /** 活跃集规模（与 3D 同一张表：命中 + 1-hop） */
      activeNodes: number;
      activeEdges: number;
      screenPos(id: string): { x: number; y: number } | null;
    };
  }
}

export function resolveToken(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  if (fromQuery !== null && fromQuery !== '') {
    try {
      window.localStorage.setItem('moshi-token', fromQuery);
    } catch {
      /* 隐私模式禁写 localStorage 时忽略 */
    }
    return fromQuery;
  }
  if (typeof window.__MOSHI_TOKEN__ === 'string' && window.__MOSHI_TOKEN__ !== '') {
    return window.__MOSHI_TOKEN__;
  }
  try {
    return window.localStorage.getItem('moshi-token') ?? '';
  } catch {
    return '';
  }
}

export async function fetchGraph(limit: number, signal?: AbortSignal): Promise<GraphPayload> {
  const res = await fetch(`/api/graph?limit=${String(limit)}`, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as GraphPayload;
}

/** `GET /api/trace?limit=N` 的列表项（字段名以 `routes/trace.ts` 实现为准） */
export interface TraceListEntry {
  query_id: string;
  ts: number;
  route: string;
  source: string;
}

export interface TraceListPayload {
  schema: string;
  queries: TraceListEntry[];
  total: number;
  limit: number;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return body.message ?? body.error ?? `HTTP ${String(res.status)}`;
}

/** 最近查询的 id 列表（新→旧；`/api/trace` 由 trace ring buffer 支撑，不落库） */
export async function fetchTraceList(limit = 20, signal?: AbortSignal): Promise<TraceListPayload> {
  const res = await fetch(`/api/trace?limit=${String(limit)}`, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as TraceListPayload;
}

/**
 * 单条 trace。404 = 这次查询没有 trace（缓存命中 / ring buffer 淘汰 / daemon 重启），
 * 属于**正常降级**而不是故障：返回 `null`，由调用方显示「无证据链」。
 */
export async function fetchTrace(queryId: string, signal?: AbortSignal): Promise<TraceRecord | null> {
  const res = await fetch(`/api/trace/${encodeURIComponent(queryId)}`, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as TraceRecord;
}
