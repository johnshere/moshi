/**
 * 隔离区仓储（详设 §5.9）。
 *
 * 隔离区的语义是"**先扣下，等人来看**"，所以：
 * - 只追加、只标记，不物理删除（`resolved` 两种终态都是留痕）；
 * - 已处理的条目不能再被处理第二次（`WHERE resolved IS NULL`），否则 UI 上两次点击
 *   会把同一批事实入图两次——虽然幂等键挡住了重复行，但 `harvested_at` 与审计会乱。
 */
import { MoshiError } from '../../domain/errors.js';
import type { QuarantineReason } from '../../domain/enums.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from './db.js';

export interface QuarantineRow {
  id: string;
  payloadJson: string;
  reason: QuarantineReason;
  ts: string;
  resolved: 'accepted' | 'dropped' | null;
  resolvedAt: string | null;
}

function rowToQuarantine(r: Record<string, unknown>): QuarantineRow {
  return {
    id: String(r['id']),
    payloadJson: String(r['payload_json']),
    reason: String(r['reason']) as QuarantineReason,
    ts: String(r['ts']),
    resolved: (r['resolved'] as 'accepted' | 'dropped' | null) ?? null,
    resolvedAt: (r['resolved_at'] as string | null) ?? null,
  };
}

export function insert(
  db: Db,
  input: { payloadJson: string; reason: QuarantineReason; ts?: string },
): string {
  const id = newId('quarantine');
  db.prepare(
    `INSERT INTO quarantine (id, payload_json, reason, ts, resolved, resolved_at)
     VALUES (@id, @payload, @reason, @ts, NULL, NULL)`,
  ).run({
    id,
    payload: input.payloadJson,
    reason: input.reason,
    ts: input.ts ?? nowIso(),
  });
  return id;
}

export function listOpen(db: Db, limit = 100): QuarantineRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM quarantine WHERE resolved IS NULL
        ORDER BY ts ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToQuarantine);
}

export function get(db: Db, id: string): QuarantineRow | null {
  const row = db.prepare('SELECT * FROM quarantine WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : rowToQuarantine(row);
}

/** 标记终态。已处理过的条目再处理一次直接报错——静默成功会让 UI 以为改成功了。 */
export function markResolved(
  db: Db,
  id: string,
  resolved: 'accepted' | 'dropped',
  ts?: string,
): void {
  const info = db
    .prepare('UPDATE quarantine SET resolved = ?, resolved_at = ? WHERE id = ? AND resolved IS NULL')
    .run(resolved, ts ?? nowIso(), id);
  if (info.changes === 0) {
    throw new MoshiError('E_INPUT', `隔离条目不存在或已处理：${id}`, { id, resolved });
  }
}

export function countOpen(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM quarantine WHERE resolved IS NULL').get() as {
    n: number;
  };
  return row.n;
}

export function countByReason(db: Db): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT reason, COUNT(*) AS n FROM quarantine WHERE resolved IS NULL GROUP BY reason`,
    )
    .all() as { reason: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.reason] = r.n;
  return out;
}

/**
 * `mutex_storm` 判据：同一 `canonical_key` 在窗口内出现多少个**不同取值**。
 * 数 `DISTINCT value_hash` 而不是行数——同一取值重复 500 次是正常刷新，
 * 500 个不同取值才是消解或基数性出了问题。
 */
export function countDistinctValuesSince(
  db: Db,
  canonicalKey: string,
  scope: string,
  since: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT value_hash) AS n FROM fact
        WHERE canonical_key = ? AND scope = ? AND recorded_at >= ?`,
    )
    .get(canonicalKey, scope, since) as { n: number };
  return row.n;
}
