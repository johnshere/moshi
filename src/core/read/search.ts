/**
 * 读取通路总编排（详设 §6.1）。
 *
 * P1-04~P1-18 各建一段，这里把它们**串成一条能跑的链**：
 *
 * ```
 * routeIntent → (global: globalPath)
 *            → recognizeEntities → 三路召回(vector/bm25/ppr) → fuseRank
 *            → buildSubgraph → adjudicate → packFacts → assembleEvidence
 *            → mapDegradation → EvidenceCache → logQuery
 * ```
 *
 * 三条纪律：
 * 1. **降级不假装**：每段失败只记一个 `InternalSignal`，最后统一映射成 `degraded[]`；
 *    查失败绝不报 `ok`+空（§6.13）。
 * 2. **向量路可有可无**：`encode` 没注入或 sidecar 不应答 → 标降级继续跑，
 *    BM25 与 PPR 仍能出证据（概设 §4.7「降级要静默，但不能骗人」）。
 *    PPR 的种子因此有退化顺序：向量 top-3 → BM25 top-3（§6.4.1 末段）。
 * 3. **埋点尽力而为**：`logQuery` 内部已 try/catch，缓存命中也写一行（§6.12）。
 *
 * 本层不碰裸 SQL（K2），也不 import `app`（core-no-app）：参数由调用方注入。
 */
import type { Caller, CallerKind } from '../../domain/access.js';
import { UNKNOWN_CALLER } from '../../domain/access.js';
import { canonicalJson, sha256Hex } from '../../domain/hash.js';
import { newId } from '../../domain/ids.js';
import { nowIso, parseTs } from '../../domain/time.js';
import type { Fact } from '../../domain/types.js';
import type { Ftype } from '../../domain/enums.js';
import type { Db } from '../../infra/sqlite/db.js';
import { countFact, knn, vectorDisabled, VEC_DIM } from '../../infra/vec/index.js';
import { decayFacts, listByIds } from '../../infra/sqlite/factRepo.js';
import { listTopSummaries } from '../../infra/sqlite/communityRepo.js';
import { schemaRev } from '../../infra/sqlite/metaRepo.js';
import { logQuery } from '../../infra/sqlite/logRepo.js';
import { routeIntent } from './route.js';
import { recognizeEntities, type RecognizedEntity } from './recognize.js';
import { recallBm25, tokenizeForFts } from './recall/bm25.js';
import { recallPpr, type PprResult } from './recall/ppr.js';
import { fuseRank, fusedScores, type FusedItem, type RecallChannel } from './fuse.js';
import { buildSubgraph } from './subgraph.js';
import { buildPayloadFromSubgraph } from './subgraph-payload.js';
import { GLOBAL_SCOPE, normalizeScope, scopeCandidates } from '../../domain/scope.js';
import type { MoshiSubgraphPayload } from '../../domain/subgraph.js';
import { SUBGRAPH_SEED_LIMIT } from '../../domain/subgraph.js';
import { adjudicate, type AdjudicateResult, type AdjudicatedFact } from './adjudicate.js';
import { applyNeuralDeltas } from './gate-delta.js';
import { packFacts, type PackItem } from './pack.js';
import { assembleEvidence, type ConflictEntry, type EvidencePackage, type TopicHint } from './evidence.js';
import { mapDegradation, type InternalSignal } from './errors.js';
import { cacheKeyOf, type EvidenceCache } from './cache.js';
import { buildTrace, collectTrace, type TraceRecord, type TraceSink } from './trace.js';

/** 编排参数（app 层从 cfg 映射过来——core 不认识 Config 类型） */
export interface SearchParams {
  vectorTopK: number;
  /** 向量召回的相关性地板（cos ∈ [0,1]）：低于它的邻居不进候选。
   *  没有地板时 knn 必返 top_k 条，噪声会被 max 归一化成 1.0（P1-29 / B-6）。 */
  vectorMinSim: number;
  bm25TopK: number;
  pprTopK: number;
  pprDamping: number;
  pprIters: number;
  pprMaxNodes: number;
  subgraphMaxNodes: number;
  subgraphMaxEdges: number;
  tokenBudget: number;
  utilityRatio: number;
  floorMin: number;
  maxFactTokens: number;
  /** 全局路径返回的主题数（详设 §6.10 第 1 步的 LIMIT 5） */
  globalTopicLimit: number;
}

export const DEFAULT_PARAMS: SearchParams = {
  vectorTopK: 20,
  vectorMinSim: 0.6,
  bm25TopK: 20,
  pprTopK: 20,
  pprDamping: 0.85,
  pprIters: 20,
  pprMaxNodes: 400,
  subgraphMaxNodes: 64,
  subgraphMaxEdges: 192,
  tokenBudget: 1500,
  utilityRatio: 0.7,
  floorMin: 2,
  maxFactTokens: 80,
  globalTopicLimit: 5,
};

/**
 * 召回超取倍数（W5 密度修复）。
 *
 * 三路召回先按 `topK × RECALL_OVERFETCH` 取，过 `passFilters`（scope / cache /
 * history / 时间窗）**之后**再截断回 topK。此前是「先截断后过滤」：BM25 的
 * top-20 里常混着十几条 `retention_class=cache` / `epistemic_status=invalidated`
 * 的事实，过滤完只剩 1~3 条，融合池与子图种子一起塌陷（活动库实测 query_log
 * 平均子图 0.6 节点）。超取让过滤有富余量。
 *
 * `1` = 关闭（旧行为），单测与消融用它对齐历史读数。
 */
export const RECALL_OVERFETCH = 5;

export interface SearchInput {
  query: string;
  scope?: string;
  topK?: number;
  includeHistory?: boolean;
  /** 默认不返回 cache 类事实；调用方明确要当前状态缓存时才打开（V-05） */
  includeCache?: boolean;
  ftype?: readonly Ftype[];
  timeFrom?: string;
  timeTo?: string;
  /** 会话标识，只进埋点 */
  session?: string;
  /** 接入点（P2）：谁在查；不传按 `unknown` 记，历史行由迁移留 NULL */
  caller?: Caller;
  /** 回执号（钩子入口带；其它入口可留空），只进埋点 */
  corrId?: string;
}

/** 单节点打分（与 `/score` 返回一致） */
export interface ModelScore {
  fact_id: string;
  delta: number;
  overturn_prob: number;
}

export interface ModelScoreOutcome {
  scores: ModelScore[] | null;
  modelVersion: string | null;
  /** `no_sidecar / timeout / input_shape / model_not_loaded / error`（P3-04 口径） */
  degraded: readonly string[];
}

export type ModelScoreFn = (payload: MoshiSubgraphPayload) => Promise<ModelScoreOutcome>;

export interface SearchRuntime {
  db: Db;
  params?: Partial<SearchParams>;
  /** 文本 → 384 维 L2 归一化向量；返回 null = 编码服务不可用 */
  encode?: (text: string) => Promise<Float32Array | null>;
  cache?: EvidenceCache;
  /** GAT 开关（P3）；只进 flags 快照 */
  gatMode?: 'off' | 'shadow' | 'on';
  /** GAT 模型版本（P3）；缺省 null。P2 恒 null——模型未生效（§4.7） */
  modelVersion?: string | null;
  /**
   * 召回通道开关（P4-02 消融）：缺省 = 全开。显式关闭的通道既不出结果，
   * 也如实体现在 `flags_json` 里（消融数据要能按开关归组）。
   */
  channels?: { vector?: boolean; bm25?: boolean; ppr?: boolean };
  /**
   * 召回超取倍数（见 `RECALL_OVERFETCH`）：缺省用它，`1` = 关闭超取。
   * 单测/消融用它把读数对齐到「先截断后过滤」的旧行为。
   */
  recallOverfetch?: number;
  /** 模型结构开关（P4-02 消融）：缺省 self_attn=off、cross_attn=on */
  modelOptions?: { selfAttn?: boolean; crossAttn?: boolean };
  /**
   * GAT 打分注入点（P3-07）。`shadow`/`on` 时查询会组 payload 调它；
   * 不注入 = 完全不打分（行为与 P3-07 之前一致）。
   * 用结构化类型而不是 import 具体客户端：core 不依赖 infra 实现。
   */
  score?: ModelScoreFn;
  /** δ 门控上限（`model.delta_cap`，默认 0.15）；只在 `gat_mode='on'` 生效 */
  deltaCap?: number;
  /**
   * 证据链采集注入点（P2-24，详设 §4.7）。**不传 = 完全不采集**，行为与 P2-24 之前
   * 逐字节一致；daemon 注入 TraceStore 后每次查询留一条内存 trace（不落库）。
   */
  trace?: TraceSink;
  newQueryId?: () => string;
  /** 注入时钟（ISO），让时态断言可测 */
  now?: () => string;
}

export interface SearchOutcome {
  pack: EvidencePackage;
  /** 缓存命中（§6.11：命中也要写埋点，且 query_id 必须新生成） */
  cached: boolean;
  /** 各阶段累计耗时（§6.1 的 stage_ms_json / §6.13 预算断言用） */
  stageMs: Record<string, number>;
}

/** 模型分入库前的定点（避免 17 位浮点把 query_log 撑大且无信息量） */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** 开关快照（§6.12：没有它 A/B 数据无法归组） */
function flagsSnapshot(
  vectorOn: boolean,
  gatMode: string,
  channels: SearchRuntime['channels'] = {},
  modelOptions: SearchRuntime['modelOptions'] = {},
): Record<string, string> {
  return {
    gat: gatMode,
    self_attn: modelOptions.selfAttn === true ? 'on' : 'off',
    cross_attn: modelOptions.crossAttn === false ? 'off' : 'on',
    vector: vectorOn && channels.vector !== false ? 'on' : 'off',
    bm25: channels.bm25 === false ? 'off' : 'on',
    ppr: channels.ppr === false ? 'off' : 'on',
  };
}

/** trace 采集是旁路：sink 自己抛错也绝不能把读取链带崩（§6.13 降级纪律） */
function emitTrace(rt: SearchRuntime, record: TraceRecord): void {
  if (rt.trace === undefined) return;
  try {
    rt.trace.put(record);
  } catch {
    /* 采集失败只是少一条回放，不是查询失败 */
  }
}

/** trace 的公共字段（三处出口共用，避免 model_mode/model_version 漂移） */
function traceMeta(
  rt: SearchRuntime,
  modelVersion?: string | null,
): { modelMode: 'off' | 'shadow' | 'on'; modelVersion: string | null } {
  return { modelMode: rt.gatMode ?? 'off', modelVersion: modelVersion ?? rt.modelVersion ?? null };
}

/** 候选过滤：scope / ftype / 生命周期 / 有效时间窗（§4.1.1 入参语义） */
function passFilters(fact: Fact, input: SearchInput, scopes: readonly string[]): boolean {
  if (!scopes.includes(fact.scope)) return false;
  if (input.ftype !== undefined && input.ftype.length > 0 && !input.ftype.includes(fact.ftype)) return false;
  if (input.includeCache !== true && fact.retentionClass === 'cache') return false;
  if (input.includeHistory !== true && fact.epistemicStatus !== 'active') return false;
  if (input.timeFrom !== undefined && fact.validAt < input.timeFrom) return false;
  if (input.timeTo !== undefined && fact.validAt > input.timeTo) return false;
  return true;
}

/**
 * 通道内「过滤 → 截断」：先剔掉 passFilters 不认的 id，再按通道原始顺序取前
 * `limit` 条。截断放在过滤之后是密度修复的关键——超取进来的 cache/invalidated
 * 事实被过滤掉后，名额要让给后面的合法候选，而不是跟着 topK 一起消失。
 */
function restrictTop(ids: readonly string[], allowed: ReadonlySet<string>, limit: number): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!allowed.has(id)) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function toConflicts(kept: readonly AdjudicatedFact[]): ConflictEntry[] {
  const out: ConflictEntry[] = [];
  for (const k of kept) {
    const winner = k.disputedBy;
    if (winner === null) continue;
    out.push({
      a: winner,
      b: k.fact.id,
      type: 'mutually_exclusive',
      resolved: winner,
      rule: 'mutex_by_confidence@1',
    });
  }
  return out;
}

const EMPTY_TOPIC_HINT: TopicHint = { community_id: null, label: null, fact_count: 0, derived_at: null, uri: null };

/**
 * 全局路径（详设 §6.10）：只给主题概览 + 下钻指针，**不返回单条事实**。
 * 社区摘要在 P2-12 才生成，所以 Phase 1 里这条路正常返回 `no_summary`——
 * 那是诚实的结果，不是失败。
 *
 * 主题清单走 `numbered_list` 的 `[T#]` 行：`topic_hint` 只有一个位置（§4.4 的
 * schema 是单条），数组化要升 schema 版本，留给 P2-12（台账 §5.3）。
 */
function buildGlobalPack(
  db: Db,
  queryId: string,
  scopes: readonly string[],
  params: SearchParams,
  signals: InternalSignal[],
  latencyMs: number,
): EvidencePackage {
  // 项目优先、全局兜底：本项目没有主题摘要时才用 global 的
  let rows: ReturnType<typeof listTopSummaries> = [];
  for (const s of scopes) {
    rows = listTopSummaries(db, s, params.globalTopicLimit);
    if (rows.length > 0) break;
  }
  // 摘要过期判据：生成时的 source_rev 落后于当前库版本（§6.10 第 2 步）
  const rev = schemaRev(db);
  const fresh = rows.filter((r) => r.sourceRev >= rev);
  if (fresh.length === 0) signals.push('summary_missing');

  const { degraded, status } = mapDegradation(signals);
  const numbered_list = fresh.map(
    (r, i) => `[T${String(i + 1)}] (${String(r.factCount)} 条事实，${r.derivedAt.slice(0, 10)} 起) ${r.summary}`,
  );
  const head = fresh[0];

  return {
    schema: 'moshi-evidence/1',
    query_id: queryId,
    status,
    route: 'global',
    degraded,
    truncated: false,
    coverage: fresh.length === 0 ? 'partial' : 'full',
    identity: 'resolved',
    confidence_summary: 'none',
    advice:
      head === undefined
        ? '当前没有可用的主题摘要，请改用具体名词（包名、端口、路径）查询。'
        : '以下是主题概览；具体细节请按 topic 下钻。',
    evidence: [],
    conflicts: [],
    dependency_summary: [],
    topic_hint:
      head === undefined
        ? EMPTY_TOPIC_HINT
        : {
            community_id: head.communityId,
            label: head.label,
            fact_count: head.factCount,
            derived_at: head.derivedAt,
            uri: `moshi://topic/${head.label ?? head.communityId}`,
          },
    numbered_list,
    stats: { candidates: rows.length, packed: 0, tokens: 0, latency_ms: latencyMs },
  };
}

/** 阶段名（§6.13 预算表）；stageMs 的键 */
type Stage =
  | 'route'
  | 'global'
  | 'recognize'
  | 'cache'
  | 'recall_vector'
  | 'recall_bm25'
  | 'recall_ppr'
  | 'load'
  | 'fuse'
  | 'subgraph'
  | 'score'
  | 'adjudicate'
  | 'pack'
  | 'assemble';

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 埋点归属（P2 接入层）：入口类型、接入点 id、插件名、回执号、证据包状态与出入字节。
 * 历史行（迁移 007 之前）是 NULL，这里只负责新行。
 */
function attributionOf(
  input: SearchInput,
  pack: EvidencePackage,
): {
  callerId: string;
  callerKind: CallerKind;
  pluginId: string | null;
  corrId: string | null;
  status: string;
  inBytes: number;
  outBytes: number;
} {
  const caller = input.caller ?? UNKNOWN_CALLER;
  return {
    callerId: caller.id,
    callerKind: caller.kind,
    pluginId: caller.plugin ?? null,
    corrId: input.corrId ?? null,
    status: pack.status,
    inBytes: utf8Bytes(input.query),
    outBytes: utf8Bytes(JSON.stringify(pack)),
  };
}

export async function searchWithPipeline(rt: SearchRuntime, input: SearchInput): Promise<SearchOutcome> {  const db = rt.db;
  const params: SearchParams = { ...DEFAULT_PARAMS, ...(rt.params ?? {}) };
  const scope = normalizeScope(input.scope ?? GLOBAL_SCOPE);
  const scopes = scopeCandidates(scope);
  const topK = input.topK ?? 8;
  const now = (rt.now ?? nowIso)();
  const startedAt = performance.now();
  const stageMs: Record<string, number> = {};
  const mark = (stage: Stage): void => {
    stageMs[stage] = Math.round((performance.now() - startedAt) * 100) / 100;
  };
  const newQueryId = rt.newQueryId ?? (() => newId('query'));
  const queryHash = sha256Hex(canonicalJson({ q: input.query, scope }));

  // ── 1) 意图分流（§6.2，3ms，纯规则）──
  const routed = routeIntent(db, input.query);
  mark('route');

  if (routed.route === 'global') {
    const signals: InternalSignal[] = [];
    if (countFact(db) === 0) signals.push('cold_start');
    const queryId = newQueryId();
    const pack = buildGlobalPack(db, queryId, scopes, params, signals, Math.round(performance.now() - startedAt));
    mark('global');
    // 全局路径没有事实级证据链，但仍记一条空 trace：前端轮询任意 query_id 都有回放，
    // 不会因为「这次是话题概览」而 404（§12.2「trace 缺失返回空而非报错」）。
    emitTrace(
      rt,
      buildTrace({
        queryId,
        ts: parseTs(now),
        route: 'global',
        ...traceMeta(rt),
        seeds: [],
        results: [],
      }),
    );
    logQuery(
      db,
      {
        id: queryId,
        ts: now,
        queryText: input.query,
        queryHash,
        route: 'global',
        flags: flagsSnapshot(false, rt.gatMode ?? 'off', rt.channels, rt.modelOptions),
        latencyMs: pack.stats.latency_ms,
        stageMs,
        degraded: pack.degraded,
        truncated: false,
        coverage: pack.coverage,
        packed: [],
        cached: false,
        session: input.session ?? null,
        ...attributionOf(input, pack),
      },
      [],
    );
    return { pack, cached: false, stageMs };
  }

  const signals: InternalSignal[] = [];
  if (countFact(db) === 0) signals.push('cold_start');

  // ── 2) 实体识别（§6.3，5ms）──
  const entities: RecognizedEntity[] = recognizeEntities(db, input.query, { limit: 8 });
  mark('recognize');

  const vectorOn = rt.encode !== undefined && !vectorDisabled(db) && rt.channels?.vector !== false;
  const flags = flagsSnapshot(vectorOn, rt.gatMode ?? 'off', rt.channels, rt.modelOptions);

  // 查询向量：有 encode 才算。缓存的余弦命中判定（§6.11）也要同一个向量，
  // 所以只编一次（memoize）。
  let vecMemo: Promise<Float32Array | null> | null = null;
  const queryVector = (): Promise<Float32Array | null> => {
    if (rt.encode === undefined) return Promise.resolve(null);
    if (vecMemo === null) vecMemo = rt.encode(input.query);
    return vecMemo;
  };

  const cacheKey = cacheKeyOf({
    normalizedQuery: input.query.trim().toLowerCase(),
    scope,
    // 命中直接返回整包：凡改变包内容的检索参数都必须进 key（P1-25）。
    shape: {
      top_k: topK,
      include_history: input.includeHistory === true,
      include_cache: input.includeCache === true,
      ftype: input.ftype ?? null,
      time_from: input.timeFrom ?? null,
      time_to: input.timeTo ?? null,
      session: input.session ?? null,
    },
    flags,
    tokenize: (s) => tokenizeForFts(s),
  });

  // ── 3) 会话内缓存（§6.11）：命中即返回，query_id 新生成 ──
  if (rt.cache !== undefined) {
    const vec = await queryVector();
    const hit = rt.cache.get(cacheKey, vec === null ? [] : Array.from(vec));
    if (hit !== null) {
      const cachedPack: EvidencePackage = { ...hit.pack, query_id: hit.queryId };
      mark('cache');
      const latencyMs = Math.round(performance.now() - startedAt);
      // 缓存命中没有跑召回（§6.11 直接返回整包）：只能把入包事实记成直击，
      // seeds 留空——没有发生过的扩散不能出现在回放里。
      emitTrace(
        rt,
        buildTrace({
          queryId: hit.queryId,
          ts: parseTs(now),
          route: 'local',
          ...traceMeta(rt),
          seeds: [],
          results: cachedPack.evidence.map((e) => ({
            fact_id: e.fact_id,
            hop: 0,
            path: [],
            fused_rank: null,
            rank_symbolic: e.m_id,
          })),
        }),
      );
      logQuery(
        db,
        {
          id: hit.queryId,
          ts: now,
          queryText: input.query,
          queryHash,
          route: 'local',
          flags,
          candidates: null,
          fused: null,
          packed: cachedPack.evidence.map((e) => e.fact_id),
          degraded: cachedPack.degraded,
          truncated: cachedPack.truncated,
          coverage: cachedPack.coverage,
          latencyMs,
          stageMs,
          cached: true,
          session: input.session ?? null,
          ...attributionOf(input, cachedPack),
        },
        cachedPack.evidence.map((e) => ({
          queryId: hit.queryId,
          mId: e.m_id,
          factId: e.fact_id,
          rank: e.m_id,
          score: e.confidence,
          pool: e.pool === 'value_floor' ? ('value_floor' as const) : ('utility' as const),
        })),
      );
      return { pack: cachedPack, cached: true, stageMs };
    }
    mark('cache');
  }

  // ── 4) 三路召回（§6.4）──
  // 通道内先超取（见 RECALL_OVERFETCH），过滤后再截断回 topK：截断必须发生在
  // passFilters 之后，否则被过滤掉的 cache/history 事实会白白吃掉 topK 名额。
  const overfetch = Math.max(1, Math.floor(rt.recallOverfetch ?? RECALL_OVERFETCH));
  let vectorIds: string[] = [];
  if (rt.channels?.vector === false) {
    // 消融显式关闭：不编向量、不出结果，也不标降级（这是预期行为）
  } else if (rt.encode === undefined) {
    signals.push('sidecar_unavailable');
  } else if (vectorDisabled(db)) {
    signals.push('vector_error');
  } else {
    try {
      const vec = await queryVector();
      if (vec === null) signals.push('sidecar_unavailable');
      else if (vec.length !== VEC_DIM) signals.push('vector_error');
      else {
        const hits = knn(db, vec, params.vectorTopK * overfetch);
        const kept = hits.filter((h) => h.similarity >= params.vectorMinSim);
        // 有命中但全低于地板 = 问题不在库里，是问句与所有事实都不相关（拒答要的就是这个）
        if (hits.length > 0 && kept.length === 0) signals.push('vector_low_similarity');
        vectorIds = kept.map((h) => h.fact_id);
      }
    } catch {
      signals.push('vector_error');
    }
  }
  mark('recall_vector');

  let bm25Ids: string[] = [];
  if (rt.channels?.bm25 !== false) {
    try {
      bm25Ids = recallBm25(db, input.query, params.bm25TopK * overfetch).map((h) => h.fact_id);
    } catch {
      signals.push('bm25_error');
    }
  }
  mark('recall_bm25');

  // PPR 种子 = 向量 top-3，向量路不可用时退化成 BM25 top-3（§6.4.1 末段）。
  // 没有种子不是故障：其他两路照常出结果。
  const seeds = (vectorIds.length > 0 ? vectorIds : bm25Ids).slice(0, 3);
  let pprIds: string[] = [];
  let pprResult: PprResult | null = null;
  if (rt.channels?.ppr !== false && seeds.length > 0) {
    try {
      const ppr = recallPpr(db, seeds, {
        maxNodes: params.pprMaxNodes,
        maxIter: params.pprIters,
        d: params.pprDamping,
        k: params.pprTopK * overfetch,
      });
      pprResult = ppr;
      pprIds = ppr.ids.slice(0, params.pprTopK * overfetch);
      if (ppr.timedOut) signals.push('ppr_timeout');
    } catch {
      signals.push('ppr_error');
    }
  }
  mark('recall_ppr');

  // ── 5) 候选加载与过滤（三路并集）──
  const unionIds = [...new Set([...vectorIds, ...bm25Ids, ...pprIds])];
  const filtered = listByIds(db, unionIds).filter((f) => passFilters(f, input, scopes));
  // 惰性衰减：查询返回前算一次（详设 §8.1）。候选只有几十条，且 Δ≤1e-3 不落库，
  // 所以这一步对读路径的代价是 O(候选数) 的浮点运算，不是一次批量 UPDATE。
  // 衰减后的强度直接进融合与裁决，否则排序用的是「上次查询时」的旧值。
  const live = decayFacts(db, filtered, parseTs(now));
  const factsById = new Map<string, Fact>(live.map((f) => [f.id, f]));
  const allowed = new Set(factsById.keys());
  mark('load');

  // ── 6) 融合（§6.5）：RRF + 实体信号 + 时序信号 ──
  // 每条通道在**过滤之后**截断到配置的 topK（restrictTop）：超取只用来换过滤
  // 富余量，通道贡献的上限仍是 topK，RRF 的名次语义不变。
  const channels: { vector?: RecallChannel; bm25?: RecallChannel; ppr?: RecallChannel } = {};
  const vIds = restrictTop(vectorIds, allowed, params.vectorTopK);
  if (vIds.length > 0) channels.vector = { ids: vIds };
  const bIds = restrictTop(bm25Ids, allowed, params.bm25TopK);
  if (bIds.length > 0) channels.bm25 = { ids: bIds };
  const pIds = restrictTop(pprIds, allowed, params.pprTopK);
  if (pIds.length > 0) channels.ppr = { ids: pIds };
  const fused: FusedItem[] = fuseRank(channels, factsById, {
    entities,
    query: input.query,
    now: () => new Date(now),
  });
  // 融合排名（1-based）进 trace 的 fused_rank；不在融合结果里的入包事实记 null
  const fusedRankOf = new Map<string, number>(fused.map((f, i) => [f.fact_id, i + 1]));
  mark('fuse');

  // ── 7) 子图（§6.6）──
  // 种子上限与训练导出共用 SUBGRAPH_SEED_LIMIT（8）：种子里放多少条，决定「哪几条
  // 候选必定入图」，剩下 `maxNodes - 种子数` 个名额交给 2 跳扩展。放宽到 maxNodes
  // 会让候选把名额吃满、2 跳归零，那是改输入组成而不是修召回（W5 实测：种子 64 时
  // 密度虚高到 21.98，同批查询换成 8 种子是 12）。密度靠「召回超取 + 过滤后截断」
  // 把候选喂满，再由图扩展补足。
  const sub = buildSubgraph(db, fused.map((f) => f.fact_id), {
    maxNodes: params.subgraphMaxNodes,
    maxEdges: params.subgraphMaxEdges,
    seedLimit: SUBGRAPH_SEED_LIMIT,
  });
  // 门槛 2 的密度口径（详设 §7.6）：复用 stage_ms_json，不改表结构
  stageMs['subgraph_nodes'] = sub.nodes.length;
  const nodeIds = sub.nodes.map((n) => n.fact_id);
  // 邻居节点同样要过过滤器；顺序按子图全序（§6.6 的稳定性要求）
  const nodeFacts = listByIds(db, nodeIds)
    .filter((f) => passFilters(f, input, scopes))
    .sort((a, b) => nodeIds.indexOf(a.id) - nodeIds.indexOf(b.id));
  mark('subgraph');

  // ── 7.5) GAT 打分（P3-07）：shadow/on 都只**记录**，不改排序 ──
  // δ 应用与门控在 P3-08；这里唯一的副作用是把分数记进 query_log 与 trace，
  // 以及模型不可用时把降级码补进 degraded[]（失败绝不影响查询结果）。
  const modelScores = new Map<string, { delta: number; overturnProb: number }>();
  let resolvedVersion = rt.modelVersion ?? null;
  if (rt.score !== undefined && (rt.gatMode ?? 'off') !== 'off') {
    const scoreStarted = performance.now();
    try {
      const vec = await queryVector();
      const bridged = buildPayloadFromSubgraph(
        db,
        sub,
        vec === null ? null : Array.from(vec),
        rt.modelOptions,
      );
      if (bridged.missing.length > 0) {
        signals.push('gat_unavailable');
      } else {
        const outcome = await rt.score(bridged.payload);
        if (outcome.scores === null) {
          signals.push(outcome.degraded.includes('no_sidecar') ? 'sidecar_unavailable' : 'gat_unavailable');
        } else {
          for (const s of outcome.scores) {
            modelScores.set(s.fact_id, { delta: s.delta, overturnProb: s.overturn_prob });
          }
          resolvedVersion = outcome.modelVersion ?? resolvedVersion;
        }
      }
    } catch {
      signals.push('gat_unavailable');
    }
    stageMs['model_ms'] = Math.round((performance.now() - scoreStarted) * 100) / 100;
    mark('score');
  }

  // ── 8) 符号兜底五步（§6.7）──
  // 融合分以 base 身份进 finalScore（0.55 权重）。不传的话 base 恒 0，
  // 排序退化成 0.30×confidence + 0.15×strength，图邻居能压过融合分第一的直命中（B-3）。
  const adjOpts = {
    now,
    // include_history 是对第①步的显式豁免（§4.1.1）：调用方要看被取代的事实
    keepExpired: input.includeHistory === true,
    base: fusedScores(fused),
  };
  let adj: AdjudicateResult;
  if ((rt.gatMode ?? 'off') === 'on' && modelScores.size > 0) {
    // δ 门控 + 重跑裁决（§7.5 五步）：翻转就回退，落库走 setConfidence + audit。
    // 门控本身出错（落库失败、重跑裁决异常）一律退回普通裁决：**模型的问题不能让查询失败**。
    try {
      const gated = applyNeuralDeltas(db, nodeFacts, sub.edges, {
        ...adjOpts,
        scores: modelScores,
        ...(rt.deltaCap === undefined ? {} : { deltaCap: rt.deltaCap }),
        modelVersion: resolvedVersion,
      });
      adj = gated.result;
      stageMs['model_applied'] = gated.applied.length;
      stageMs['model_rejected'] = gated.rejected.length;
    } catch {
      signals.push('gat_unavailable');
      adj = adjudicate(db, nodeFacts, sub.edges, adjOpts);
    }
  } else {
    adj = adjudicate(db, nodeFacts, sub.edges, adjOpts);
  }
  mark('adjudicate');

  // ── 9) top_k 截断 + 装箱（§6.8）──
  // 先按 finalScore 全序切 top_k，再装箱。反过来的话：装箱先按预算挑，
  // 挑完再切，等于"预算花在不会返回的事实上"，且排第 10 的直命中连机会都没有。
  const utilBudget = Math.round(params.tokenBudget * params.utilityRatio);
  // 项目优先、全局兜底（概设 §3.6.4）：给项目事实加一个排名层优先值。
  // 不能只靠 shortlist 的数组顺序——`packFacts` 会按 finalScore 重新排序，
  // 顺序会在装箱这一步被抹掉。finalScore 的数学上界是 1（0.55+0.3+0.15），
  // 所以 +1 足以让项目命中整体排在 global 兜底之前，且不影响池内相对排序。
  const ranked: AdjudicatedFact[] = [...adj.kept]
    .map((a) =>
      scopes.length > 1 && a.fact.scope === scope
        ? { ...a, finalScore: a.finalScore + 1 }
        : a,
    )
    .sort((a, b) => b.finalScore - a.finalScore || (a.fact.id < b.fact.id ? -1 : 1));
  const shortlist: AdjudicatedFact[] = ranked.slice(0, topK);
  const items: PackItem[] = packFacts(shortlist, {
    budget: params.tokenBudget,
    utilBudget,
    floorBudget: params.tokenBudget - utilBudget,
    floorMin: params.floorMin,
    perItemMax: params.maxFactTokens,
  }).items;
  mark('pack');

  // ── 10) 证据包（§6.9）──
  const { degraded } = mapDegradation(signals);
  const queryId = newQueryId();
  const latencyMs = Math.round(performance.now() - startedAt);
  const pack = assembleEvidence(db, queryId, items, {
    route: 'local',
    degraded,
    edges: sub.edges,
    conflicts: toConflicts(adj.kept),
    latencyMs,
    candidates: fused.length,
    now,
  });
  mark('assemble');

  // ── 10.5) 证据链回放（P2-24 / §4.7）：旁路采集，不改变证据包 ──
  // 路径只重建「入包事实」这一段：seeds=直击命中，hop=从 PPR 种子出发的跳数，
  // edge_mass=PPR 扩散份额。子图边已在手，trace 不做额外召回。
  emitTrace(
    rt,
    collectTrace({
      db,
      queryId,
      ts: parseTs(now),
      route: 'local',
      ...traceMeta(rt, resolvedVersion),
      directIds: [...new Set([...vectorIds, ...bm25Ids])],
      pprSeeds: seeds,
      ppr: pprResult,
      subEdges: sub.edges,
      packed: items.map((item, i) => ({
        fact_id: item.fact.id,
        rank: i + 1,
        fused_rank: fusedRankOf.get(item.fact.id) ?? null,
      })),
    }),
  );

  // ── 11) 埋点（§6.12）与会话内缓存（§6.11）──
  logQuery(
    db,
    {
      id: queryId,
      ts: now,
      queryText: input.query,
      queryHash,
      route: 'local',
      flags,
      candidates: {
        vector: channels.vector?.ids ?? [],
        bm25: channels.bm25?.ids ?? [],
        ppr: channels.ppr?.ids ?? [],
      },
      fused: fused.map((f) => {
        const m = modelScores.get(f.fact_id);
        return {
          fact_id: f.fact_id,
          rrf: f.rrf,
          entity_bonus: f.entity_bonus,
          temporal_bonus: f.temporal_bonus,
          // P3-07：模型分只入库不入排序；未打分时字段不出现（保持旧行形状）
          ...(m === undefined
            ? {}
            : { model_delta: round4(m.delta), overturn_prob: round4(m.overturnProb) }),
        };
      }),
      packed: items.map((p) => p.fact.id),
      degraded,
      truncated: pack.truncated,
      coverage: pack.coverage,
      latencyMs,
      stageMs,
      cached: false,
      session: input.session ?? null,
      ...attributionOf(input, pack),
    },
    items.map((p, i) => ({
      queryId,
      mId: i + 1,
      factId: p.fact.id,
      rank: i + 1,
      score: p.score,
      pool: p.pool,
    })),
  );

  if (rt.cache !== undefined) {
    const vec = await queryVector();
    rt.cache.put(cacheKey, vec === null ? [] : Array.from(vec), pack);
  }

  return { pack, cached: false, stageMs };
}
