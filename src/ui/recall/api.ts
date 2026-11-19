/**
 * `POST /api/recall` 的客户端契约（服务端见 `src/app/http/routes/recall.ts`，`moshi-recall/1`）。
 *
 * 与 `/api/search`（管理面直查）刻意分开：这里只发 query/scope/limit，拿回**过 gate 的
 * 证据包**（injection_text + evidence + degraded + advice + trace 摘要）。
 *
 * 空命中是合法结果：200 + `evidence: []` + `confidence_summary: 'none'`，前端显示
 * 「无可靠记忆」，不要按 HTTP 错误处理。
 */
import { resolveToken } from '../api.js';

/** 证据卡片要的字段（服务端从 `EvidenceEntry` 收窄而来） */
export interface RecallEvidence {
  /** 宿主编号：注入文本里的 `[M1]` 就是它 */
  m_id: number;
  /** 事实 id：只给「打开事实」深链用，不进注入文本 */
  fact_id: string;
  content: string;
  confidence: number;
  confidence_source: string;
  ftype: string;
}

export interface RecallStats {
  candidates: number;
  packed: number;
  tokens: number;
  latency_ms: number;
}

/** 证据链摘要：`query_id` 还能去 `GET /api/trace/:query_id` 回放 */
export interface RecallTraceSummary {
  query_id: string;
  route: 'local' | 'global';
  cached: boolean;
  stats: RecallStats;
}

export interface RecallPayload {
  schema: 'moshi-recall/1';
  query: string;
  scope: string;
  limit: number;
  status: string;
  route: 'local' | 'global';
  degraded: string[];
  advice: string;
  confidence_summary: 'high' | 'medium' | 'low' | 'none';
  identity: 'resolved' | 'unresolved';
  coverage: 'full' | 'partial';
  truncated: boolean;
  empty: boolean;
  injection_text: string;
  evidence: RecallEvidence[];
  conflict_count: number;
  trace: RecallTraceSummary;
  took_ms: number;
}

export interface RecallRequest {
  query: string;
  /** 缺省 global（服务端默认，与 MCP 的 queryShape 一致） */
  scope?: string;
  /** 缺省 8，上限 32（服务端夹住，不报错） */
  limit?: number;
}

export async function fetchRecall(
  input: RecallRequest,
  signal?: AbortSignal,
): Promise<RecallPayload> {
  const res = await fetch('/api/recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Moshi-Token': resolveToken() },
    body: JSON.stringify(input),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    // 错误体是 `{error, message, detail}`（MoshiError 口径）；解析失败也不能吞掉状态码
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as RecallPayload;
}
