/**
 * `/ui/inbox` 的 API 契约（P2-07 / P2-13 / P2-19-A）。
 *
 * 与 `../api.ts` 同一套约定：token 走 `resolveToken()`、请求带 `X-Moshi-Token`、
 * 非 2xx 一律抛错（错误信封 `{error, message, detail}`，`message` 直接可展示）。
 *
 * 这里的 `InboxApiError` 多带 `status` 与 `code`：撤销要区分 410（窗口已过，提示后刷新）
 * 与 404（op 不存在），只靠 `message` 文本判断太脆。
 *
 * 三类动作共用撤销入口（`POST /api/facts/batch/undo` 或 `/api/facts/ops/:id/undo`）：
 * - `invalidate`：失效（清 valid_to）；
 * - `prune`：剪枝（软删 epistemic_status='pruned'，行保留）；
 * - `alias_merge`：并入（单条 decide；撤销把 alias 的 source/confidence 还原）。
 */
import { resolveToken } from '../api.js';

/** 批量动作：低置信 tab 用 invalidate，淘汰候选 tab 用 prune */
export type BatchAction = 'invalidate' | 'prune';

/** 撤销条的动作：批量两种 + 单条并入（P2-19-A） */
export type UndoAction = BatchAction | 'alias_merge';

/** 队列种类（单条决策可用 resolve / lowconf；prune 只有批量剪枝） */
export type QueueKind = 'resolve' | 'lowconf';
export type ResolveDecision = 'merge' | 'keep' | 'reject';
export type LowConfDecision = 'promote' | 'invalidate';
export type DecideAction = ResolveDecision | LowConfDecision;

export interface ResolveRow {
  /** 不透明行标识（alias + entity_id 编码），单条 decide 用它定位 */
  id: string;
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

/** 队列一页：`next_cursor` 为 null 表示没有下一页（UI 暂只取首页，API 已支持翻页） */
export interface QueuePage<T> {
  items: T[];
  next_cursor: string | null;
}

/** prune 队列随包下发的判据（只增字段，UI 不用再抄 0.15 / 60） */
export interface PruneThresholds {
  strength: number;
  idle_days: number;
}

export interface PruneQueueResult extends QueuePage<PruneRow> {
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

/** 单条决策的响应：成功一定带 before/after（UI 可直接展示改了什么） */
export interface DecideResult {
  ok: true;
  kind: QueueKind;
  action: DecideAction;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** merge / invalidate 才有：30 秒撤销句柄 */
  op_id?: string;
  undo_deadline?: string;
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

function queueUrl(kind: 'resolve' | 'lowconf' | 'prune', limit: number, cursor?: string | null): string {
  const base = `/api/queues/${kind}?limit=${String(limit)}`;
  return cursor === undefined || cursor === null || cursor === '' ? base : `${base}&cursor=${cursor}`;
}

export async function fetchResolveQueue(limit = 50, cursor?: string | null): Promise<QueuePage<ResolveRow>> {
  return request<QueuePage<ResolveRow>>(queueUrl('resolve', limit, cursor));
}

export async function fetchLowConfQueue(limit = 50, cursor?: string | null): Promise<QueuePage<LowConfRow>> {
  return request<QueuePage<LowConfRow>>(queueUrl('lowconf', limit, cursor));
}

export async function fetchPruneQueue(limit = 50, cursor?: string | null): Promise<PruneQueueResult> {
  return request<PruneQueueResult>(queueUrl('prune', limit, cursor));
}

/** 单条决策：`kind` 与 `action` 的组合由服务端再校验一次（这里只做类型收窄） */
export function decideQueue(kind: QueueKind, id: string, action: DecideAction): Promise<DecideResult> {
  return post<DecideResult>(`/api/queues/${kind}/decide`, { id, action });
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
