/**
 * 直写批次仓储（P2-23 / 概设 §3.1.3）。
 *
 * 直写绕过了 harvest 的入队缓冲，所以它必须自带两样东西：**溯源**（origin / session_id /
 * turn / batch_id）和**出口**（按批次整批撤销）。本文件只放这两件事需要的 SQL：
 *
 * - 打标：`markDirectFact` 把 provenance 写进刚建好的 fact 行；
 * - 限速：`countRecentDirect` 数最近一分钟写了多少条（量级约束的分子）；
 * - 撤销：按批次号或按受影响的事实号把行找出来，物理删掉。
 *
 * 硬删 fact 是件危险事——001 里有六处外键指着它（superseded_by / edge.src / edge.dst /
 * feedback / evidence_log / layout），外加 fact_fts 与 fact_vec 两张派生表不归 SQLite 管。
 * `removeFact` 的职责就是把这六处 + 两张派生表一起收干净，否则撤销会卡在外键上。
 */
import { deleteVec, vectorDisabled } from '../vec/index.js';
import type { Edge, Fact } from '../../domain/types.js';
import type { Db } from './db.js';
import { rowToEdge, rowToFact } from './mappers.js';

/** 直写行的 origin 取值（概设 §3.1.3③ 明确规定，不要改） */
export const DIRECT_ORIGIN = 'mcp_direct';

export interface DirectMark {
  sessionId: string | null;
  turn: number | null;
  batchId: string;
}

/** 给刚建好的事实打上直写溯源；只对本批**新建**的行调用，复用旧行时打标会让撤销误删历史 */
export function markDirectFact(db: Db, factId: string, mark: DirectMark): void {
  db.prepare(
    `UPDATE fact SET origin = @origin, session_id = @session, turn = @turn, batch_id = @batch
     WHERE id = @id`,
  ).run({
    origin: DIRECT_ORIGIN,
    session: mark.sessionId,
    turn: mark.turn,
    batch: mark.batchId,
    id: factId,
  });
}

/** 最近一分钟的直写事实数（量级约束；只数直写，别的来源不占这个额度） */
export function countRecentDirect(db: Db, sinceIso: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM fact WHERE origin = ? AND created_at >= ?')
    .get(DIRECT_ORIGIN, sinceIso) as { n: number };
  return row.n;
}

export function listFactsByBatch(db: Db, batchId: string): Fact[] {
  const rows = db
    .prepare('SELECT * FROM fact WHERE batch_id = ? ORDER BY created_at ASC, id ASC')
    .all(batchId) as Record<string, unknown>[];
  return rows.map(rowToFact);
}

export function listEdgesByBatch(db: Db, batchId: string): Edge[] {
  const rows = db
    .prepare('SELECT * FROM edge WHERE batch_id = ? ORDER BY recorded_at ASC, id ASC')
    .all(batchId) as Record<string, unknown>[];
  return rows.map(rowToEdge);
}

/**
 * 端点落在给定事实上的全部边——包括**别的批次**写的边。
 * 事实硬删之前必须先把它们找出来：外键 ON，直接 DELETE fact 会被 SQLite 拒。
 */
export function listEdgesTouching(db: Db, factIds: readonly string[]): Edge[] {
  if (factIds.length === 0) return [];
  const out: Edge[] = [];
  // SQLite 默认上限 999 个变量，切块保守一点
  for (let i = 0; i < factIds.length; i += 400) {
    const chunk = factIds.slice(i, i + 400);
    const marks = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT * FROM edge WHERE src IN (${marks}) OR dst IN (${marks})`)
      .all(...chunk, ...chunk) as Record<string, unknown>[];
    out.push(...rows.map(rowToEdge));
  }
  return out;
}

export function removeEdge(db: Db, edgeId: string): void {
  db.prepare('DELETE FROM edge WHERE id = ?').run(edgeId);
}

/**
 * 物理删除一条事实及其全部引用。
 *
 * 顺序有讲究：先断开事实之间的引用与推理投影，再删索引/向量，最后删主行。
 * `evidence_log` 是被删事实在历史查询里留下的引用——留着会让外键失败，
 * 所以一并删除；查询本身（query_log）保留，历史查询记录不受影响。
 */
export function removeFact(db: Db, factId: string): void {
  db.prepare('UPDATE fact SET superseded_by = NULL WHERE superseded_by = ?').run(factId);
  db.prepare('DELETE FROM feedback WHERE fact_id = ?').run(factId);
  db.prepare('DELETE FROM evidence_log WHERE fact_id = ?').run(factId);
  db.prepare('DELETE FROM layout WHERE fact_id = ?').run(factId);
  db.prepare('DELETE FROM edge WHERE src = ? OR dst = ?').run(factId, factId);
  db.prepare('DELETE FROM fact_fts WHERE fact_id = ?').run(factId);
  if (!vectorDisabled(db)) deleteVec(db, factId);
  db.prepare('DELETE FROM fact WHERE id = ?').run(factId);
}
