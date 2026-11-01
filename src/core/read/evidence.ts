/**
 * 证据包组装与编号（详设 §6.9 / §4.4，schema `moshi-evidence/1`）。
 *
 * 装箱产物按序编号 m_id=1..N；evidence[] 字段见 §4.4；conflicts 只留两端
 * 都在 evidence 里的对；dependency_summary 取子图 depends_on 边（最多 10 条）；
 * topic_hint 取 packed facts 中出现最多的 community_id（community_summary 无
 * 摘要或该 community 无记录 → null + coverage:'partial'）；numbered_list 按
 * §6.9 格式，disputed 标（存疑）；confidence_summary/advice 按 §6.9 取值表；
 * status = degraded 非空 ? 'degraded' : 'ok'。
 *
 * 纪律：source_ref 在 JSON 里带、text 格式由 MCP 层剥掉（本模块产出 JSON 形态）；
 * numbered_list 不含 fact_id。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { getLatestSummary } from '../../infra/sqlite/communityRepo.js';
import type { SubgraphEdge } from './subgraph.js';
import type { PackItem } from './pack.js';

export interface ConflictEntry {
  a: string;
  b: string;
  type: string;
  /** 裁决胜者的 fact_id；null = 未裁决（详设 §4.4 示例里这个位置放的就是胜者 id） */
  resolved: string | null;
  rule: string;
}

export interface DependencySummaryEntry {
  from: string;
  to: string;
  edge: string;
  stale: boolean;
}

export interface TopicHint {
  community_id: number | null;
  label: string | null;
  fact_count: number;
  derived_at: string | null;
  uri: string | null;
}

export interface EvidenceEntry {
  m_id: number;
  fact_id: string;
  content: string;
  ftype: string;
  confidence: number;
  confidence_source: string;
  strength: number;
  pool: string;
  epistemic_status: string;
  valid_at: string;
  valid_to: string | null;
  recorded_at: string;
  subject: { entity_id: string; name: string };
  predicate: string;
  value: unknown;
  source_ref: { episode_id: string | null; span: [number, number] | null } | null;
  flags: string[];
}

export interface EvidencePackage {
  schema: 'moshi-evidence/1';
  query_id: string;
  status: 'ok' | 'degraded';
  route: 'local' | 'global';
  degraded: string[];
  truncated: boolean;
  coverage: 'full' | 'partial';
  identity: 'resolved' | 'unresolved';
  confidence_summary: 'high' | 'medium' | 'low' | 'none';
  advice: string;
  evidence: EvidenceEntry[];
  conflicts: ConflictEntry[];
  dependency_summary: DependencySummaryEntry[];
  topic_hint: TopicHint;
  numbered_list: string[];
  stats: { candidates: number; packed: number; tokens: number; latency_ms: number };
}

export interface AssembleOptions {
  route: 'local' | 'global';
  degraded: string[];
  edges?: readonly SubgraphEdge[];
  conflicts?: readonly ConflictEntry[];
  latencyMs: number;
  candidates: number;
  now?: string;
}

/** 本地日期 yyyy-mm-dd（UTC+8 不考虑时区换算，直接取 ISO 前 10 位，够用且稳定） */
function localDate(iso: string): string {
  return iso.slice(0, 10);
}

export function assembleEvidence(
  db: Db,
  queryId: string,
  packed: readonly PackItem[],
  opts: AssembleOptions,
): EvidencePackage {
  void opts.now; // 保留注入位：时间线窗口扩展预留（P2 生命周期时间线用）

  const evidence: EvidenceEntry[] = packed.map((item, i) => ({
    m_id: i + 1,
    fact_id: item.fact.id,
    content: item.packedText,
    ftype: item.fact.ftype,
    confidence: item.fact.confidence,
    confidence_source: item.fact.confidenceSource,
    strength: item.fact.strength,
    pool: item.fact.pool,
    epistemic_status: item.fact.epistemicStatus,
    valid_at: item.fact.validAt,
    valid_to: item.fact.validTo,
    recorded_at: item.fact.recordedAt,
    subject: item.fact.attrs.frozen.subject,
    predicate: item.fact.attrs.frozen.predicate,
    value: item.fact.attrs.frozen.value,
    source_ref:
      item.fact.sourceEpisode === null && item.fact.span === null
        ? null
        : { episode_id: item.fact.sourceEpisode, span: item.fact.span },
    flags: item.fact.epistemicStatus === 'disputed' ? ['disputed'] : [...item.flags],
  }));

  // ── conflicts：只留两端都在 evidence ──
  const inEvidence = new Set(evidence.map((e) => e.fact_id));
  const conflicts = (opts.conflicts ?? []).filter((c) => inEvidence.has(c.a) && inEvidence.has(c.b));

  // ── dependency_summary：子图 depends_on 边（最多 10 条）──
  // stale：被依赖端（src）在 packed 中且 epistemic_status ∈ {invalidated, pruned}
  //（与 §6.7 ④ 的 stale_dependency 语义对齐；src 不在候选里无法判定 → false）
  const depEdges = (opts.edges ?? []).filter((e) => e.etype === 'depends_on').slice(0, 10);
  const statusOf = new Map<string, string>(packed.map((p) => [p.fact.id, p.fact.epistemicStatus]));
  const dependency_summary: DependencySummaryEntry[] = depEdges.map((e) => ({
    from: e.src,
    to: e.dst,
    edge: e.etype,
    stale: ['invalidated', 'pruned'].includes(statusOf.get(e.src) ?? ''),
  }));

  // ── topic_hint：packed facts 众数 community_id ──
  const counts = new Map<number, number>();
  for (const item of packed) {
    if (item.fact.communityId === null) continue;
    counts.set(item.fact.communityId, (counts.get(item.fact.communityId) ?? 0) + 1);
  }
  let topicCommunity: number | null = null;
  let topicCount = 0;
  for (const [id, n] of counts) {
    if (n > topicCount) {
      topicCommunity = id;
      topicCount = n;
    }
  }
  let topicHint: TopicHint;
  let coverage: 'full' | 'partial' = 'full';
  if (topicCommunity === null) {
    topicHint = { community_id: null, label: null, fact_count: 0, derived_at: null, uri: null };
    coverage = 'partial';
  } else {
    const cs = getLatestSummary(db, topicCommunity);
    if (cs === null || cs.summary.length === 0) {
      topicHint = { community_id: topicCommunity, label: null, fact_count: 0, derived_at: null, uri: null };
      coverage = 'partial';
    } else {
      topicHint = {
        community_id: topicCommunity,
        label: cs.label,
        fact_count: cs.factCount,
        derived_at: cs.derivedAt,
        uri: `moshi://topic/${cs.label ?? topicCommunity}`,
      };
    }
  }

  // ── numbered_list ──
  const numbered_list = evidence.map((e) => {
    const range = e.valid_to ? ` ${localDate(e.valid_at)} 至 ${localDate(e.valid_to)}` : ` ${localDate(e.valid_at)} 起`;
    const doubt = e.epistemic_status === 'disputed' || e.flags.includes('disputed') ? '（存疑）' : '';
    return `[M${e.m_id}] (${e.confidence},${range}) ${e.content}${doubt}`;
  });

  // ── confidence_summary / advice ──
  const maxConf = evidence.length === 0 ? 0 : Math.max(...evidence.map((e) => e.confidence));
  let confidence_summary: 'high' | 'medium' | 'low' | 'none';
  let advice: string;
  if (evidence.length === 0) {
    confidence_summary = 'none';
    advice = '无可靠记忆，请勿臆断';
  } else if (maxConf >= 0.85) {
    confidence_summary = 'high';
    advice = '以上为当前可检索到的高置信记忆；关键结论请结合当下观测复核。';
  } else if (maxConf >= 0.6) {
    confidence_summary = 'medium';
    advice = '以上为中置信记忆；若有冲突请以最新观测为准。';
  } else {
    confidence_summary = 'low';
    advice = '以上记忆置信度偏低，请谨慎采信。';
  }

  const identity: 'resolved' | 'unresolved' = evidence.some((e) => e.flags.includes('identity_unresolved'))
    ? 'unresolved'
    : 'resolved';

  return {
    schema: 'moshi-evidence/1',
    query_id: queryId,
    status: opts.degraded.length > 0 ? 'degraded' : 'ok',
    route: opts.route,
    degraded: opts.degraded,
    // 截断 = "候选比入包多"（详设 §6.9）：装箱/top-k 任一原因丢的都算。
    // 不能用 `evidence.length < packed.length`——evidence 就是 packed 逐条映射，恒 false。
    truncated: opts.candidates > evidence.length,
    coverage,
    identity,
    confidence_summary,
    advice,
    evidence,
    conflicts,
    dependency_summary,
    topic_hint: topicHint,
    numbered_list,
    stats: {
      candidates: opts.candidates,
      packed: evidence.length,
      tokens: packed.reduce((a, p) => a + p.tokens, 0),
      latency_ms: opts.latencyMs,
    },
  };
}
