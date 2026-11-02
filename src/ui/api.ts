/**
 * `/api/graph` 的客户端契约 + token 解析。
 *
 * token 三处来源（优先级从高到低）：
 * 1. `?token=`（dev 模式唯一入口：Vite dev server 不经过 static.ts，没人注入）
 * 2. `window.__MOSHI_TOKEN__`（生产：`static.ts` 吐 index.html 时替换进去）
 * 3. `localStorage['moshi-token']`（`?token=` 落到 localStorage，刷新不掉）
 */

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
