/**
 * 查询埋点仓储（详设 §6.12 / §4.4）。
 *
 * `query_log` 与 `evidence_log` 是**证据包的唯一可回溯来源**：
 * Agent 回传的 `m_ids` 只有在这里才能翻译成 `fact_id`（`memory_feedback` 靠它），
 * 而 `[M#]` 之所以能"只在本轮有意义"，就是因为这张表把编号绑定在 `query_id` 上。
 *
 * 所以这里只做两件事：写（一次查询一批）与读（按 `query_id` 反解 `m_id`）。
 * 没有 update / delete——埋点是流水账，改了就失去诊断价值。
 */
import type { Pool, Route } from '../../domain/enums.js';
import type { Db } from './db.js';

export interface QueryLogInput {
  id: string;
  ts: string;
  queryText: string;
  queryHash: string;
  route: Route;
  /** 开关快照：`{gat,self_attn,cross_attn,vector,bm25,ppr}` */
  flags: Record<string, unknown>;
  candidates?: Record<string, unknown> | null;
  fused?: unknown[] | null;
  packed?: readonly string[] | null;
  degraded?: readonly string[] | null;
  truncated?: boolean;
  coverage?: string | null;
  latencyMs: number;
  stageMs?: Record<string, number> | null;
  cached?: boolean;
  session?: string | null;
}

export function insertQueryLog(db: Db, input: QueryLogInput): void {
  db.prepare(
    `INSERT INTO query_log (
       id, ts, session, query_text, query_hash, route, flags_json, candidates_json,
       fused_json, packed_json, degraded_json, truncated, coverage, latency_ms,
       stage_ms_json, cached
     ) VALUES (
       @id, @ts, @session, @text, @hash, @route, @flags, @candidates,
       @fused, @packed, @degraded, @truncated, @coverage, @latency,
       @stage, @cached
     )`,
  ).run({
    id: input.id,
    ts: input.ts,
    session: input.session ?? null,
    text: input.queryText,
    hash: input.queryHash,
    route: input.route,
    flags: JSON.stringify(input.flags),
    candidates: input.candidates === undefined || input.candidates === null
      ? null
      : JSON.stringify(input.candidates),
    fused: input.fused === undefined || input.fused === null ? null : JSON.stringify(input.fused),
    packed: input.packed === undefined || input.packed === null ? null : JSON.stringify(input.packed),
    degraded: input.degraded === undefined || input.degraded === null
      ? null
      : JSON.stringify(input.degraded),
    truncated: input.truncated === true ? 1 : 0,
    coverage: input.coverage ?? null,
    latency: input.latencyMs,
    stage: input.stageMs === undefined || input.stageMs === null ? null : JSON.stringify(input.stageMs),
    cached: input.cached === true ? 1 : 0,
  });
}

export interface EvidenceLogInput {
  queryId: string;
  /** 从 1 开始连续，对应证据包里的 `[M#]` */
  mId: number;
  factId: string;
  rank: number;
  score: number;
  pool: Pool;
  cited?: boolean;
}

export function insertEvidence(db: Db, rows: readonly EvidenceLogInput[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO evidence_log (query_id, m_id, fact_id, rank, score, pool, cited)
     VALUES (@queryId, @mId, @factId, @rank, @score, @pool, @cited)`,
  );
  for (const r of rows) {
    stmt.run({
      queryId: r.queryId,
      mId: r.mId,
      factId: r.factId,
      rank: r.rank,
      score: r.score,
      pool: r.pool,
      cited: r.cited === true ? 1 : 0,
    });
  }
}

/**
 * `m_id` → `fact_id`。**只在指定的 `query_id` 内解析**——
 * 跨查询复用编号会把反馈记到上一轮的事实上，而且完全无声。
 */
export function resolveMIds(
  db: Db,
  queryId: string,
  mIds: readonly number[],
): { mId: number; factId: string }[] {
  if (mIds.length === 0) return [];
  const placeholders = mIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m_id, fact_id FROM evidence_log
        WHERE query_id = ? AND m_id IN (${placeholders})
        ORDER BY m_id ASC`,
    )
    .all(queryId, ...mIds) as { m_id: number; fact_id: string }[];
  return rows.map((r) => ({ mId: r.m_id, factId: r.fact_id }));
}

export function getQueryLog(db: Db, queryId: string): { id: string; ts: string; route: Route } | null {
  const row = db
    .prepare('SELECT id, ts, route FROM query_log WHERE id = ?')
    .get(queryId) as { id: string; ts: string; route: Route } | undefined;
  return row ?? null;
}

export function countQueryLogs(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number };
  return row.n;
}

/**
 * 最近 `limit` 条**带 `stage_ms_json.subgraph_nodes` 埋点**的查询的平均子图节点数
 * （详设 §7.6 门槛 2）。
 *
 * 只统计有埋点的行：P3-07 之前的查询没这个字段，把它算成 0 会凭空拉低密度。
 */
export function recentSubgraphNodeStats(
  db: Db,
  limit: number,
): { avg: number | null; observed: number } {
  const row = db
    .prepare(
      `SELECT AVG(json_extract(stage_ms_json, '$.subgraph_nodes')) AS avg, COUNT(*) AS n
         FROM (SELECT stage_ms_json FROM query_log
                WHERE json_extract(stage_ms_json, '$.subgraph_nodes') IS NOT NULL
                ORDER BY ts DESC LIMIT ?)`,
    )
    .get(limit) as { avg: number | null; n: number };
  return { avg: row.avg, observed: row.n };
}

export function markCited(db: Db, queryId: string, mIds: readonly number[]): void {
  if (mIds.length === 0) return;
  const placeholders = mIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE evidence_log SET cited = 1 WHERE query_id = ? AND m_id IN (${placeholders})`,
  ).run(queryId, ...mIds);
}
