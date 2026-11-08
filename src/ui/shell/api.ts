/**
 * 外壳读取接口（P2-19-A）：只消费既有 GET 契约，不新增 /api/*（D-89）。
 *
 * - `/api/status`：三灯数据源（daemon / sidecar / vector）
 * - `/api/queues/{resolve,lowconf,prune}?limit=200`：待办角标（只有 items，无 total，只能按页估算）
 * - `/api/facts?q=&limit=`：顶部搜索建议
 */
import { resolveToken } from '../api.js';
import type { DaemonStatus } from './pure.js';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as T;
}

export async function fetchStatus(signal?: AbortSignal): Promise<DaemonStatus> {
  return await getJson<DaemonStatus>('/api/status', signal);
}

const QUEUE_ENDPOINTS = [
  '/api/queues/resolve?limit=200',
  '/api/queues/lowconf?limit=200',
  '/api/queues/prune?limit=200',
] as const;

/** 三队列各取一页（上限 200），返回三个条数；没有 total 契约，故不返回"真值"。 */
export async function fetchQueueCounts(signal?: AbortSignal): Promise<number[]> {
  const [resolve, lowconf, prune] = await Promise.all(
    QUEUE_ENDPOINTS.map(async (url) => {
      const body = await getJson<{ items?: unknown[] }>(url, signal);
      return Array.isArray(body.items) ? body.items.length : 0;
    }),
  );
  return [resolve ?? 0, lowconf ?? 0, prune ?? 0];
}

export interface FactSuggestion {
  id: string;
  content: string;
  ftype: string;
}

/** 作用域清单（V-02）：`GET /api/scopes` 的 `moshi-scopes/1` 契约 */
export interface ScopeItem {
  scope: string;
  fact_count: number;
}

export async function fetchScopes(signal?: AbortSignal): Promise<ScopeItem[]> {
  const body = await getJson<{ items?: ScopeItem[] }>('/api/scopes', signal);
  return Array.isArray(body.items) ? body.items : [];
}

export async function fetchSuggestions(
  query: string,
  limit = 6,
  signal?: AbortSignal,
): Promise<FactSuggestion[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit), sort: 'importance' });
  const body = await getJson<{ items?: FactSuggestion[] }>(`/api/facts?${params.toString()}`, signal);
  return Array.isArray(body.items) ? body.items : [];
}
