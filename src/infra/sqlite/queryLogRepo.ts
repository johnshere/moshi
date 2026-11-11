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
import type { CallerKind } from '../../domain/access.js';
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
  /** 接入层（P2）：入口类型 / 接入点 id / 插件名；迁移前的历史行是 null */
  callerId?: string | null;
  callerKind?: CallerKind | null;
  pluginId?: string | null;
  /** 回执号：把注入（钩子侧）与这一行对上（Z-01C-e） */
  corrId?: string | null;
  /** 证据包状态 `ok|degraded` */
  status?: string | null;
  /** 入/出字节：查询文本与证据包的 UTF-8 字节数 */
  inBytes?: number | null;
  outBytes?: number | null;
}

export function insertQueryLog(db: Db, input: QueryLogInput): void {
  db.prepare(
    `INSERT INTO query_log (
       id, ts, session, query_text, query_hash, route, flags_json, candidates_json,
       fused_json, packed_json, degraded_json, truncated, coverage, latency_ms,
       stage_ms_json, cached, caller_id, caller_kind, plugin_id, corr_id, status,
       in_bytes, out_bytes
     ) VALUES (
       @id, @ts, @session, @text, @hash, @route, @flags, @candidates,
       @fused, @packed, @degraded, @truncated, @coverage, @latency,
       @stage, @cached, @callerId, @callerKind, @pluginId, @corrId, @status,
       @inBytes, @outBytes
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
    callerId: input.callerId ?? null,
    callerKind: input.callerKind ?? null,
    pluginId: input.pluginId ?? null,
    corrId: input.corrId ?? null,
    status: input.status ?? null,
    inBytes: input.inBytes ?? null,
    outBytes: input.outBytes ?? null,
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
 * 分批删除早于 `before` 的查询埋点（P2 保留清理；`storage.query_log_keep_days`）。
 *
 * 先删 `evidence_log` 子行：它的 `query_id` 有外键指向 `query_log`，
 * 顺序反了会直接抛 FOREIGN KEY constraint failed。返回实际删除的行数。
 */
export function deleteQueryLogsBefore(db: Db, before: string, limit: number): number {
  const ids = db
    .prepare('SELECT id FROM query_log WHERE ts < ? ORDER BY ts ASC LIMIT ?')
    .all(before, limit) as { id: string }[];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const keyed = ids.map((row) => row.id);
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM evidence_log WHERE query_id IN (${placeholders})`).run(...keyed);
    return db.prepare(`DELETE FROM query_log WHERE id IN (${placeholders})`).run(...keyed).changes;
  });
  return run();
}

/**
 * 最近 `limit` 条**带 `stage_ms_json.subgraph_nodes` 埋点**的查询的平均子图节点数
 * （详设 §7.6 门槛 2）。
 *
 * 只统计有埋点的行：P3-07 之前的查询没这个字段，把它算成 0 会凭空拉低密度。
 */export function recentSubgraphNodeStats(
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

/** 接入层日志读模型的一行（P3；`src/app/access/logQuery.ts` 只做形状加工） */
export interface QueryLogRow {
  id: string;
  ts: string;
  callerId: string | null;
  callerKind: string | null;
  pluginId: string | null;
  corrId: string | null;
  status: string | null;
  inBytes: number | null;
  outBytes: number | null;
  latencyMs: number | null;
  packedJson: string | null;
  queryText: string | null;
}

export interface QueryLogListFilter {
  /** 精确匹配 `caller_id`；与 `unknownCaller` 互斥 */
  callerId?: string;
  /** 历史行 `caller_id IS NULL`（读模型里叫 unknown） */
  unknownCaller?: boolean;
  callerKind?: string;
  unknownKind?: boolean;
  status?: string;
  /** 查询文本 LIKE（不引 FTS） */
  q?: string;
  /** 只取 `ts <= cursorTs`（keyset 候选范围） */
  cursorTs?: string;
  /** 只取 `ts >= sinceTs`（统计窗口） */
  sinceTs?: string;
}

const LOG_ROW_COLUMNS =
  'id, ts, caller_id, caller_kind, plugin_id, corr_id, status, in_bytes, out_bytes, ' +
  'latency_ms, packed_json, query_text';

function toQueryLogRow(row: Record<string, unknown>): QueryLogRow {
  return {
    id: String(row['id']),
    ts: String(row['ts']),
    callerId: row['caller_id'] === null ? null : String(row['caller_id']),
    callerKind: row['caller_kind'] === null ? null : String(row['caller_kind']),
    pluginId: row['plugin_id'] === null ? null : String(row['plugin_id']),
    corrId: row['corr_id'] === null ? null : String(row['corr_id']),
    status: row['status'] === null ? null : String(row['status']),
    inBytes: row['in_bytes'] === null ? null : Number(row['in_bytes']),
    outBytes: row['out_bytes'] === null ? null : Number(row['out_bytes']),
    latencyMs: row['latency_ms'] === null ? null : Number(row['latency_ms']),
    packedJson: typeof row['packed_json'] === 'string' ? row['packed_json'] : null,
    queryText: typeof row['query_text'] === 'string' ? row['query_text'] : null,
  };
}

/** 列表（keyset 分页）：`ts DESC, id DESC`，`limit` 由调用方按需给 */
export function listQueryLogs(db: Db, filter: QueryLogListFilter, limit: number): QueryLogRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.unknownCaller === true) {
    where.push('caller_id IS NULL');
  } else if (filter.callerId !== undefined) {
    where.push('caller_id = ?');
    params.push(filter.callerId);
  }
  if (filter.unknownKind === true) {
    where.push('caller_kind IS NULL');
  } else if (filter.callerKind !== undefined) {
    where.push('caller_kind = ?');
    params.push(filter.callerKind);
  }
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.q !== undefined) {
    where.push("query_text LIKE '%' || ? || '%'");
    params.push(filter.q);
  }
  if (filter.cursorTs !== undefined) {
    where.push('ts <= ?');
    params.push(filter.cursorTs);
  }
  if (filter.sinceTs !== undefined) {
    where.push('ts >= ?');
    params.push(filter.sinceTs);
  }
  const sql =
    `SELECT ${LOG_ROW_COLUMNS} FROM query_log` +
    (where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`) +
    (filter.sinceTs !== undefined ? ' ORDER BY ts DESC' : ' ORDER BY ts DESC, id DESC LIMIT ?');
  const rows =
    filter.sinceTs !== undefined
      ? (db.prepare(sql).all(...params) as Record<string, unknown>[])
      : (db.prepare(sql).all(...params, limit) as Record<string, unknown>[]);
  return rows.map(toQueryLogRow);
}

/** 统计窗口内的全部行（只带计数需要的列，不带正文） */
export function listQueryLogsSince(db: Db, sinceTs: string): QueryLogRow[] {
  const rows = db
    .prepare(
      'SELECT id, ts, caller_id, caller_kind, status, latency_ms, in_bytes, out_bytes ' +
        'FROM query_log WHERE ts >= ? ORDER BY ts DESC',
    )
    .all(sinceTs) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row['id']),
    ts: String(row['ts']),
    callerId: row['caller_id'] === null ? null : String(row['caller_id']),
    callerKind: row['caller_kind'] === null ? null : String(row['caller_kind']),
    pluginId: null,
    corrId: null,
    status: row['status'] === null ? null : String(row['status']),
    inBytes: row['in_bytes'] === null ? null : Number(row['in_bytes']),
    outBytes: row['out_bytes'] === null ? null : Number(row['out_bytes']),
    latencyMs: row['latency_ms'] === null ? null : Number(row['latency_ms']),
    packedJson: null,
    queryText: null,
  }));
}

export function countTableRows(db: Db, table: 'query_log' | 'evidence_log'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** 清空检索日志（设置页维护动作）：先删子行再删主表，同一事务 */
export function purgeAllQueryLogs(db: Db): { queryLog: number; evidenceLog: number } {
  const run = db.transaction(() => {
    const evidenceLog = db.prepare('DELETE FROM evidence_log').run().changes;
    const queryLog = db.prepare('DELETE FROM query_log').run().changes;
    return { queryLog, evidenceLog };
  });
  return run();
}
