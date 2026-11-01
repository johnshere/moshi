/**
 * `memory_query` 的实现（详设 §4.1.1 / §4.4）。
 *
 * **Phase 0 的诚实说明**：三路召回（向量 / BM25 / PPR）在 Phase 1 才建，
 * 这里只做"关键词直查 + 强度排序"。因此证据包一律 `status: "degraded"`，
 * `degraded` 里如实列出 `no_vector` / `no_bm25` / `no_ppr`。
 *
 * 为什么不在 Phase 0 假装 `status: "ok"`：证据包的 `status` 是给宿主看的**质量信号**，
 * 撒谎的代价是 Agent 在召回很差时仍然自信作答——这比"暂时没有记忆"糟糕得多。
 * 概设 §1.5 的"降级必须静默"说的是不报错、不打扰，不是不告诉宿主"这一包不完整"。
 *
 * 另外两件事这一层必须做对，否则 Phase 1 换掉召回时会被带着一起改：
 * - `m_id` 从 1 连续，并**写进 `evidence_log`**——`memory_feedback` 靠它把 `[M#]` 翻回 `fact_id`；
 * - `numbered_list` 不含 `fact_id`（详设 §4.4 字段纪律），避免 Agent 把 id 抄进回复。
 */
import { canonicalJson, sha256Hex } from '../../domain/hash.js';
import { newId } from '../../domain/ids.js';
import { estimateTokens } from '../../domain/text.js';
import { nowIso } from '../../domain/time.js';
import type { ConfSource, Degraded, Epistemic, Ftype, Pool, Status } from '../../domain/enums.js';
import type { Fact } from '../../domain/types.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import * as queryLogRepo from '../../infra/sqlite/queryLogRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import type { McpDeps } from './deps.js';
import type { QueryInput } from './schemas.js';

export interface EvidenceItemJson {
  m_id: number;
  fact_id: string;
  content: string;
  ftype: Ftype;
  confidence: number;
  confidence_source: ConfSource;
  strength: number;
  pool: Pool;
  epistemic_status: Epistemic;
  valid_at: string;
  valid_to: string | null;
  recorded_at: string;
  subject: { entity_id: string; name: string };
  predicate: string;
  value: unknown;
  source_ref: { episode_id: string | null; span: [number, number] | null };
  flags: string[];
}

export interface EvidencePackJson {
  schema: 'moshi-evidence/1';
  query_id: string;
  status: Status;
  route: 'local' | 'global';
  degraded: Degraded[];
  truncated: boolean;
  coverage: 'full' | 'partial';
  identity: 'resolved' | 'unresolved';
  confidence_summary: 'high' | 'medium' | 'low' | 'none';
  advice: string | null;
  evidence: EvidenceItemJson[];
  conflicts: never[];
  dependency_summary: never[];
  topic_hint: null;
  numbered_list: string;
  stats: { candidates: number; packed: number; tokens: number; latency_ms: number };
}

/** Phase 0 缺的三路召回。**不写 `no_sidecar`**：这条路本来就不需要 sidecar */
const PHASE0_DEGRADED: readonly Degraded[] = ['no_vector', 'no_bm25', 'no_ppr'];

function confidenceSummary(items: readonly EvidenceItemJson[]): 'high' | 'medium' | 'low' | 'none' {
  if (items.length === 0) return 'none';
  const top = items.reduce((m, e) => Math.max(m, e.confidence), 0);
  if (top >= 0.9) return 'high';
  if (top >= 0.6) return 'medium';
  return 'low';
}

function numberedLine(item: EvidenceItemJson, index: number): string {
  const since = item.valid_at.slice(0, 10);
  return `[M${String(index)}] (${item.confidence.toFixed(2)}, ${since} 起) ${item.content}`;
}

/**
 * 排序分。**只用符号量**（强度、置信、时间新鲜度），不引入任何模型输出——
 * 这一路的价值恰恰在于"没有模型也能排"。
 */
function scoreOf(fact: Fact, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(fact.validAt)) / 86_400_000);
  const freshness = 1 / (1 + ageDays / 30);
  return 0.55 * fact.strength + 0.35 * fact.confidence + 0.1 * freshness;
}

function toItem(fact: Fact, mId: number): EvidenceItemJson {
  return {
    m_id: mId,
    fact_id: fact.id,
    content: fact.content,
    ftype: fact.ftype,
    confidence: fact.confidence,
    confidence_source: fact.confidenceSource,
    strength: fact.strength,
    pool: fact.pool,
    epistemic_status: fact.epistemicStatus,
    valid_at: fact.validAt,
    valid_to: fact.validTo,
    recorded_at: fact.recordedAt,
    subject: fact.attrs.frozen.subject,
    predicate: fact.attrs.frozen.predicate,
    value: fact.attrs.frozen.value,
    source_ref: {
      episode_id: fact.sourceEpisode,
      span: fact.span,
    },
    flags: [],
  };
}

export function runMemoryQuery(deps: McpDeps, input: QueryInput): EvidencePackJson {
  const started = Date.now();
  const queryId = newId('query');
  const ts = nowIso();

  const filter = {
    q: input.query,
    scope: input.scope,
    ...(input.ftype === undefined ? {} : { ftype: input.ftype }),
    includeHistory: input.include_history,
    ...(input.time_range?.from === undefined ? {} : { from: input.time_range.from }),
    ...(input.time_range?.to === undefined ? {} : { to: input.time_range.to }),
  };

  // 先多取一些再截断：排序要基于"候选集"，不是"前 top_k 条再排序"
  const candidates = factRepo.searchFacts(deps.db, { ...filter, limit: Math.max(input.top_k * 4, 40) });
  const total = factRepo.countMatching(deps.db, filter);

  const nowMs = Date.parse(ts);
  const ranked = candidates
    .map((f) => ({ fact: f, score: scoreOf(f, nowMs) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, input.top_k);

  const evidence = ranked.map((r, i) => toItem(r.fact, i + 1));
  const numbered = evidence.map((e, i) => numberedLine(e, i + 1)).join('\n');
  const summary = confidenceSummary(evidence);

  const pack: EvidencePackJson = {
    schema: 'moshi-evidence/1',
    query_id: queryId,
    status: 'degraded',
    route: 'local',
    degraded: [...PHASE0_DEGRADED],
    truncated: total > evidence.length,
    coverage: total > evidence.length ? 'partial' : 'full',
    identity: evidence.length > 0 ? 'resolved' : 'unresolved',
    confidence_summary: summary,
    advice:
      summary === 'none'
        ? '尚未观测到与该查询相关的事实。可换用更具体的名词（包名、端口号、路径）再查，' +
          '或等待下一次会话扫描后重试。'
        : null,
    evidence,
    conflicts: [],
    dependency_summary: [],
    topic_hint: null,
    numbered_list: numbered,
    stats: {
      candidates: total,
      packed: evidence.length,
      tokens: estimateTokens(numbered),
      latency_ms: Date.now() - started,
    },
  };

  withTransaction(deps.db, () => {
    queryLogRepo.insertQueryLog(deps.db, {
      id: queryId,
      ts,
      queryText: input.query,
      // 查询原文可能含路径与用户名：埋点只留哈希，原文留给 UI 侧按需记录（概设 §9.6）
      queryHash: sha256Hex(canonicalJson({ q: input.query, scope: input.scope })),
      route: 'local',
      flags: { gat: 'off', self_attn: 'off', cross_attn: 'off', vector: 'off', bm25: 'off', ppr: 'off' },
      candidates: { keyword: evidence.map((e) => e.fact_id) },
      fused: evidence.map((e, i) => ({ fact_id: e.fact_id, rrf: ranked[i]?.score ?? 0 })),
      packed: evidence.map((e) => e.fact_id),
      degraded: [...PHASE0_DEGRADED],
      truncated: pack.truncated,
      coverage: pack.coverage,
      latencyMs: pack.stats.latency_ms,
      cached: false,
    });
    queryLogRepo.insertEvidence(
      deps.db,
      ranked.map((r, i) => ({
        queryId,
        mId: i + 1,
        factId: r.fact.id,
        rank: i + 1,
        score: r.score,
        pool: r.fact.pool,
      })),
    );
  });

  return pack;
}
