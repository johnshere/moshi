/**
 * BM25 召回路（详设 §6.4.2）。
 *
 * 只做两件事：把查询文本预分词（与写入同一个函数 tokenizeForFts），
 * 多 token 用 OR 连接后交给 `ftsRepo.bm25Search`。排序、LIMIT、降级
 * 都在 SQL/repo 层；本模块不碰裸 SQL。
 */
import type { Db } from '../../../infra/sqlite/db.js';
import { bm25Search, type Bm25Hit } from '../../../infra/sqlite/ftsRepo.js';
import { orQuery, tokenizeForFts } from '../../parse/tokenize.js';

export { orQuery, tokenizeForFts };

/** BM25 召回：查询串走 tokenizeForFts → OR → top-k。返回按相关性升序（最相关在前） */
export function recallBm25(db: Db, query: string, k = 20): Bm25Hit[] {
  const tokens = tokenizeForFts(query);
  const match = orQuery(tokens);
  return bm25Search(db, match, k);
}
