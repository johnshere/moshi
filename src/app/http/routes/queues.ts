/**
 * 待办三队列只读接口（`/api/queues/*`，详设 §10.6、概设 §8.3）。
 *
 * 三个队列共用一条约定：`limit` 缺省 50、1..200，非法一律 400 `E_INPUT`
 * （reason=`limit_invalid`），与 `routes/facts.ts` 的 `parseLimit` 同口径。
 * 本任务不做游标分页（派单契约只有 limit / min_sim / max_sim）。
 *
 * 单条决策（`POST /api/queues/:kind/decide`）属 P2-19-A，不在此实现。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as inboxRepo from '../../../infra/sqlite/inboxRepo.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface QueueRoutesOpts {
  db: Db;
}

/** 与 `routes/facts.ts` 的 `parseLimit` 同规则：数组/非数字/小于 1 都是 400，上限 200 截断 */
function parseLimit(raw: string | string[] | undefined): number {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', 'limit 必须是单个值，收到数组', { reason: 'limit_invalid' });
  }
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new MoshiError('E_INPUT', `limit 必须是正整数，收到 ${raw}`, { reason: 'limit_invalid' });
  }
  const n = Number(raw);
  if (n < 1) throw new MoshiError('E_INPUT', `limit 必须 >= 1，收到 ${n}`, { reason: 'limit_invalid' });
  return Math.min(n, MAX_LIMIT);
}

/** 相似度区间端点：0..1 的有限小数；缺省用详设 §10.6 的 0.60 / 0.92 */
function parseSim(raw: string | string[] | undefined, name: string, fallback: number): number {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', `${name} 必须是单个值，收到数组`, { reason: 'sim_invalid' });
  }
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new MoshiError('E_INPUT', `${name} 必须是 0..1 之间的实数，收到 ${raw}`, { reason: 'sim_invalid' });
  }
  return n;
}

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply
    .code(err.meta.httpStatus)
    .send({ error: err.code, message: err.message, detail: err.detail });
}

/** 三个 GET 的公共壳：MoshiError → 对应状态码，其他异常原样抛给 Fastify（500） */
function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return sendMoshiError(reply, err);
  }
}

export async function queueRoutes(app: FastifyInstance, opts: QueueRoutesOpts): Promise<void> {
  const { db } = opts;

  app.get('/resolve', async (req, reply) => {
    return guard(reply, () => {
      const q = req.query as Record<string, string | string[] | undefined>;
      const limit = parseLimit(q['limit']);
      const minSim = parseSim(q['min_sim'], 'min_sim', inboxRepo.RESOLVE_MIN_SIM);
      const maxSim = parseSim(q['max_sim'], 'max_sim', inboxRepo.RESOLVE_MAX_SIM);
      if (minSim > maxSim) {
        throw new MoshiError('E_INPUT', `min_sim(${minSim}) 不能大于 max_sim(${maxSim})`, {
          reason: 'sim_invalid',
        });
      }
      const items = inboxRepo.listResolveQueue(db, { limit, minSim, maxSim }).map((r) => ({
        alias: r.alias,
        entity_id: r.entityId,
        canonical_name: r.canonicalName,
        confidence: r.confidence,
      }));
      return { items };
    });
  });

  app.get('/lowconf', async (req, reply) => {
    return guard(reply, () => {
      const q = req.query as Record<string, string | string[] | undefined>;
      const limit = parseLimit(q['limit']);
      const items = inboxRepo.listLowConfQueue(db, { limit }).map((r) => ({
        id: r.id,
        content: r.content,
        confidence: r.confidence,
        importance: r.importance,
      }));
      return { items };
    });
  });

  app.get('/prune', async (req, reply) => {
    return guard(reply, () => {
      const q = req.query as Record<string, string | string[] | undefined>;
      const limit = parseLimit(q['limit']);
      const items = inboxRepo.listPruneQueue(db, { limit }).map((r) => ({
        id: r.id,
        content: r.content,
        strength: r.strength,
        last_access_at: r.lastAccessAt,
      }));
      return { items };
    });
  });
}
