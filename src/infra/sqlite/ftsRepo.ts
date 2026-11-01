/**
 * FTS5 全文检索 repo（详设 §6.4.2）。
 *
 * `fact_fts` 在 001_init.sql 里建（`unicode61` 分词），tokens 列存的是
 * `core/parse/tokenize.ts` 的预分词结果。写入同步挂在 `factRepo.insertFact`
 * （同一事务，content 不可变所以只有 insert 路径），查询走本模块。
 *
 * core 层不许裸 SQL（check-lifecycle 拦），所以 BM25 查询也收口在这里，
 * `core/read/recall/bm25.ts` 只负责拼 OR 查询串。
 */
import type { Db } from './db.js';
import { MoshiError } from '../../domain/errors.js';
import { tokenizeForFts } from '../../core/parse/tokenize.js';

export interface Bm25Hit {
  fact_id: string;
  /** bm25() 输出（负数，越负越相关）；排序用 score 升序 */
  score: number;
}

/** 写入/更新一条事实的 FTS 行（同一事务内调用）。tokens 与查询共用 tokenizeForFts */
export function syncFtsRow(db: Db, factId: string, content: string): void {
  const tokens = tokenizeForFts(content);
  db.prepare('DELETE FROM fact_fts WHERE fact_id = ?').run(factId);
  if (tokens.length > 0) {
    db.prepare('INSERT INTO fact_fts(fact_id, tokens) VALUES (?, ?)').run(factId, tokens);
  }
}

/**
 * BM25 查询（详设 §6.4.2 SQL）。`matchQuery` 是 OR 连接的 token 串。
 *
 * 查询失败**必须上抛**：旧实现 `catch { return [] }` 让"FTS 坏了 / MATCH 语法错"
 * 长成"查无结果"，证据包照样 `status:'ok'`（违反 §6.13：查失败绝不报 ok+空）。
 * 上层 `search.ts` 捕获后标 `degraded:["bm25_error"]`，其余两路照常出结果。
 */
export function bm25Search(db: Db, matchQuery: string, k = 20): Bm25Hit[] {
  if (matchQuery.trim() === '') return [];
  try {
    return db
      .prepare(
        `SELECT fact_id, bm25(fact_fts) AS score
           FROM fact_fts
          WHERE fact_fts MATCH ?
          ORDER BY score
          LIMIT ?`,
      )
      .all(matchQuery, k) as Bm25Hit[];
  } catch (err) {
    throw new MoshiError('E_DB', `FTS 查询失败：${(err as Error).message}`, { matchQuery });
  }
}

/** FTS 行数（doctor 校验：== fact 行数） */
export function countFts(db: Db): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM fact_fts').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** 补齐缺失的 FTS 行（历史库升级/导入早于 FTS 上线时用）。返回补齐条数 */
export function syncMissingFts(db: Db): number {
  const rows = db
    .prepare(
      `SELECT f.id, f.content
         FROM fact f
         LEFT JOIN fact_fts x ON x.fact_id = f.id
        WHERE x.fact_id IS NULL`,
    )
    .all() as { id: string; content: string }[];
  for (const r of rows) syncFtsRow(db, r.id, r.content);
  return rows.length;
}
