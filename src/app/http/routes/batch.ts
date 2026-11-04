/**
 * 批量动作接口（`/api/facts/batch*`，详设 §10.6、概设 §8.3、§8.3.4；P2-19-A 增 archive）。
 *
 * 已实现三个动作：
 * - `invalidate`：追加式收口（清 `valid_to` + `epistemic_status='invalidated'`）；
 * - `prune`：软删（只改 `epistemic_status='pruned'`，行与 valid_to 保留，绝不物理删除）；
 * - `archive`：归档（只改 `epistemic_status='archived'`，不删行、不删边、不动 valid_to）。
 *
 * 两条硬规矩（概设 §8.3）：
 * 1. 影响面预览必达 —— `preview` 与 `batch` 用同一个预览函数，
 *    保证「签名时看到的数字」就是「执行时的数字」；
 * 2. 30 秒可撤销 —— `batch` 返回 `op_id` + `undo_deadline`，窗口内 `undo` 按动作
 *    还原（invalidate=清回 valid_to；prune/archive=还原 epistemic_status）；过期 410
 *    `E_OP_EXPIRED`，未知/已用过 404 `E_NOT_FOUND`。
 *
 * op 存储的隔离边界是 **app 实例**，不是 db（`tests/unit/batch-http.test.ts` 明确断言
 * 同一 db 的两个 app 实例 op 不互通）。所以用模块级 `WeakMap<app.server, Map>`：
 * 不同 app 的 server 对象不同 → 天然隔离；同一 app 里 batch 与 queues 两个插件
 * 都通过 `opStoreFor(app)` 拿到同一份 Map（单条 decide 的 30s 撤销因此可用）。
 * 过期项懒清理即可（签发时顺手扫一遍）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { reconcileDerivedForFacts } from '../../../core/lifecycle/consolidate.js';
import { MoshiError, isMoshiError } from '../../../domain/errors.js';
import { newId } from '../../../domain/ids.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as inboxRepo from '../../../infra/sqlite/inboxRepo.js';
import type {
  AliasSnapshot,
  ArchiveSnapshot,
  InvalidateSnapshot,
  PruneSnapshot,
} from '../../../infra/sqlite/inboxRepo.js';

/** 撤销窗口（毫秒）：概设 §8.3 的 30 秒硬规矩 */
export const DEFAULT_TTL_MS = 30_000;

/** 已支持的批量动作：未列出的（如 merge）一律 400 unsupported_action */
export type BatchAction = 'invalidate' | 'prune' | 'archive';
export const BATCH_ACTIONS: readonly BatchAction[] = ['invalidate', 'prune', 'archive'];

/**
 * 撤销记录按动作分型：快照语义不同，撤销不能串。
 * - `alias_merge` 不来自 `/batch`（来自 `POST /api/queues/resolve/decide`），
 *   但共用同一份 op 存储与 `/api/facts/ops/:op_id/undo` 撤销入口。
 */
export type BatchOpRecord =
  | { action: 'invalidate'; expiresAt: number; snapshots: InvalidateSnapshot[] }
  | { action: 'prune'; expiresAt: number; snapshots: PruneSnapshot[] }
  | { action: 'archive'; expiresAt: number; snapshots: ArchiveSnapshot[] }
  | { action: 'alias_merge'; expiresAt: number; snapshots: AliasSnapshot[] };

export interface BatchRoutesOpts {
  db: Db;
  /** 撤销窗口；测试传短 TTL 造过期，生产走 30s 默认值 */
  ttlMs?: number;
}

/** structural 类型：FastifyInstance 的 `server` 就是 node http.Server 实例，作隔离键 */
export interface OpStoreHost {
  server: object;
}

const OP_STORES = new WeakMap<object, Map<string, BatchOpRecord>>();

/**
 * 同一 app 实例共享的 op 存储。
 * 注意是 **WeakMap<server>** 而不是 WeakMap<db>：测试要求同 db 不同 app 互不可见。
 */
export function opStoreFor(host: OpStoreHost): Map<string, BatchOpRecord> {
  let store = OP_STORES.get(host.server);
  if (store === undefined) {
    store = new Map<string, BatchOpRecord>();
    OP_STORES.set(host.server, store);
  }
  return store;
}

/** 登记 op：顺手清理过期项，避免 Map 无界增长 */
export function recordOp(
  ops: Map<string, BatchOpRecord>,
  opId: string,
  record: BatchOpRecord,
  ttlMs = DEFAULT_TTL_MS,
): number {
  const now = Date.now();
  for (const [id, rec] of ops) {
    if (rec.expiresAt <= now) ops.delete(id);
  }
  record.expiresAt = now + ttlMs;
  ops.set(opId, record);
  return record.expiresAt;
}

/**
 * 撤销一个 op：用完即删（二次撤销按 404 处理），过期 410。
 * 返回被还原的行数。batch / queues 两个插件的撤销入口共用。
 */
export function undoOp(
  db: Db,
  ops: Map<string, BatchOpRecord>,
  opId: string,
  ttlMs = DEFAULT_TTL_MS,
): { restored: number } {
  const rec = ops.get(opId);
  if (rec === undefined) {
    throw new MoshiError('E_NOT_FOUND', `撤销操作不存在或已使用：${opId}`, { op_id: opId });
  }
  ops.delete(opId);
  if (rec.expiresAt <= Date.now()) {
    throw new MoshiError('E_OP_EXPIRED', `撤销窗口已过（${ttlMs} ms），op 已作废：${opId}`, {
      op_id: opId,
    });
  }
  switch (rec.action) {
    case 'prune':
      return { restored: inboxRepo.restorePruned(db, rec.snapshots, { opId }) };
    case 'archive':
      return { restored: inboxRepo.restoreArchived(db, rec.snapshots, { opId }) };
    case 'alias_merge':
      return { restored: inboxRepo.restoreAliases(db, rec.snapshots, { opId }) };
    default:
      return { restored: inboxRepo.restoreMany(db, rec.snapshots, { opId }) };
  }
}

/** `{action, ids}` 的校验：整批拒绝，绝不静默跳过非法元素或未知 id */
function parseBatchBody(body: unknown): { action: BatchAction; ids: string[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MoshiError('E_INPUT', '请求体必须是 JSON 对象', { reason: 'body_invalid' });
  }
  const raw = body as Record<string, unknown>;
  const action = raw['action'];
  if (typeof action !== 'string' || !(BATCH_ACTIONS as readonly string[]).includes(action)) {
    throw new MoshiError(
      'E_INPUT',
      `不支持的批量动作：${String(action)}（支持 ${BATCH_ACTIONS.join(' / ')}）`,
      { reason: 'unsupported_action' },
    );
  }
  const rawIds = raw['ids'];
  if (!Array.isArray(rawIds)) {
    throw new MoshiError('E_INPUT', 'ids 必须是字符串数组', { reason: 'ids_invalid' });
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of rawIds) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new MoshiError('E_INPUT', 'ids 的每个元素都必须是非空字符串', { reason: 'ids_invalid' });
    }
    if (seen.has(item)) continue; // 去重：同一 id 计一次、只收口一次
    seen.add(item);
    ids.push(item);
  }
  if (ids.length === 0) {
    throw new MoshiError('E_INPUT', 'ids 不能为空', { reason: 'ids_invalid' });
  }
  if (ids.length > inboxRepo.MAX_BATCH_IDS) {
    throw new MoshiError('E_INPUT', `ids 最多 ${inboxRepo.MAX_BATCH_IDS} 条，收到 ${ids.length} 条`, {
      reason: 'ids_invalid',
    });
  }
  return { action: action as BatchAction, ids };
}

function parseOpId(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MoshiError('E_INPUT', '请求体必须是 JSON 对象', { reason: 'body_invalid' });
  }
  const raw = (body as Record<string, unknown>)['op_id'];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MoshiError('E_INPUT', 'op_id 必须是非空字符串', { reason: 'op_id_invalid' });
  }
  return raw;
}

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply
    .code(err.meta.httpStatus)
    .send({ error: err.code, message: err.message, detail: err.detail });
}

/** 公共壳：MoshiError → 对应状态码；其他异常原样抛（Fastify 500） */
function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return sendMoshiError(reply, err);
  }
}

/** 未知 id：整批拒绝（400 `unknown_ids`），detail 里带前几个，方便定位调用方拼错的一批 */
function assertKnownIds(db: Db, ids: readonly string[]): void {
  const missing = inboxRepo.missingIds(db, ids);
  if (missing.length === 0) return;
  throw new MoshiError('E_INPUT', `${missing.length} 个 id 不存在：${missing.slice(0, 5).join(', ')}`, {
    reason: 'unknown_ids',
    missing_ids: missing.slice(0, 20),
  });
}

/** 预览：按动作选对应的影响面口径；响应字段各动作保持一致（prune/archive 的 cascade 恒 0） */
function previewFor(db: Db, action: BatchAction, ids: readonly string[]) {
  switch (action) {
    case 'prune':
      return inboxRepo.previewPrune(db, ids);
    case 'archive':
      return inboxRepo.previewArchive(db, ids);
    default:
      return inboxRepo.previewInvalidate(db, ids);
  }
}

function previewPayload(db: Db, action: BatchAction, ids: readonly string[]) {
  const preview = previewFor(db, action, ids);
  return {
    facts: preview.facts,
    edges: preview.edges,
    topics: preview.topics,
    invalidated_by_cascade: preview.invalidatedByCascade,
    preview_sample: preview.previewSample,
  };
}

export async function batchRoutes(app: FastifyInstance, opts: BatchRoutesOpts): Promise<void> {
  const { db } = opts;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const ops = opStoreFor(app);

  app.post('/batch/preview', async (req, reply) => {
    return guard(reply, () => {
      const { action, ids } = parseBatchBody(req.body);
      assertKnownIds(db, ids);
      return previewPayload(db, action, ids);
    });
  });

  app.post('/batch', async (req, reply) => {
    return guard(reply, () => {
      const { action, ids } = parseBatchBody(req.body);
      assertKnownIds(db, ids);
      // 先算影响面：执行前就把数字定下来，响应里原样返回
      const preview = previewFor(db, action, ids);
      const opId = newId('batch');
      let record: BatchOpRecord;
      if (action === 'prune') {
        // 软删：只改 epistemic_status，不跑 reconcile（否则派生点会被永久 invalidated，
        // 30 秒撤销救不回来；依赖方由读侧 adjudicate 按 pruned 收口）
        record = { action, expiresAt: 0, snapshots: inboxRepo.pruneMany(db, ids, { opId }) };
      } else if (action === 'archive') {
        // 归档同样不连锁：只改状态，不跑 reconcile（撤销要能原样回去）
        record = { action, expiresAt: 0, snapshots: inboxRepo.archiveMany(db, ids, { opId }) };
      } else {
        const snapshots = inboxRepo.invalidateMany(db, ids, { opId });
        // 源事实撤回后立刻对账：没有新 annotation 时 consolidate 不会自己跑
        try {
          reconcileDerivedForFacts(db, ids);
        } catch (err) {
          app.log.warn(
            { event: 'consolidate.reconcile_failed', err: (err as Error).message },
            'reconcile after batch invalidate failed',
          );
        }
        record = { action, expiresAt: 0, snapshots };
      }
      const expiresAt = recordOp(ops, opId, record, ttlMs);
      return {
        op_id: opId,
        facts: preview.facts,
        edges: preview.edges,
        topics: preview.topics,
        invalidated_by_cascade: preview.invalidatedByCascade,
        undo_deadline: new Date(expiresAt).toISOString(),
      };
    });
  });

  app.post('/batch/undo', async (req, reply) => {
    return guard(reply, () => undoOp(db, ops, parseOpId(req.body), ttlMs));
  });

  // 单条 decide（queues）签发的 op 也走这里的撤销语义：路径 `/api/facts/ops/:op_id/undo`
  app.post('/ops/:op_id/undo', async (req, reply) => {
    return guard(reply, () => {
      const opId = (req.params as { op_id?: string }).op_id ?? '';
      if (opId.length === 0) {
        throw new MoshiError('E_INPUT', 'op_id 必须是非空字符串', { reason: 'op_id_invalid' });
      }
      return undoOp(db, ops, opId, ttlMs);
    });
  });
}
