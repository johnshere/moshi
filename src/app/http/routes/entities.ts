/**
 * 实体列表与合并接口（P2-19A-09；Lead 在 server.ts 注册 `/api/entities`）。
 *
 * - `GET /api/entities?q=&limit=`：归并后事实数的实体列表（merged loser 不出现）；
 * - `POST /api/entities/merge/preview`：只读预览（冲突、将移动计数、可合并性）；
 * - `POST /api/entities/merge`：执行合并。
 *
 * 错误口径：
 * - 同 id / etype 不同 → 400 `E_INPUT`（reason=same_entity / etype_mismatch）
 * - 实体不存在 → 404 `E_NOT_FOUND`（reason=entity_not_found，detail.which=from|to）
 * - 已合并到别处 → 409 `E_CONFLICT_IDENTITY`（reason=already_merged）
 *
 * 撤销口径：实体改判没有纳入 `/api/facts/ops/:op_id/undo` 的 30s 快照，
 * 合并结果带 `undoable:false` 明确告知，不签发伪 op_id。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as entityRepo from '../../../infra/sqlite/entityRepo.js';
import { mergeEntities, previewEntityMerge } from '../../../core/write/entity-merge.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface EntityRoutesOpts {
  db: Db;
}

function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (isMoshiError(err)) {
      return reply.code(err.meta.httpStatus).send({
        error: err.code,
        message: err.message,
        ...(err.detail === undefined ? {} : { detail: err.detail }),
      });
    }
    throw err;
  }
}

function parseLimit(raw: string | string[] | undefined): number {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', 'limit 必须是单个值', { reason: 'limit_invalid' });
  }
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new MoshiError('E_INPUT', `limit 必须是正整数，收到 ${raw}`, { reason: 'limit_invalid' });
  }
  const n = Number(raw);
  if (n < 1) {
    throw new MoshiError('E_INPUT', `limit 必须 >= 1，收到 ${n}`, { reason: 'limit_invalid' });
  }
  return Math.min(n, MAX_LIMIT);
}

function parseQuery(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', 'q 必须是单个值', { reason: 'q_invalid' });
  }
  return (raw ?? '').trim();
}

function parsePair(body: unknown): { fromId: string; toId: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MoshiError('E_INPUT', '请求体必须是 JSON 对象', { reason: 'body_invalid' });
  }
  const record = body as Record<string, unknown>;
  const from = record['from'];
  const to = record['to'];
  if (typeof from !== 'string' || from.trim() === '') {
    throw new MoshiError('E_INPUT', 'from 必须是非空实体 id', { reason: 'from_invalid' });
  }
  if (typeof to !== 'string' || to.trim() === '') {
    throw new MoshiError('E_INPUT', 'to 必须是非空实体 id', { reason: 'to_invalid' });
  }
  return { fromId: from.trim(), toId: to.trim() };
}

export async function entitiesRoutes(app: FastifyInstance, opts: EntityRoutesOpts): Promise<void> {
  const { db } = opts;

  app.get('/', async (req, reply) => {
    return guard(reply, () => {
      const query = req.query as Record<string, string | string[] | undefined>;
      const q = parseQuery(query['q']);
      const limit = parseLimit(query['limit']);
      const items = entityRepo.listEntitiesAggregated(db, q, limit);
      return { items };
    });
  });

  app.post('/merge/preview', async (req, reply) => {
    return guard(reply, () => {
      const { fromId, toId } = parsePair(req.body);
      return previewEntityMerge(db, { fromId, toId });
    });
  });

  app.post('/merge', async (req, reply) => {
    return guard(reply, () => {
      const { fromId, toId } = parsePair(req.body);
      return mergeEntities(db, { fromId, toId });
    });
  });
}
