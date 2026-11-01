/**
 * `memory_feedback` 的实现（详设 §4.1.3）。
 *
 * 关键点只有一个：**`m_ids` 不是 fact_id，必须在 `query_id` 的上下文里翻译**。
 * `[M1]` 只对产生它的那次查询有意义——跨查询复用编号会把反馈记到别的事实上，
 * 而且完全无声（id 合法、写入成功、统计全错）。
 *
 * 因此 `query_id` 查不到时直接报 `E_NOT_FOUND`，不做"猜一条最像的"这种兜底：
 * 反馈是训练与调权的输入，宁可让 Agent 重新查询，也不要污染信号。
 */
import { MoshiError } from '../../domain/errors.js';
import * as feedbackRepo from '../../infra/sqlite/feedbackRepo.js';
import * as queryLogRepo from '../../infra/sqlite/queryLogRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import type { McpDeps } from './deps.js';
import type { FeedbackInput } from './schemas.js';

export interface FeedbackResult {
  inserted: number;
  duplicates: number;
  /** 成功解析并记录的 `[M#]` → `fact_id` */
  resolved: { m_id: number; fact_id: string }[];
  /** 该 `query_id` 下不存在的编号（例如 Agent 记错了） */
  unresolved_m_ids: number[];
}

export function runMemoryFeedback(deps: McpDeps, input: FeedbackInput): FeedbackResult {
  const log = queryLogRepo.getQueryLog(deps.db, input.query_id);
  if (log === null) {
    throw new MoshiError('E_NOT_FOUND', `query_id 不存在：${input.query_id}`, {
      queryId: input.query_id,
    });
  }

  const wanted = [...new Set(input.m_ids)].sort((a, b) => a - b);
  const pairs = queryLogRepo.resolveMIds(deps.db, input.query_id, wanted);
  const found = new Set(pairs.map((p) => p.mId));
  const unresolved = wanted.filter((m) => !found.has(m));

  const result: FeedbackResult = { inserted: 0, duplicates: 0, resolved: [], unresolved_m_ids: unresolved };

  withTransaction(deps.db, () => {
    for (const p of pairs) {
      const r = feedbackRepo.insertFeedback(deps.db, {
        queryId: input.query_id,
        factId: p.factId,
        verdict: input.verdict,
        note: input.note ?? null,
        source: 'mcp',
      });
      if (r.created) result.inserted += 1;
      else result.duplicates += 1;
      result.resolved.push({ m_id: p.mId, fact_id: p.factId });
    }
    // "用过"这件事落在 evidence_log 上：adopt / correct 都算被引用
    if (input.verdict !== 'reject') {
      queryLogRepo.markCited(deps.db, input.query_id, pairs.map((p) => p.mId));
    }
  });

  return result;
}
