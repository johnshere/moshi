/**
 * 接入层日志的客户端契约（P4；开发方案 §4 P4 / §6）。
 *
 * 只做只读查询与「清空」；**写配置不在这里**——设置页才是唯一写入口
 * （日志页右上角的开关只是跳转快捷入口，用户 m02743）。
 */
import { resolveToken } from '../api.js';

export type LogSource = 'query' | 'trace';
export type LogSourceFilter = 'all' | LogSource;
export type SummaryWindow = '1h' | '24h' | '7d';

export interface LogItem {
  id: string;
  source: LogSource;
  ts: string;
  caller_id: string;
  caller_kind: string;
  plugin_id: string | null;
  corr_id: string | null;
  status: string | null;
  in_bytes: number | null;
  out_bytes: number | null;
  latency_ms: number | null;
  evidence: number | null;
  text: string | null;
}

export interface LogsSummaryGroup {
  caller_id: string;
  caller_kind: string;
  count: number;
  ok: number;
  degraded: number;
  untagged: number;
  p95_ms: number | null;
  last_ts: string | null;
  in_bytes: number;
  out_bytes: number;
  /** 12 段计数（时间窗均分），卡片上的小折线（P5） */
  buckets: number[];
}

export interface LogsSummary {
  window: SummaryWindow;
  since: string;
  generated_at: string;
  groups: LogsSummaryGroup[];
  totals: { count: number; ok: number; degraded: number; untagged: number };
  cached?: boolean;
}

export interface LogsPayload {
  source: LogSourceFilter;
  items: LogItem[];
  next_cursor: string | null;
  limit: number;
}

export interface LogQuery {
  limit?: number;
  cursor?: string | null;
  source?: LogSourceFilter;
  caller?: string | null;
  kind?: string | null;
  status?: string | null;
  q?: string | null;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return body.message ?? body.error ?? `HTTP ${String(res.status)}`;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Moshi-Token': resolveToken(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

export async function fetchLogs(query: LogQuery = {}, signal?: AbortSignal): Promise<LogsPayload> {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit ?? 20));
  if (query.cursor !== null && query.cursor !== undefined && query.cursor !== '') {
    params.set('cursor', query.cursor);
  }
  if (query.source !== undefined) params.set('source', query.source);
  for (const key of ['caller', 'kind', 'status', 'q'] as const) {
    const value = query[key];
    if (value !== null && value !== undefined && value.trim() !== '') params.set(key, value.trim());
  }
  return getJson<LogsPayload>(`/api/logs?${params.toString()}`, signal);
}

export async function fetchLogsSummary(
  window: SummaryWindow,
  signal?: AbortSignal,
): Promise<LogsSummary> {
  return getJson<LogsSummary>(`/api/logs/summary?window=${window}`, signal);
}

export async function purgeQueryLogs(): Promise<{ removed: number; evidence_removed: number }> {
  return postJson<{ removed: number; evidence_removed: number }>('/api/maintenance/query-log/purge', {
    confirm: 'PURGE',
  });
}

export async function purgeTraceLogs(): Promise<{ disk_removed: number; memory_removed: number }> {
  return postJson<{ disk_removed: number; memory_removed: number }>('/api/maintenance/trace/purge', {
    confirm: 'PURGE',
  });
}
