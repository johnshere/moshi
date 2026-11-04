/**
 * `/ui/inbox` 的 API 契约（P2-07 / P2-13）。
 *
 * 与 `../api.ts` 同一套约定：token 走 `resolveToken()`、请求带 `X-Moshi-Token`、
 * 非 2xx 一律抛错（错误信封 `{error, message, detail}`，`message` 直接可展示）。
 *
 * 这里的 `InboxApiError` 多带 `status` 与 `code`：撤销要区分 410（窗口已过，提示后刷新）
 * 与 404（op 不存在），只靠 `message` 文本判断太脆。
 *
 * 两个批量动作共用一套接口（P2-13 起）：
 * - `invalidate`：失效（清 valid_to）；
 * - `prune`：剪枝（软删 epistemic_status='pruned'，行保留）。
 */
import { resolveToken } from '../api.js';

/** 批量动作：低置信 tab 用 invalidate，淘汰候选 tab 用 prune */
export type BatchAction = 'invalidate' | 'prune';

export interface ResolveRow {
  alias: string;
  entity_id: string;
  canonical_name: string;
  confidence: number;
}

export interface LowConfRow {
  id: string;
  content: string;
  confidence: number;
  importance: number;
}

export interface PruneRow {
  id: string;
  content: string;
  strength: number;
  last_access_at: string | null;
}

/** prune 队列随包下发的判据（只增字段，UI 不用再抄 0.15 / 60） */
export interface PruneThresholds {
  strength: number;
  idle_days: number;
}

export interface PruneQueueResult {
  items: PruneRow[];
  thresholds: PruneThresholds;
}

export interface PreviewResult {
  facts: number;
  edges: number;
  topics: number;
  /** 连带失效：依赖这批事实、但自己不在这批里的活跃事实数（invalidate 必须展示，否则等于盲签） */
  invalidated_by_cascade: number;
  preview_sample: { id: string; content: string }[];
}

export interface BatchResult extends Omit<PreviewResult, 'preview_sample'> {
  op_id: string;
  /** ISO 时间串（UTC，24 位），撤销窗口截止时刻 */
  undo_deadline: string;
}

export interface UndoResult {
  restored: number;
}

export class InboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'InboxApiError';
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'X-Moshi-Token': resolveToken(), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new InboxApiError(
      body.message ?? body.error ?? `HTTP ${String(res.status)}`,
      res.status,
      body.error ?? 'E_UNKNOWN',
    );
  }
  return (await res.json()) as T;
}

function post<T>(url: string, payload: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function fetchResolveQueue(limit = 50): Promise<ResolveRow[]> {
  const body = await request<{ items: ResolveRow[] }>(`/api/queues/resolve?limit=${String(limit)}`);
  return body.items;
}

export async function fetchLowConfQueue(limit = 50): Promise<LowConfRow[]> {
  const body = await request<{ items: LowConfRow[] }>(`/api/queues/lowconf?limit=${String(limit)}`);
  return body.items;
}

export async function fetchPruneQueue(limit = 50): Promise<PruneQueueResult> {
  return request<PruneQueueResult>(`/api/queues/prune?limit=${String(limit)}`);
}

export function previewBatch(action: BatchAction, ids: string[]): Promise<PreviewResult> {
  return post<PreviewResult>('/api/facts/batch/preview', { action, ids });
}

export function submitBatch(action: BatchAction, ids: string[]): Promise<BatchResult> {
  return post<BatchResult>('/api/facts/batch', { action, ids });
}

export function undoBatch(opId: string): Promise<UndoResult> {
  return post<UndoResult>('/api/facts/batch/undo', { op_id: opId });
}
