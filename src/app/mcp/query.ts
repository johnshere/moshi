/**
 * `memory_query` 的实现（详设 §4.1.1 / §4.4）。
 *
 * Phase 1 起这一层**只做协议适配**：MCP 入参翻译成 `core/read/search.ts` 的编排输入，
 * 证据包的 `numbered_list` 数组拼成宿主读的字符串，其余一律由 core 决定。
 *
 * 为什么这么薄：`m_id` 连续性、降级语义、埋点写入都是**读取通路**的性质，不是 MCP
 * 的性质——留在这一层，REST / UI / CLI 每个入口会各自漂移一份。
 *
 * Phase 0 定下的诚实纪律继续适用：`status` 是给宿主看的**质量信号**，三路里任何一路
 * 没跑成都要如实进 `degraded`；谎报 `ok` 的代价是 Agent 在召回很差时仍自信作答。
 *
 * `encode` / `cache` 由调用方注入（daemon 有 sidecar，CLI 与 bench 未必有）：
 * 没有 encode 时向量路标 `no_sidecar`，BM25 + PPR 照常出证据。
 */
import type {
  ConflictEntry,
  DependencySummaryEntry,
  EvidenceEntry,
  EvidencePackage,
  TopicHint,
} from '../../core/read/evidence.js';
import type { Degraded, Ftype, Status } from '../../domain/enums.js';
import { searchWithPipeline, type SearchParams } from '../../core/read/search.js';
import type { McpDeps } from './deps.js';
import type { QueryInput } from './schemas.js';

export type { EvidenceEntry, ConflictEntry, DependencySummaryEntry, TopicHint };

/** 详设 §4.4 的对外形态：与 core 的 `EvidencePackage` 同字段，只收窄两处类型 */
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
  advice: string;
  evidence: EvidenceEntry[];
  conflicts: ConflictEntry[];
  dependency_summary: DependencySummaryEntry[];
  topic_hint: TopicHint;
  /** 宿主视图：编号列表拼成一个字符串（§4.4 字段纪律：不含 fact_id） */
  numbered_list: string;
  /** 采集协议提示：宿主可埋 ```moshi 块（详设 §5.12.1） */
  protocol_hint: string;
  /** 会话内缓存命中（详设 §6.11） */
  cached: boolean;
  stats: { candidates: number; packed: number; tokens: number; latency_ms: number };
}

export const PROTOCOL_HINT =
  'Tip: embed structured facts in a ` ```moshi ` block to submit them deterministically. ' +
  'See resource `moshi://protocol/ann-v1` for the format.';

/** cfg → 编排参数（core 不认识 Config 类型，映射留在 app 层） */
export function searchParamsOf(cfg: McpDeps['cfg']): Partial<SearchParams> {
  return {
    vectorTopK: cfg.retrieval.vector_topk,
    vectorMinSim: cfg.retrieval.vector_min_sim,
    bm25TopK: cfg.retrieval.bm25_topk,
    pprTopK: cfg.retrieval.ppr_topk,
    pprDamping: cfg.retrieval.ppr_damping,
    pprIters: cfg.retrieval.ppr_iters,
    pprMaxNodes: cfg.retrieval.ppr_max_nodes,
    subgraphMaxNodes: cfg.subgraph.max_nodes,
    subgraphMaxEdges: cfg.subgraph.max_edges,
    tokenBudget: cfg.packing.token_budget,
    utilityRatio: cfg.packing.utility_ratio,
    floorMin: cfg.packing.floor_min,
    maxFactTokens: cfg.packing.max_fact_tokens,
  };
}

function toJson(pack: EvidencePackage, cached: boolean): EvidencePackJson {
  return {
    schema: pack.schema,
    query_id: pack.query_id,
    status: pack.status,
    route: pack.route,
    degraded: pack.degraded as Degraded[],
    truncated: pack.truncated,
    coverage: pack.coverage,
    identity: pack.identity,
    confidence_summary: pack.confidence_summary,
    advice: pack.advice,
    evidence: pack.evidence,
    conflicts: pack.conflicts,
    dependency_summary: pack.dependency_summary,
    topic_hint: pack.topic_hint,
    numbered_list: pack.numbered_list.join('\n'),
    protocol_hint: PROTOCOL_HINT,
    cached,
    stats: pack.stats,
  };
}

export async function runMemoryQuery(deps: McpDeps, input: QueryInput): Promise<EvidencePackJson> {
  const { pack, cached } = await searchWithPipeline(
    {
      db: deps.db,
      params: searchParamsOf(deps.cfg),
      gatMode: deps.cfg.model.gat_mode,
      ...(deps.encode === undefined ? {} : { encode: deps.encode }),
      ...(deps.cache === undefined ? {} : { cache: deps.cache }),
    },
    {
      query: input.query,
      scope: input.scope,
      topK: input.top_k,
      includeHistory: input.include_history,
      ...(input.ftype === undefined ? {} : { ftype: input.ftype as readonly Ftype[] }),
      ...(input.time_range?.from === undefined ? {} : { timeFrom: input.time_range.from }),
      ...(input.time_range?.to === undefined ? {} : { timeTo: input.time_range.to }),
    },
  );
  return toJson(pack, cached);
}
