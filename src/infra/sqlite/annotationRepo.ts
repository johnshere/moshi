/**
 * 标注队列仓储（详设 §5.1 / §5.10）。
 *
 * `annotation` 是**三条写入通道的唯一汇合点**（R1 实时接口 / R2 定时扫描 / R3 尾随监听），
 * 再由同一个 `harvest()` 消费。所以这张表只有两件事要做对：
 *
 * 1. **入队去重**：`dedup_key` 唯一索引。同一条会话行被读两遍（游标丢失、文件重放）
 *    不会产生第二条标注；
 * 2. **消费留痕**：`harvested_at` 非空 = 已处理；`error` 非空 = 处理失败但**不再重试**
 *    （否则一条毒数据会永久堵住队列，`harvest` 每轮都在它身上失败）。
 */
import { MoshiError } from '../../domain/errors.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from './db.js';

export const CHANNELS = ['annotate', 'harvest', 'tool_parse', 'agent_format'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface AnnotationRow {
  id: string;
  dedupKey: string;
  payloadJson: string;
  channel: Channel;
  origin: string | null;
  receivedAt: string;
  harvestedAt: string | null;
  error: string | null;
}

function rowToAnnotation(r: Record<string, unknown>): AnnotationRow {
  return {
    id: String(r['id']),
    dedupKey: String(r['dedup_key']),
    payloadJson: String(r['payload_json']),
    channel: String(r['channel']) as Channel,
    origin: (r['origin'] as string | null) ?? null,
    receivedAt: String(r['received_at']),
    harvestedAt: (r['harvested_at'] as string | null) ?? null,
    error: (r['error'] as string | null) ?? null,
  };
}

/**
 * 入队。返回 `created=false` 表示去重命中（已存在同 `dedup_key` 的行）。
 *
 * 用 `ON CONFLICT DO NOTHING` 而不是先 SELECT 再 INSERT：并发入队时"查了没有、
 * 插的时候有了"会撞唯一索引；`DO NOTHING` 把这件事交给数据库，`changes()` 为 0
 * 就说明被去重了——这里**可以**用 `changes()`，因为没有 `DO UPDATE` 分支。
 */
export function insert(
  db: Db,
  input: {
    dedupKey: string;
    payloadJson: string;
    channel: Channel;
    origin?: string | null;
    receivedAt?: string;
    /** 直写批次号（P2-23）；普通入队不传 */
    batchId?: string | null;
  },
): { id: string; created: boolean } {
  const id = newId('annotation');
  const info = db
    .prepare(
      `INSERT INTO annotation (id, dedup_key, payload_json, channel, origin, received_at, harvested_at, error, batch_id)
       VALUES (@id, @dedup, @payload, @channel, @origin, @ts, NULL, NULL, @batch_id)
       ON CONFLICT (dedup_key) DO NOTHING`,
    )
    .run({
      id,
      dedup: input.dedupKey,
      payload: input.payloadJson,
      channel: input.channel,
      origin: input.origin ?? null,
      ts: input.receivedAt ?? nowIso(),
      batch_id: input.batchId ?? null,
    });
  if (info.changes > 0) return { id, created: true };

  const existing = db
    .prepare('SELECT id FROM annotation WHERE dedup_key = ?')
    .get(input.dedupKey) as { id: string } | undefined;
  if (existing === undefined) {
    throw new MoshiError('E_DB', `标注入队后既没插入也查不到：${input.dedupKey}`, {
      dedupKey: input.dedupKey,
    });
  }
  return { id: existing.id, created: false };
}

/** 待处理的一批，按接收时间先进先出 */
export function listPending(db: Db, limit: number): AnnotationRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM annotation WHERE harvested_at IS NULL
        ORDER BY received_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToAnnotation);
}

export function markHarvested(db: Db, id: string, ts?: string): void {
  db.prepare('UPDATE annotation SET harvested_at = ? WHERE id = ?').run(ts ?? nowIso(), id);
}

/** 失败也标 `harvested_at`：留痕 + 不堵队列。错误信息给 UI 与 doctor 看 */
export function markError(db: Db, id: string, error: string, ts?: string): void {
  db.prepare('UPDATE annotation SET harvested_at = ?, error = ? WHERE id = ?').run(
    ts ?? nowIso(),
    error,
    id,
  );
}

export function countPending(db: Db): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM annotation WHERE harvested_at IS NULL')
    .get() as { n: number };
  return row.n;
}

export function countErrors(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM annotation WHERE error IS NOT NULL').get() as {
    n: number;
  };
  return row.n;
}

export function get(db: Db, id: string): AnnotationRow | null {
  const row = db.prepare('SELECT * FROM annotation WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : rowToAnnotation(row);
}

/** 直写批次的 annotation 快照（P2-23 撤销时连带回滚） */
export function listByBatch(db: Db, batchId: string): AnnotationRow[] {
  const rows = db
    .prepare('SELECT * FROM annotation WHERE batch_id = ? ORDER BY received_at ASC, id ASC')
    .all(batchId) as Record<string, unknown>[];
  return rows.map(rowToAnnotation);
}

/**
 * 物理删除一条标注。**只给直写撤销用**：普通入队的行是队列历史，删了就把
 * "这条曾经提交过"的痕迹一起抹了；直写的行是本批自己造的，撤销就该一起消失。
 */
export function remove(db: Db, id: string): void {
  db.prepare('DELETE FROM annotation WHERE id = ?').run(id);
}
