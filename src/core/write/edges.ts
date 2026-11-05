/**
 * 边抽取（P2-22 / 详设 §5.12.6）。
 *
 * 四条规则，全部写 `edge.provenance`，全部走"活跃边唯一"索引去重（`(src,dst,etype)`
 * 且 `valid_to IS NULL`）：同一批重跑不新增行。
 *
 * | 规则 | 判定 | etype | 置信 |
 * | --- | --- | --- | --- |
 * | 工具序列 | 同 episode 的 `tool_obs` 事实，按 `valid_at` 相邻、间隔 ≤ 5 min | depends_on | 0.7 |
 * | 过程步骤 | 同一 procedure 的 `attrs.ext.steps[]` 相邻项（按 step 名解析到同 episode 的事实） | depends_on | 0.85 |
 * | 同实体共现 | 同 subject 实体、`valid_at` 相差 ≤ 1 h | co_occur | 0.5 |
 * | 时间序取代 | 同实体 + 同谓词，新事实 `valid_at` 更晚、旧事实已收口（`valid_to` 非空） | supersedes | 0.9 |
 *
 * 配额：**每个新事实**最多 7 条边（5 `co_occur` + 2 `depends_on`），按 weight 截断；
 * `supersedes` 不受配额限制（真值维护，省不得）。
 *
 * 调用点在 `harvest`：事实一落库就按批抽边，保证"事实增长的同时边增长"。
 * 这里不读会话原文、不调 LLM，纯确定性规则。
 */
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Fact } from '../../domain/types.js';
import { findActiveEdge, insertEdge } from '../../infra/sqlite/edgeRepo.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import type { FactRef } from '../../infra/sqlite/factRepo.js';
import type { Db } from '../../infra/sqlite/db.js';

export const RULE_CONFIDENCE = {
  toolSeq: 0.7,
  procedure: 0.85,
  coOccur: 0.5,
  supersedes: 0.9,
} as const;

export const EDGE_QUOTA = {
  /** 每个新事实最多几条共现边 */
  coOccurPerFact: 5,
  /** 每个新事实最多几条依赖边（工具序列 + 过程步骤共用） */
  dependsOnPerFact: 2,
} as const;

/** 工具序列的相邻判定窗口：5 min（§5.12.6） */
const TOOL_SEQ_WINDOW_MS = 5 * 60 * 1000;
/** 共现的时间窗：1 h（§5.12.6） */
const CO_OCCUR_WINDOW_MS = 60 * 60 * 1000;

export type EdgeRule = 'tool_seq' | 'procedure' | 'co_occur' | 'supersedes';

export interface EdgeRuleStats {
  tool_seq: number;
  procedure: number;
  co_occur: number;
  supersedes: number;
}

export interface ExtractEdgesResult {
  /** 本轮新插入的边 */
  created: EdgeRuleStats;
  /** 去重 / 配额挡掉的候选数 */
  skipped: number;
}

export interface ExtractEdgesInput {
  /** 本轮刚写入（或刷新）的事实；只处理 id 有效、未收口的 */
  facts: readonly Fact[];
  /** 记录时间，默认 now */
  now?: string;
}

type CandidateRow = FactRef;

function emptyStats(): EdgeRuleStats {
  return { tool_seq: 0, procedure: 0, co_occur: 0, supersedes: 0 };
}

function frozenEntityId(fact: Fact): string | null {
  const subject = fact.attrs?.frozen?.subject as { entity_id?: unknown } | undefined;
  return typeof subject?.entity_id === 'string' ? subject.entity_id : null;
}

function frozenPredicate(fact: Fact): string | null {
  const p = fact.attrs?.frozen?.predicate;
  return typeof p === 'string' ? p : null;
}

function msOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 活跃边已存在 → 不重复写 */
function alreadyLinked(db: Db, src: string, dst: string, etype: 'depends_on' | 'co_occur' | 'supersedes'): boolean {
  return findActiveEdge(db, src, dst, etype) !== null;
}

function addEdge(
  db: Db,
  stats: EdgeRuleStats,
  src: string,
  dst: string,
  etype: 'depends_on' | 'co_occur' | 'supersedes',
  confidence: number,
  rule: EdgeRule,
  weight: number,
  ts: string,
): boolean {
  if (src === dst) return false;
  if (alreadyLinked(db, src, dst, etype)) return false;
  insertEdge(db, {
    id: newId('edge'),
    src,
    dst,
    etype,
    weight,
    confidence,
    validAt: ts,
    recordedAt: ts,
    provenance: `rule:${rule}`,
  });
  stats[rule] += 1;
  return true;
}

function stepsOf(fact: Fact): string[] {
  const steps = fact.attrs?.ext?.['steps'];
  if (!Array.isArray(steps)) return [];
  return steps.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * 按四条规则给一批新事实抽边。
 *
 * 批的粒度跟 annotation 一致（单块 ≤ 20 条），所以这里的库查询都是小范围扫描；
 * 跨批的边靠"活跃边唯一"去重保证幂等。
 */
export function extractEdges(db: Db, input: ExtractEdgesInput): ExtractEdgesResult {
  const ts = input.now ?? nowIso();
  const created = emptyStats();
  let skipped = 0;

  for (const fact of input.facts) {
    if (!fact?.id || fact.validTo !== null) continue;
    const entityId = frozenEntityId(fact);
    const predicate = frozenPredicate(fact);

    // ── 规则 4：时间序取代（不受配额限制，先做）
    // 方向 旧 → 新（概设 §3.6 ③、详设 §5.7.2，与 conflict.ts 同向）；只连最近的一条旧值，
    // 多代旧值之间不连边，否则图会变成链。写入冲突已建过同一条边时跳过（I-52）。
    if (entityId !== null && predicate !== null) {
      const [old] = factRepo.listSupersedeCandidates(db, { id: fact.id, entityId, predicate, before: fact.validAt });
      if (old !== undefined && !addEdge(db, created, old.id, fact.id, 'supersedes', RULE_CONFIDENCE.supersedes, 'supersedes', 1.0, ts)) {
        skipped += 1;
      }
    }

    // ── 规则 1 + 2：依赖边（共用 2 条配额）
    let dependsUsed = 0;
    const dependsBudget = (): boolean => dependsUsed < EDGE_QUOTA.dependsOnPerFact;

    // 规则 1：工具序列。同 episode 的 tool_obs 事实里，紧邻的上一条（间隔 ≤ 5 min）
    if (fact.confidenceSource === 'tool_obs' && fact.sourceEpisode !== null && dependsBudget()) {
      const peers = factRepo.listEpisodeToolFacts(db, fact.sourceEpisode, fact.id);
      const selfTs = msOf(fact.validAt);
      // 找"前一条"：valid_at <= 本条的最后一个
      let prev: CandidateRow | null = null;
      for (const peer of peers) {
        if (msOf(peer.validAt) <= selfTs) prev = peer;
        else break;
      }
      if (prev !== null && Math.abs(selfTs - msOf(prev.validAt)) <= TOOL_SEQ_WINDOW_MS) {
        if (
          addEdge(db, created, fact.id, prev.id, 'depends_on', RULE_CONFIDENCE.toolSeq, 'tool_seq', 1.0, ts)
        ) {
          dependsUsed += 1;
        } else {
          skipped += 1;
        }
      }
    }

    // 规则 2：过程步骤。procedure 事实的 steps[] 相邻项，解析到同 episode 的事实
    const steps = stepsOf(fact);
    if (steps.length >= 2 && fact.sourceEpisode !== null) {
      const byName = new Map<string, string>();
      for (const row of factRepo.listEpisodeFactNames(db, fact.sourceEpisode, fact.id)) {
        byName.set(row.name.toLowerCase(), row.id);
      }
      for (let i = 0; i + 1 < steps.length && dependsBudget(); i += 1) {
        const a = byName.get(steps[i]!.toLowerCase());
        const b = byName.get(steps[i + 1]!.toLowerCase());
        if (a === undefined || b === undefined) continue;
        // 步骤 b 依赖步骤 a：先做的在 dst
        if (
          addEdge(db, created, b, a, 'depends_on', RULE_CONFIDENCE.procedure, 'procedure', 1.0, ts)
        ) {
          dependsUsed += 1;
        } else {
          skipped += 1;
        }
      }
    }

    // ── 规则 3：同实体共现（5 条配额，按时间距离截断）
    if (entityId !== null) {
      let used = 0;
      const selfMs = msOf(fact.validAt);
      const from = new Date(selfMs - CO_OCCUR_WINDOW_MS).toISOString();
      const to = new Date(selfMs + CO_OCCUR_WINDOW_MS).toISOString();
      for (const peer of factRepo.listCoOccurCandidates(db, {
        id: fact.id,
        entityId,
        from,
        to,
        at: fact.validAt,
      })) {
        if (used >= EDGE_QUOTA.coOccurPerFact) break;
        const gap = Math.abs(msOf(peer.validAt) - msOf(fact.validAt));
        if (gap > CO_OCCUR_WINDOW_MS) continue;
        // weight 随时间距离衰减：贴着的 1.0，差满 1h 的 ~0.05
        const weight = Math.max(0.05, 1 - gap / CO_OCCUR_WINDOW_MS);
        if (
          addEdge(db, created, fact.id, peer.id, 'co_occur', RULE_CONFIDENCE.coOccur, 'co_occur', weight, ts)
        ) {
          used += 1;
        } else {
          skipped += 1;
        }
      }
    }
  }

  return { created, skipped };
}

/** `created` 各规则之和——验收口径"每 10 条新事实 ≥ 3 条边"按它算 */
export function totalCreated(stats: EdgeRuleStats): number {
  return stats.tool_seq + stats.procedure + stats.co_occur + stats.supersedes;
}

