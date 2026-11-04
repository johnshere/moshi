/**
 * 证据链回放路由（P2-24，详设 §4.7 / §12.2）。
 *
 * 只读，且**不碰数据库**：数据源是进程内的 `TraceStore`（最近 64 次查询的
 * ring buffer）。与 `/api/graph` 同一个鉴权壳——`/api/*` 由 server.ts 的
 * onRequest hook 统一校验 `X-Moshi-Token`，本插件不再重复实现。
 *
 *   GET /api/trace/:query_id  → 200 TraceRecord（§4.7 原样）
 *                               404 {error:'E_NOT_FOUND'} = 这次查询没有 trace
 *                               （缓存命中/重启后都会出现，前端应静默降级）
 *   GET /api/trace?limit=20   → {schema, queries:[{query_id,ts,route,source}], total, limit}
 *
 * limit 口径与 routes/queues.ts 一致：缺省 20、1..64（超过夹住）、非法 400 E_INPUT。
 * 读接口一律 `cache-control: no-store`——trace 是「刚发生」的数据，缓存没有意义。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { TRACE_SCHEMA, type TraceStore } from '../../../core/read/trace.js';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';

export const DEFAULT_TRACE_LIMIT = 20;
export const MAX_TRACE_LIMIT = 64;

export interface TraceRoutesOpts {
  store: TraceStore;
}

/** 与 `routes/queues.ts` 的 parseLimit 同规则，只是上限是 ring buffer 容量 */
function parseLimit(raw: string | string[] | undefined): number {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', 'limit 必须是单个值，收到数组', { reason: 'limit_invalid' });
  }
  if (raw === undefined) return DEFAULT_TRACE_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new MoshiError('E_INPUT', `limit 必须是正整数，收到 ${raw}`, { reason: 'limit_invalid' });
  }
  const n = Number(raw);
  if (n < 1) throw new MoshiError('E_INPUT', `limit 必须 >= 1，收到 ${n}`, { reason: 'limit_invalid' });
  return Math.min(n, MAX_TRACE_LIMIT);
}

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply.code(err.meta.httpStatus).send({ error: err.code, message: err.message, detail: err.detail });
}

function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return sendMoshiError(reply, err);
  }
}

export async function traceRoutes(app: FastifyInstance, opts: TraceRoutesOpts): Promise<void> {
  const store = opts.store;

  app.get('/', async (req, reply) => {
    return guard(reply, () => {
      const query = req.query as Record<string, string | string[] | undefined>;
      const limit = parseLimit(query['limit']);
      const queries = store.recent(limit).map((r) => ({
        query_id: r.query_id,
        ts: r.ts,
        route: r.route,
        source: r.source,
      }));
      reply.header('cache-control', 'no-store');
      return { schema: TRACE_SCHEMA, queries, total: store.size, limit };
    });
  });

  app.get('/:query_id', async (req, reply) => {
    const params = req.params as { query_id: string };
    const record = store.get(params.query_id);
    if (record === null) {
      // 不是服务端故障：trace 只保留最近 64 次，重启即清空（§4.7 不落库）
      return reply.code(404).send({
        error: 'E_NOT_FOUND',
        message: `没有这条查询的 trace（仅保留最近 ${MAX_TRACE_LIMIT} 次，重启即清空）：${params.query_id}`,
        query_id: params.query_id,
      });
    }
    reply.header('cache-control', 'no-store');
    return record;
  });
}
