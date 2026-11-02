/**
 * 边仓储。degree 由触发器维护，这里只负责"插边 / 收口边"，不手改 degree。
 */
import type { Etype } from '../../domain/enums.js';
import { MoshiError } from '../../domain/errors.js';
import type { Edge } from '../../domain/types.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from './db.js';
import { rowToEdge } from './mappers.js';

export interface NewEdge {
  id: string;
  src: string;
  dst: string;
  etype: Etype;
  weight?: number;
  confidence?: number;
  validAt: string;
  validTo?: string | null;
  recordedAt?: string;
  /** 生成这条边的规则（`rule:co_occur` 等），迁移 004 新增，用于精度抽样 */
  provenance?: string | null;
  /** 直写批次号（P2-23）；非直写路径传 null，撤销只按批次号扫 */
  batchId?: string | null;
}

export function insertEdge(db: Db, edge: NewEdge): void {
  if (edge.src === edge.dst) {
    throw new MoshiError('E_INPUT', '自环边没有意义（CHECK 也会拒绝）', { id: edge.src });
  }
  db.prepare(
    `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at, provenance, batch_id)
     VALUES (@id, @src, @dst, @etype, @weight, @confidence, @valid_at, @valid_to, @recorded_at, @provenance, @batch_id)`,
  ).run({
    id: edge.id,
    src: edge.src,
    dst: edge.dst,
    etype: edge.etype,
    weight: edge.weight ?? 1.0,
    confidence: edge.confidence ?? 0.9,
    valid_at: edge.validAt,
    valid_to: edge.validTo ?? null,
    recorded_at: edge.recordedAt ?? nowIso(),
    provenance: edge.provenance ?? null,
    batch_id: edge.batchId ?? null,
  });
}

export function getEdge(db: Db, id: string): Edge | null {
  const row = db.prepare('SELECT * FROM edge WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : rowToEdge(row);
}

/** 收口边（不删行）。触发器会把两端 degree 减 1 */
export function closeEdge(db: Db, id: string, validTo: string = nowIso()): void {
  const row = db.prepare('SELECT valid_at, valid_to FROM edge WHERE id = ?').get(id) as
    | { valid_at: string; valid_to: string | null }
    | undefined;
  if (row === undefined) throw new MoshiError('E_NOT_FOUND', `edge 不存在：${id}`, { id });
  if (row.valid_to !== null) {
    throw new MoshiError('E_IMMUTABLE', `edge 已收口：${id}`, { id });
  }
  if (!(validTo > row.valid_at)) {
    throw new MoshiError('E_INPUT', `valid_to 必须晚于 valid_at：${validTo} <= ${row.valid_at}`, {
      id,
      validTo,
      validAt: row.valid_at,
    });
  }
  db.prepare('UPDATE edge SET valid_to = ? WHERE id = ?').run(validTo, id);
}

export function findActiveEdge(db: Db, src: string, dst: string, etype: Etype): Edge | null {
  const row = db
    .prepare('SELECT * FROM edge WHERE src = ? AND dst = ? AND etype = ? AND valid_to IS NULL')
    .get(src, dst, etype) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToEdge(row);
}

/** 1 跳邻域（双向）。图扩散与子图构建的唯一入口 */
export function neighbors(
  db: Db,
  factId: string,
  opts: { etypes?: readonly Etype[]; includeClosed?: boolean; limit?: number } = {},
): Edge[] {
  const includeClosed = opts.includeClosed ?? false;
  const limit = opts.limit ?? 200;
  const rows = db
    .prepare(
      `SELECT * FROM edge
        WHERE (src = @id OR dst = @id)
          AND (@includeClosed = 1 OR valid_to IS NULL)
        ORDER BY weight DESC, id ASC
        LIMIT @limit`,
    )
    .all({ id: factId, includeClosed: includeClosed ? 1 : 0, limit }) as Record<string, unknown>[];
  const edges = rows.map(rowToEdge);
  if (opts.etypes === undefined) return edges;
  const allowed = new Set<string>(opts.etypes);
  return edges.filter((e) => allowed.has(e.etype));
}

export function countEdges(db: Db, activeOnly = true): number {
  const sql = activeOnly ? 'SELECT COUNT(*) AS n FROM edge WHERE valid_to IS NULL' : 'SELECT COUNT(*) AS n FROM edge';
  const row = db.prepare(sql).get() as { n: number };
  return row.n;
}
