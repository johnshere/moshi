/**
 * 召回路由（P2①：唯一读取链的 HTTP 面；契约 `moshi-recall/1`）。
 *
 * 与 `/api/search` 是**两件事**，别再混：
 * - `/api/search` = 管理面直查（实体 LIKE + FTS5 bm25），不过 gate、不出证据包；
 * - `/api/recall` = 召回面，内部**只调 `runMemoryQuery`**（`src/app/mcp/query.ts`），
 *   也就是 MCP `memory_query` 的同一条读取链：同样的 gate、同样的打包、同样的降级语义、
 *   同样的证据链（trace ring buffer）。这里不复制任何检索/打包逻辑，HTTP 层只做
 *   「入参 → QueryInput」与「EvidencePackJson → 本契约」两件翻译。
 *
 * 为什么另立契约而不扩 `/api/search`：后者是已发布的 `moshi-search/1` 管理面契约
 * （D-89 不改既有契约）；且「直查命中」与「过 gate 后的证据包」是两个语义，混在一个
 * 响应里迟早有人拿直查结果当召回结果。
 *
 * 空命中是**合法结果**（`core/read/evidence.ts`）：200 + `evidence: []` +
 * `confidence_summary: 'none'` + `advice: '无可靠记忆，请勿臆断'`。前端据
 * `confidence_summary` 显示「无可靠记忆」，不得当成错误。
 *
 * 入参错误（query 空/非字符串、limit 非法、scope 非法）一律 400 `E_INPUT`，与既有
 * `/api/*` 路由同口径（本服务没有全局 errorHandler，就地转）。
 *
 * 路由由 `src/app/http/server.ts` 以 prefix=`/api/recall` 注册，deps 与 MCP handler
 * 共用同一份（证据缓存与 trace ring buffer 都只有一份），不是第二条读取链。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import type { Degraded } from '../../../domain/enums.js';
import type { McpDeps } from '../../mcp/deps.js';
import { runMemoryQuery } from '../../mcp/query.js';

/** 响应契约版本（只增不改；字段含义见本文件头与任务卡 P2①） */
export const RECALL_SCHEMA = 'moshi-recall/1';

/** `limit` 缺省 8：与 MCP `top_k` 缺省一致（同一个读取链，不该有两套默认） */
export const DEFAULT_LIMIT = 8;
/** 上限 32：与 `queryShape.top_k` 的 `.max(32)` 对齐，超过夹住而不是报错 */
export const MAX_LIMIT = 32;
/** 与 `queryShape.query` 的 `.max(2000)` 对齐（按码点数） */
const MAX_QUERY_CODEPOINTS = 2000;

export interface RecallRoutesOpts {
  /** 与 MCP handler 共用的一份装配（db/cfg/encode/score/breaker/cache/traceStore） */
  deps: McpDeps;
}

/** 入参解析后的内部形态（HTTP 契约的 `limit` → 读取链的 `top_k`） */
interface RecallInput {
  query: string;
  topK: number;
  scope: string;
}

/** 证据卡片：m_id 是宿主看的稳定编号（`[M1]`），fact_id 只给「跳到记忆页」用 */
export interface RecallEvidenceJson {
  m_id: number;
  fact_id: string;
  content: string;
  confidence: number;
  confidence_source: string;
  ftype: string;
}

/** 一次召回的 evidence 包（`moshi-recall/1`） */
export interface RecallPayload {
  schema: typeof RECALL_SCHEMA;
  query: string;
  scope: string;
  limit: number;
  status: string;
  route: 'local' | 'global';
  degraded: Degraded[];
  advice: string;
  confidence_summary: 'high' | 'medium' | 'low' | 'none';
  identity: 'resolved' | 'unresolved';
  coverage: 'full' | 'partial';
  truncated: boolean;
  /** 没有可靠记忆（= evidence 为空）。显式给，前端不必再自己数 */
  empty: boolean;
  /** 给宿主/前端看的注入文本（编号列表，§6.9 格式；空命中为 ''） */
  injection_text: string;
  evidence: RecallEvidenceJson[];
  conflict_count: number;
  /** 证据链摘要：用 `query_id` 还能去 `GET /api/trace/:query_id` 回放 */
  trace: {
    query_id: string;
    route: 'local' | 'global';
    cached: boolean;
    stats: { candidates: number; packed: number; tokens: number; latency_ms: number };
  };
  took_ms: number;
}

function badInput(message: string, reason: string): MoshiError {
  return new MoshiError('E_INPUT', message, { reason });
}

function parseBody(body: unknown): RecallInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badInput('请求体必须是 JSON 对象', 'body_invalid');
  }
  const record = body as Record<string, unknown>;

  const rawQuery = record['query'];
  if (typeof rawQuery !== 'string') {
    throw badInput('query 必须是字符串', 'query_invalid');
  }
  const query = rawQuery.trim();
  if (query === '') throw badInput('query 不能为空', 'query_empty');
  if (Array.from(query).length > MAX_QUERY_CODEPOINTS) {
    throw badInput(`query 最长 ${MAX_QUERY_CODEPOINTS} 字符`, 'query_too_long');
  }

  let topK = DEFAULT_LIMIT;
  const rawLimit = record['limit'];
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
      throw badInput('limit 必须是 ≥ 1 的整数', 'limit_invalid');
    }
    topK = Math.min(rawLimit, MAX_LIMIT);
  }

  let scope = 'global';
  const rawScope = record['scope'];
  if (rawScope !== undefined && rawScope !== null) {
    if (typeof rawScope !== 'string' || rawScope.trim() === '') {
      throw badInput('scope 必须是非空字符串', 'scope_invalid');
    }
    scope = rawScope.trim();
  }

  return { query, topK, scope };
}

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply.code(err.meta.httpStatus).send({
    error: err.code,
    message: err.message,
    ...(err.detail === undefined ? {} : { detail: err.detail }),
  });
}

export async function recallRoutes(app: FastifyInstance, opts: RecallRoutesOpts): Promise<void> {
  const deps = opts.deps;

  app.addHook('onSend', async (_req, reply) => {
    // 召回结果跟着库变（写库即失效缓存），HTTP 缓存没有意义
    void reply.header('cache-control', 'no-store');
  });

  app.post('/', async (req, reply) => {
    const startedAt = performance.now();

    let input: RecallInput;
    try {
      input = parseBody(req.body);
    } catch (err) {
      if (!isMoshiError(err)) throw err;
      return sendMoshiError(reply, err);
    }

    try {
      // 唯一读取链：不在这里做任何检索/过滤/打包，全由 `searchWithPipeline` 决定。
      // `format` 在 JSON 形态下不改变输出（MCP 的 text 格式只是另一种渲染），照传 json。
      const pack = await runMemoryQuery(deps, {
        query: input.query,
        top_k: input.topK,
        scope: input.scope,
        include_history: false,
        format: 'json',
      });

      const evidence: RecallEvidenceJson[] = pack.evidence.map((item) => ({
        m_id: item.m_id,
        fact_id: item.fact_id,
        content: item.content,
        confidence: item.confidence,
        confidence_source: item.confidence_source,
        ftype: item.ftype,
      }));

      const payload: RecallPayload = {
        schema: RECALL_SCHEMA,
        query: input.query,
        scope: input.scope,
        limit: input.topK,
        status: pack.status,
        route: pack.route,
        degraded: pack.degraded,
        advice: pack.advice,
        confidence_summary: pack.confidence_summary,
        identity: pack.identity,
        coverage: pack.coverage,
        truncated: pack.truncated,
        empty: evidence.length === 0,
        injection_text: pack.numbered_list,
        evidence,
        conflict_count: pack.conflicts.length,
        trace: {
          query_id: pack.query_id,
          route: pack.route,
          cached: pack.cached,
          stats: pack.stats,
        },
        took_ms: Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000),
      };
      return payload;
    } catch (err) {
      if (!isMoshiError(err)) throw err;
      return sendMoshiError(reply, err);
    }
  });
}
