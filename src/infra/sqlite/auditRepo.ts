/**
 * 审计仓储（详设 §2.3 / I10）。
 *
 * 审计只追加，不提供 update / delete。任何"改了就忘"的路径都是 I10 的漏洞。
 */
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from './db.js';

export interface AuditInput {
  /** `annotation` 只由直写撤销写（P2-23）：撤销要连带回滚队列快照，同样得留痕 */
  tbl: 'fact' | 'edge' | 'entity' | 'archive_meta' | 'annotation';
  rowId: string;
  field?: string | null;
  before?: unknown;
  after?: unknown;
  source?: string | null;
  reason?: string | null;
  ts?: string;
}

export interface AuditRecord {
  id: string;
  tbl: string;
  rowId: string;
  field: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  source: string | null;
  reason: string | null;
  ts: string;
}

const jsonOrNull = (v: unknown): string | null =>
  v === undefined ? null : v === null ? null : JSON.stringify(v);

export function appendAudit(db: Db, input: AuditInput): string {
  const id = newId('audit');
  db.prepare(
    `INSERT INTO audit (id, tbl, row_id, field, before_json, after_json, source, reason, ts)
     VALUES (@id, @tbl, @row_id, @field, @before, @after, @source, @reason, @ts)`,
  ).run({
    id,
    tbl: input.tbl,
    row_id: input.rowId,
    field: input.field ?? null,
    before: jsonOrNull(input.before),
    after: jsonOrNull(input.after),
    source: input.source ?? null,
    reason: input.reason ?? null,
    ts: input.ts ?? nowIso(),
  });
  return id;
}

export function auditByRow(db: Db, tbl: string, rowId: string): AuditRecord[] {
  const rows = db
    .prepare('SELECT * FROM audit WHERE tbl = ? AND row_id = ? ORDER BY ts ASC, id ASC')
    .all(tbl, rowId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r['id']),
    tbl: String(r['tbl']),
    rowId: String(r['row_id']),
    field: (r['field'] as string | null) ?? null,
    beforeJson: (r['before_json'] as string | null) ?? null,
    afterJson: (r['after_json'] as string | null) ?? null,
    source: (r['source'] as string | null) ?? null,
    reason: (r['reason'] as string | null) ?? null,
    ts: String(r['ts']),
  }));
}

/** I10 抽样：改过 confidence 但没有审计行的 fact */
export function confidenceChangesWithoutAudit(db: Db): { fact_id: string; confidence: number }[] {
  return db
    .prepare(
      `SELECT f.id AS fact_id, f.confidence AS confidence
         FROM fact f
        WHERE NOT EXISTS (
          SELECT 1 FROM audit a
           WHERE a.tbl = 'fact' AND a.row_id = f.id AND a.field = 'confidence'
        )`,
    )
    .all() as { fact_id: string; confidence: number }[];
}

/** I1 检查：audit 里不该出现 content 变更（触发器已经拦住了，这里是二次对账） */
export function contentAuditRows(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM audit WHERE tbl = 'fact' AND field = 'content'")
    .get() as { n: number };
  return row.n;
}
