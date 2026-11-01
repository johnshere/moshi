/**
 * query_log / evidence_log 埋点（详设 §6.12；台账 P1-12）。
 *
 * 原则：**尽力而为**——每次查询都写两表，但写失败绝不影响查询响应
 * （内部 try/catch，仅 console.warn）。缓存命中也要写且 query_id 必须
 * 新生成（P1-18 会话内缓存接入时由编排层保证）。flags_json 含开关快照
 * （gat/self_attn/cross_attn/vector/bm25/ppr）。写入是同步的（Node 单线程），
 * "异步"的语义落在**失败不阻塞响应**上：调用方包不包 await 都拿不到抛错。
 */
import type { Db } from './db.js';
import {
  countQueryLogs,
  getQueryLog,
  insertEvidence,
  insertQueryLog,
  markCited,
  resolveMIds,
  type QueryLogInput,
} from './queryLogRepo.js';

export interface EvidenceLogRow {
  queryId: string;
  mId: number;
  factId: string;
  rank: number;
  score: number;
  pool: 'utility' | 'value_floor';
  cited?: boolean;
}

/** 尽力而为写 query_log + evidence_log（同一调用写齐两表），失败只 warn */
export function logQuery(db: Db, log: QueryLogInput, evidence: readonly EvidenceLogRow[]): void {
  try {
    insertQueryLog(db, log);
    insertEvidence(db, evidence);
  } catch (err) {
    console.warn('[logRepo] 埋点写入失败（不影响查询响应）:', err);
  }
}

export { insertQueryLog, insertEvidence, resolveMIds, markCited, countQueryLogs, getQueryLog };
export type { QueryLogInput };
