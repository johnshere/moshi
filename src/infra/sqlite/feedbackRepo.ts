/**
 * 反馈仓储（详设 §4.1.3）。
 *
 * 幂等键是 `(query_id, fact_id, verdict)`——同一条反馈重复提交必须返回同样结果。
 * 幂等由**唯一索引**保证，不是"先查再插"：后者在并发提交时会双写，
 * 而反馈是 Agent 在对话里随时可能重发的东西，重复是常态。
 *
 * 注意 `query_id` 可空（DDL 里如此，允许"不知道来自哪次查询"的人工反馈）；
 * SQLite 的唯一索引把 NULL 视为互不相等，所以空 `query_id` 的行可以有多条——
 * 这正是想要的行为，MCP 面则强制要求 `query_id`。
 */
import { MoshiError } from '../../domain/errors.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Verdict } from '../../domain/enums.js';
import type { Db } from './db.js';

export interface FeedbackInput {
  queryId: string | null;
  factId: string;
  verdict: Verdict;
  note?: string | null;
  source?: string | null;
  ts?: string;
}

export interface FeedbackRow {
  id: string;
  queryId: string | null;
  factId: string;
  verdict: Verdict;
  ts: string;
  source: string | null;
  note: string | null;
}

/**
 * 写入一条反馈。返回 `created=false` 表示幂等命中（三元组已存在）。
 *
 * 用 `ON CONFLICT DO NOTHING` + `changes()`：没有 `DO UPDATE` 分支，
 * `changes()` 为 0 就一定是"被唯一索引挡下"，语义明确。
 */
export function insertFeedback(db: Db, input: FeedbackInput): { id: string; created: boolean } {
  const id = newId('feedback');
  const info = db
    .prepare(
      `INSERT INTO feedback (id, query_id, fact_id, verdict, ts, source, note)
       VALUES (@id, @queryId, @factId, @verdict, @ts, @source, @note)
       ON CONFLICT (query_id, fact_id, verdict) DO NOTHING`,
    )
    .run({
      id,
      queryId: input.queryId,
      factId: input.factId,
      verdict: input.verdict,
      ts: input.ts ?? nowIso(),
      source: input.source ?? null,
      note: input.note ?? null,
    });
  if (info.changes > 0) return { id, created: true };

  const existing = db
    .prepare(
      `SELECT id FROM feedback
        WHERE query_id IS ? AND fact_id = ? AND verdict = ?`,
    )
    .get(input.queryId, input.factId, input.verdict) as { id: string } | undefined;
  if (existing === undefined) {
    throw new MoshiError('E_DB', `反馈写入后既没插入也查不到：${input.factId}`, {
      factId: input.factId,
    });
  }
  return { id: existing.id, created: false };
}

export function listByFact(db: Db, factId: string): FeedbackRow[] {
  const rows = db
    .prepare('SELECT * FROM feedback WHERE fact_id = ? ORDER BY ts ASC, id ASC')
    .all(factId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r['id']),
    queryId: (r['query_id'] as string | null) ?? null,
    factId: String(r['fact_id']),
    verdict: String(r['verdict']) as Verdict,
    ts: String(r['ts']),
    source: (r['source'] as string | null) ?? null,
    note: (r['note'] as string | null) ?? null,
  }));
}

export function countFeedback(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM feedback').get() as { n: number };
  return row.n;
}
