/**
 * `GET /api/facts/:id` 与 `PATCH /api/facts/:id` 的客户端契约（P2-06 检查器）。
 *
 * 检查器走"详情按需请求"（概设 §8.2 / 详设 §10.8 < 50ms）：点行/点节点时只拉
 * 当前事实的详情，不随列表下发。
 */
import { resolveToken } from '../api.js';

export interface FactAudit {
  field: string;
  before: string | null;
  after: string | null;
  source: string | null;
  ts: string;
}

export interface FactDigest {
  id: string;
  content: string;
  valid_at: string;
  valid_to: string | null;
}

export interface FactDetail {
  id: string;
  content: string;
  ftype: string;
  confidence: number;
  confidence_source: string;
  strength: number;
  importance: number;
  pool: string;
  epistemic_status: string;
  attrs: {
    frozen: { subject: { entity_id: string; name: string }; predicate: string; value: unknown };
    ext: Record<string, unknown>;
  };
  canonical_key: string;
  scope: string;
  superseded_by: string | null;
  valid_at: string;
  valid_to: string | null;
  recorded_at: string;
  source_episode: { id: string; ts: string; summary: string | null; raw_path: string | null } | null;
  span: [number, number] | null;
  depends: { upstream: FactDigest[]; downstream: FactDigest[] };
  conflicts: FactDigest[];
  superseded: FactDigest[];
  vector: { indexed: boolean; head?: number[] };
  audits: FactAudit[];
}

export async function fetchFactDetail(id: string, signal?: AbortSignal): Promise<FactDetail> {
  const res = await fetch(`/api/facts/${encodeURIComponent(id)}`, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as FactDetail;
}

export interface FactPatch {
  confidence?: number;
  strength?: number;
  importance?: number;
}

export async function patchFact(id: string, patch: FactPatch): Promise<{ fact_id: string; changed: string[] }> {
  const res = await fetch(`/api/facts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'X-Moshi-Token': resolveToken(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as { fact_id: string; changed: string[] };
}
