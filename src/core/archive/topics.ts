/**
 * 主题选取与 slug（详设 §9.1 / §9.2；台账 P1-15）。
 *
 * 候选 = community_id 非空的社区；过滤 fact_count ≥ 8 且
 * （依赖链完整度 ≥ 0.5 或存在 mutually_exclusive 边）；排序 fact_count desc。
 * slug 由 topic_id 派生（label sanitize，冲突加 6 位短哈希），不随标题变。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { sha256Hex } from '../../domain/hash.js';
import { countFactsWithDependency, hasMutexEdge, listTopicCandidates } from '../../infra/sqlite/communityRepo.js';

export interface TopicCandidate {
  communityId: number;
  label: string | null;
  factCount: number;
  /** 依赖链完整度 = 有 depends_on 入/出边的事实数 / 总事实数 */
  chainCompleteness: number;
  hasMutex: boolean;
}

const MIN_FACTS = 8;
const CHAIN_COMPLETENESS_MIN = 0.5;

export function selectTopics(db: Db): TopicCandidate[] {
  const rows = listTopicCandidates(db, MIN_FACTS);

  const topics: TopicCandidate[] = [];
  for (const r of rows) {
    const withDep = countFactsWithDependency(db, r.communityId);
    const hasMutex = hasMutexEdge(db, r.communityId);
    const chainCompleteness = withDep / r.factCount;
    if (chainCompleteness < CHAIN_COMPLETENESS_MIN && !hasMutex) continue;
    topics.push({
      communityId: r.communityId,
      label: r.label === '' ? null : r.label,
      factCount: r.factCount,
      chainCompleteness,
      hasMutex,
    });
  }
  return topics;
}

/** 去 / \ : * ? " < > |，空白→-，截断 40 字符 */
export function sanitizeLabel(label: string): string {
  const s = label
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .trim();
  return s.slice(0, 40);
}

/** slug 由 topic_id 派生：sanitize(label)；冲突时加 6 位短哈希 */
export function slugFor(label: string | null, topicId: number, taken: ReadonlySet<string>): string {
  const base = label === null || label === '' ? `topic-${topicId}` : sanitizeLabel(label);
  if (!taken.has(base)) return base;
  return `${base}-${sha256Hex(String(topicId)).slice(0, 6)}`;
}
