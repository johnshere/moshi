/**
 * 待办三队列接口（`/api/queues/*`，详设 §10.6、概设 §8.3；P2-19-A 增游标与单条决策）。
 *
 * 三个队列共用一条约定：`limit` 缺省 50、1..200，非法一律 400 `E_INPUT`
 * （reason=`limit_invalid`），与 `routes/facts.ts` 的 `parseLimit` 同口径。
 *
 * 分页（P2-19-A）：`cursor` 是不透明串（base64url 的 JSON），响应带 `next_cursor`
 * （最后一页为 `null`）。用 keyset 而不是 OFFSET：队列里的行会被其它动作改状态，
 * OFFSET 会漏行/重行。排序键各队列不同，见 `inboxRepo` 的 `list*Queue`。
 *
 * 单条决策（P2-19-A）：
 * - `POST /resolve/decide`：`{id, action: merge|keep|reject}`，id 是队列行里的不透明 `id`；
 *   merge 返回 `op_id`（30s 内可 `POST /api/facts/ops/:op_id/undo` 撤销 alias 收口）；
 * - `POST /lowconf/decide`：`{id, action: promote|invalidate}`，invalidate 可撤销。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import { isId, newId } from '../../../domain/ids.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as inboxRepo from '../../../infra/sqlite/inboxRepo.js';
import {
  DEFAULT_TTL_MS,
  opStoreFor,
  recordOp,
  type BatchOpRecord,
} from './batch.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface QueueRoutesOpts {
  db: Db;
  /** 单条 decide 签发的 op 撤销窗口；与 batch 同默认 30s，测试可传短 TTL */
  ttlMs?: number;
}

type CursorKind = 'resolve' | 'lowconf' | 'prune';

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

/** 公共壳：MoshiError → 对应状态码，其他异常原样抛给 Fastify（500） */
function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return sendMoshiError(reply, err);
  }
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function cursorInvalid(raw: string): MoshiError {
  return new MoshiError('E_INPUT', `cursor 无法解析：${raw}`, { reason: 'cursor_invalid' });
}

function readCursorRaw(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', 'cursor 必须是单个值，收到数组', { reason: 'cursor_invalid' });
  }
  if (raw === undefined) return undefined;
  if (raw.length === 0) throw cursorInvalid(raw);
  return raw;
}

/** base64url(JSON) → 对象；形状/类型不对一律 400，不猜 */
function decodeCursor(raw: string, kind: CursorKind): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw cursorInvalid(raw);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw cursorInvalid(raw);
  }
  const obj = parsed as Record<string, unknown>;
  const isNum01 = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  switch (kind) {
    case 'resolve':
      if (!isNum01(obj['confidence']) || !isStr(obj['alias']) || !isStr(obj['entityId'])) {
        throw cursorInvalid(raw);
      }
      return { confidence: obj['confidence'], alias: obj['alias'], entityId: obj['entityId'] };
    case 'lowconf':
      if (!isNum01(obj['importance']) || !isStr(obj['id'])) throw cursorInvalid(raw);
      return { importance: obj['importance'], id: obj['id'] };
    case 'prune':
      if (!isNum01(obj['strength']) || !isStr(obj['id'])) throw cursorInvalid(raw);
      return { strength: obj['strength'], id: obj['id'] };
  }
}

function isBodyObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function parseDecideBody(body: unknown): { id: string; action: string } {
  if (!isBodyObject(body)) {
    throw new MoshiError('E_INPUT', '请求体必须是 JSON 对象', { reason: 'body_invalid' });
  }
  const id = body['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new MoshiError('E_INPUT', 'id 必须是非空字符串', { reason: 'id_invalid' });
  }
  const action = body['action'];
  if (typeof action !== 'string' || action.length === 0) {
    throw new MoshiError('E_INPUT', 'action 必须是非空字符串', { reason: 'action_invalid' });
  }
  return { id, action };
}

export async function queueRoutes(app: FastifyInstance, opts: QueueRoutesOpts): Promise<void> {
  const { db } = opts;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const ops = opStoreFor(app);

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
      const rawCursor = readCursorRaw(q['cursor']);
      const cursor =
        rawCursor === undefined
          ? undefined
          : (decodeCursor(rawCursor, 'resolve') as inboxRepo.ResolveCursor);
      // 多取一条探测下一页：不做 count，避免队列这种易变集合多一次扫描
      const rows = inboxRepo.listResolveQueue(db, { limit: limit + 1, minSim, maxSim, cursor });
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? encodeCursor(resolveCursorOf(page)) : null;
      return {
        items: page.map((r) => ({
          id: r.id,
          alias: r.alias,
          entity_id: r.entityId,
          canonical_name: r.canonicalName,
          confidence: r.confidence,
        })),
        next_cursor: next,
      };
    });
  });

  app.get('/lowconf', async (req, reply) => {
    return guard(reply, () => {
      const q = req.query as Record<string, string | string[] | undefined>;
      const limit = parseLimit(q['limit']);
      const rawCursor = readCursorRaw(q['cursor']);
      const cursor =
        rawCursor === undefined
          ? undefined
          : (decodeCursor(rawCursor, 'lowconf') as inboxRepo.LowConfCursor);
      const rows = inboxRepo.listLowConfQueue(db, { limit: limit + 1, cursor });
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? encodeCursor(lowConfCursorOf(page)) : null;
      return {
        items: page.map((r) => ({
          id: r.id,
          content: r.content,
          confidence: r.confidence,
          importance: r.importance,
        })),
        next_cursor: next,
      };
    });
  });

  app.get('/prune', async (req, reply) => {
    return guard(reply, () => {
      const q = req.query as Record<string, string | string[] | undefined>;
      const limit = parseLimit(q['limit']);
      const rawCursor = readCursorRaw(q['cursor']);
      const cursor =
        rawCursor === undefined ? undefined : (decodeCursor(rawCursor, 'prune') as inboxRepo.PruneCursor);
      const rows = inboxRepo.listPruneQueue(db, { limit: limit + 1, cursor });
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? encodeCursor(pruneCursorOf(page)) : null;
      const items = page.map((r) => ({
        id: r.id,
        content: r.content,
        strength: r.strength,
        last_access_at: r.lastAccessAt,
      }));
      // 只增字段（P2-13）：把"什么算淘汰候选"的判据随队列一起下发，
      // UI 不必再把 0.15 / 60 天抄一份；既有 `items[].*` 字段不变。
      return {
        items,
        next_cursor: next,
        thresholds: {
          strength: inboxRepo.PRUNE_STRENGTH_THRESHOLD,
          idle_days: inboxRepo.PRUNE_IDLE_DAYS,
        },
      };
    });
  });

  // ── 单条决策（P2-19-A） ──

  app.post('/:kind/decide', async (req, reply) => {
    return guard(reply, () => {
      const kind = (req.params as { kind?: string }).kind;
      if (kind !== 'resolve' && kind !== 'lowconf') {
        throw new MoshiError('E_INPUT', `不支持的队列：${String(kind)}（支持 resolve / lowconf）`, {
          reason: 'queue_kind_invalid',
        });
      }
      const { id, action } = parseDecideBody(req.body);

      if (kind === 'resolve') {
        const parsed = inboxRepo.parseResolveRowId(id);
        if (parsed === null) {
          throw new MoshiError('E_INPUT', `resolve 队列行 id 无法解析：${id}`, { reason: 'id_invalid' });
        }
        if (action === 'merge') {
          const opId = newId('batch');
          const result = inboxRepo.decideAliasMerge(db, parsed.alias, parsed.entityId, { opId });
          const record: BatchOpRecord = {
            action: 'alias_merge',
            expiresAt: 0,
            snapshots: result.snapshots ?? [],
          };
          const expiresAt = recordOp(ops, opId, record, ttlMs);
          return {
            ok: true,
            kind,
            action,
            before: result.before,
            after: result.after,
            op_id: opId,
            undo_deadline: new Date(expiresAt).toISOString(),
          };
        }
        if (action !== 'keep' && action !== 'reject') {
          throw new MoshiError('E_INPUT', `resolve 不支持的动作：${action}（支持 merge / keep / reject）`, {
            reason: 'action_invalid',
          });
        }
        const result =
          action === 'keep'
            ? inboxRepo.decideAliasKeep(db, parsed.alias, parsed.entityId)
            : inboxRepo.decideAliasReject(db, parsed.alias, parsed.entityId);
        return { ok: true, kind, action, before: result.before, after: result.after };
      }

      if (!isId('fact', id)) {
        throw new MoshiError('E_INPUT', `lowconf 事实 id 格式不合法：${id}`, { reason: 'id_invalid' });
      }
      if (action === 'promote') {
        const result = inboxRepo.decideLowConfPromote(db, id);
        return { ok: true, kind, action, before: result.before, after: result.after };
      }
      if (action !== 'invalidate') {
        throw new MoshiError('E_INPUT', `lowconf 不支持的动作：${action}（支持 promote / invalidate）`, {
          reason: 'action_invalid',
        });
      }
      const opId = newId('batch');
      const result = inboxRepo.decideLowConfInvalidate(db, id, { opId });
      const record: BatchOpRecord = {
        action: 'invalidate',
        expiresAt: 0,
        snapshots: result.snapshot === undefined ? [] : [result.snapshot],
      };
      const expiresAt = recordOp(ops, opId, record, ttlMs);
      return {
        ok: true,
        kind,
        action,
        before: result.before,
        after: result.after,
        op_id: opId,
        undo_deadline: new Date(expiresAt).toISOString(),
      };
    });
  });
}

/** 游标只取"排序键的最后一行的值"，不含行内容 */
function resolveCursorOf(rows: readonly inboxRepo.ResolveQueueRow[]): inboxRepo.ResolveCursor {
  const last = rows[rows.length - 1];
  if (last === undefined) throw new MoshiError('E_INPUT', '空页无法生成游标', { reason: 'cursor_invalid' });
  return { confidence: last.confidence, alias: last.alias, entityId: last.entityId };
}

function lowConfCursorOf(rows: readonly { importance: number; id: string }[]): inboxRepo.LowConfCursor {
  const last = rows[rows.length - 1];
  if (last === undefined) throw new MoshiError('E_INPUT', '空页无法生成游标', { reason: 'cursor_invalid' });
  return { importance: last.importance, id: last.id };
}

function pruneCursorOf(rows: readonly { strength: number; id: string }[]): inboxRepo.PruneCursor {
  const last = rows[rows.length - 1];
  if (last === undefined) throw new MoshiError('E_INPUT', '空页无法生成游标', { reason: 'cursor_invalid' });
  return { strength: last.strength, id: last.id };
}
