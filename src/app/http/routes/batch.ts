/**
 * 批量动作接口（`/api/facts/batch*`，详设 §10.6、概设 §8.3、§8.3.4）。
 *
 * 已实现两个动作：
 * - `invalidate`：追加式收口（清 `valid_to` + `epistemic_status='invalidated'`）；
 * - `prune`：软删（只改 `epistemic_status='pruned'`，行与 valid_to 保留，绝不物理删除）。
 *   `archive` / 合并 diff 留 P2-19-A。
 *
 * 两条硬规矩（概设 §8.3）：
 * 1. 影响面预览必达 —— `preview` 与 `batch` 用同一个预览函数，
 *    保证「签名时看到的数字」就是「执行时的数字」；
 * 2. 30 秒可撤销 —— `batch` 返回 `op_id` + `undo_deadline`，窗口内 `undo` 按动作
 *    还原（invalidate=清回 valid_to；prune=还原 epistemic_status）；过期 410
 *    `E_OP_EXPIRED`，未知/已用过 404 `E_NOT_FOUND`。
 *
 * op 表放在插件闭包里（每个 app 实例独立），**不要模块级全局**：
 * 测试会起多个 app 实例，模块级会串味；过期项懒清理即可（签发时顺手扫一遍）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { reconcileDerivedForFacts } from '../../../core/lifecycle/consolidate.js';
import { MoshiError, isMoshiError } from '../../../domain/errors.js';
import { newId } from '../../../domain/ids.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as inboxRepo from '../../../infra/sqlite/inboxRepo.js';
import type { InvalidateSnapshot, PruneSnapshot } from '../../../infra/sqlite/inboxRepo.js';

const DEFAULT_TTL_MS = 30_000;

/** 已支持的批量动作：未列出的（archive 等）一律 400 unsupported_action */
export type BatchAction = 'invalidate' | 'prune';
const BATCH_ACTIONS: readonly BatchAction[] = ['invalidate', 'prune'];

/** 撤销记录按动作分型：两种动作的快照语义不同，撤销不能串 */
type OpRecord =
  | { action: 'invalidate'; expiresAt: number; snapshots: InvalidateSnapshot[] }
  | { action: 'prune'; expiresAt: number; snapshots: PruneSnapshot[] };

export interface BatchRoutesOpts {
  db: Db;
  /** 撤销窗口；测试传短 TTL 造过期，生产走 30s 默认值 */
  ttlMs?: number;
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

/** 预览：按动作选对应的影响面口径；响应字段两种动作保持一致（prune 的 cascade 恒 0） */
function previewPayload(db: Db, action: BatchAction, ids: readonly string[]) {
  const preview =
    action === 'prune' ? inboxRepo.previewPrune(db, ids) : inboxRepo.previewInvalidate(db, ids);
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
  /** 已签发、尚未撤销、尚未过期的批量操作（插件实例级） */
  const ops = new Map<string, OpRecord>();

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
      const preview =
        action === 'prune' ? inboxRepo.previewPrune(db, ids) : inboxRepo.previewInvalidate(db, ids);
      const opId = newId('batch');
      let record: OpRecord;
      if (action === 'prune') {
        // 软删：只改 epistemic_status，不跑 reconcile（否则派生点会被永久 invalidated，
        // 30 秒撤销救不回来；依赖方由读侧 adjudicate 按 pruned 收口）
        record = { action, expiresAt: 0, snapshots: inboxRepo.pruneMany(db, ids, { opId }) };
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
      const expiresAt = Date.now() + ttlMs;
      // 懒清理：签发新 op 时顺手丢掉过期项，避免 Map 无界增长
      for (const [id, rec] of ops) {
        if (rec.expiresAt <= Date.now()) ops.delete(id);
      }
      record.expiresAt = expiresAt;
      ops.set(opId, record);
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
    return guard(reply, () => {
      const opId = parseOpId(req.body);
      const rec = ops.get(opId);
      // 用完即删：二次撤销必须按"过期/不存在"处理，绝不允许二次还原
      if (rec === undefined) {
        throw new MoshiError('E_NOT_FOUND', `撤销操作不存在或已使用：${opId}`, { op_id: opId });
      }
      ops.delete(opId);
      if (rec.expiresAt <= Date.now()) {
        throw new MoshiError('E_OP_EXPIRED', `撤销窗口已过（${ttlMs} ms），op 已作废：${opId}`, {
          op_id: opId,
        });
      }
      const restored =
        rec.action === 'prune'
          ? inboxRepo.restorePruned(db, rec.snapshots, { opId })
          : inboxRepo.restoreMany(db, rec.snapshots, { opId });
      return { restored };
    });
  });
}
