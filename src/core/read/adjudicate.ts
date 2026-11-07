/**
 * 符号兜底五步（详设 §6.7，硬顺序执行）。
 *
 * 输入候选 facts（已融合、已建子图），输出"可进证据包"的 kept 列表：
 * 每步按序处理，前步的产出是后步的输入。五步：
 *   ① 时态失效   valid_to <= now → 排除（计入 historical_excluded）
 *   ② 互斥      同 canonical_key 且谓词 cardinality='single-valued'（ontology 表），
 *               winner = argmax(confidence × strength)，败者 flag 'disputed'，
 *               每对写 adjudication（kind='mutex_win'，去重）
 *   ③ 低置信     confidence < 0.5 → 不进包（计入 low_confidence_dropped）
 *   ④ 依赖失效   depends_on 边 src→dst，src 的 epistemic_status ∈ {invalidated, pruned}
 *               → dst flag 'stale_dependency'
 *   ⑤ 身份未决   subject 实体 etype='unknown' → flag 'identity_unresolved'
 *
 * finalScore = 0.55 × base + 0.30 × neural + 0.15 × strength（§6.7）。
 * base   = §6.5 的融合分（调用方归一化后经 `base` 传入；归档等离线场景缺省 0）
 * neural = confidence + GAT δ（P3 才有 δ；P1 期恒等于 confidence）
 * strength 只在这里生效、从不进子图特征（FEATURE_FIELDS 白名单约束）。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { getEntity } from '../../infra/sqlite/entityRepo.js';
import { MUTEX_FAVORED_DECIDED_BY, openAdjudicationOnce } from '../../infra/sqlite/adjudicationRepo.js';
import { getPredicateCardinality } from '../../infra/sqlite/ontologyRepo.js';
import type { Fact } from '../../domain/types.js';
import type { SubgraphEdge } from './subgraph.js';

export type AdjudicationFlag = 'historical' | 'disputed' | 'stale_dependency' | 'identity_unresolved';

export interface AdjudicatedFact {
  fact: Fact;
  finalScore: number;
  flags: AdjudicationFlag[];
  /** 互斥败者：被哪个 winner 压住 */
  disputedBy: string | null;
}

export interface AdjudicationStats {
  historical_excluded: number;
  low_confidence_dropped: number;
  disputed: number;
  stale_dependency: number;
  identity_unresolved: number;
}

export interface AdjudicateOptions {
  now?: string;
  /** §6.5 的融合分（0~1.5）：fact_id → 归一化后的 fused 分；缺省 0 */
  base?: ReadonlyMap<string, number>;
  /** GAT delta（P3）：fact_id → δ；缺省 0，此时 neural 就取 confidence 本身 */
  neural?: ReadonlyMap<string, number>;
  /**
   * 跳过第①步的时态剔除（详设 §4.1.1 的 `include_history`）。
   * 默认 false：失效行不进包。调用方显式要历史时才置 true。
   */
  keepExpired?: boolean;
}

export interface AdjudicateResult {
  kept: AdjudicatedFact[];
  stats: AdjudicationStats;
  /** 本轮回填的 adjudication 条数（去重后真实写入数） */
  adjudicationWrites: number;
}

const FLAG_ORDER: readonly AdjudicationFlag[] = ['historical', 'disputed', 'stale_dependency', 'identity_unresolved'];

export function adjudicate(db: Db, facts: readonly Fact[], edges: readonly SubgraphEdge[], opts: AdjudicateOptions = {}): AdjudicateResult {
  const now = opts.now ?? new Date().toISOString();
  const base = opts.base ?? new Map();
  const gnnDelta = opts.neural ?? new Map();
  const stats: AdjudicationStats = {
    historical_excluded: 0,
    low_confidence_dropped: 0,
    disputed: 0,
    stale_dependency: 0,
    identity_unresolved: 0,
  };
  let adjudicationWrites = 0;

  // ── ① 时态失效 ──
  let working =
    opts.keepExpired === true ? [...facts] : facts.filter((f) => f.validTo === null || f.validTo > now);
  stats.historical_excluded = facts.length - working.length;

  // ── ② 互斥（同 canonical_key + 谓词 single-valued）──
  const flags = new Map<string, AdjudicationFlag[]>();
  const disputedBy = new Map<string, string | null>();
  const byKey = new Map<string, Fact[]>();
  for (const f of working) {
    const list = byKey.get(f.canonicalKey) ?? [];
    list.push(f);
    byKey.set(f.canonicalKey, list);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const predicates = new Set(group.map((f) => f.attrs.frozen.predicate));
    for (const pred of predicates) {
      const card = getPredicateCardinality(db, pred);
      if (card !== 'single-valued') continue;
      const inPred = group.filter((f) => f.attrs.frozen.predicate === pred);
      if (inPred.length < 2) continue;
      // winner = argmax(confidence × strength)；并列时 id 字典序靠前（稳定）
      const ranked = [...inPred].sort(
        (a, b) => b.confidence * b.strength - a.confidence * a.strength || (a.id < b.id ? -1 : 1),
      );
      const winner = ranked[0]!;
      for (const loser of ranked.slice(1)) {
        pushFlag(flags, loser.id, 'disputed');
        disputedBy.set(loser.id, winner.id);
        stats.disputed += 1;
        // decidedBy 带版本：@2 = 落库保留 winner/loser 原序，写入侧可据此回填 outcome；
        // @1（legacy）是排序 JSON，顺序已丢，写入侧不敢猜 favored。
        if (
          openAdjudicationOnce(db, {
            kind: 'mutex_win',
            factIds: [winner.id, loser.id],
            decidedBy: MUTEX_FAVORED_DECIDED_BY,
          })
        ) {
          adjudicationWrites += 1;
        }
      }
    }
  }

  // ── ③ 低置信：不进包 ──
  const beforeLow = working.length;
  working = working.filter((f) => f.confidence >= 0.5);
  stats.low_confidence_dropped = beforeLow - working.length;

  // ── ④ 依赖失效：depends_on 前置 invalidated/pruned → 后置标 stale_dependency ──
  const invalid = new Set(working.filter((f) => f.epistemicStatus === 'invalidated' || f.epistemicStatus === 'pruned').map((f) => f.id));
  for (const e of edges) {
    if (e.etype !== 'depends_on') continue;
    if (invalid.has(e.src)) {
      pushFlag(flags, e.dst, 'stale_dependency');
      stats.stale_dependency += 1;
    }
  }

  // ── ⑤ 身份未决 ──
  for (const f of working) {
    const ent = getEntity(db, f.attrs.frozen.subject.entity_id);
    if (ent !== null && ent.etype === 'unknown') {
      pushFlag(flags, f.id, 'identity_unresolved');
      stats.identity_unresolved += 1;
    }
  }

  // ── finalScore ──
  const kept: AdjudicatedFact[] = working.map((f) => {
    const fused = base.get(f.id) ?? 0;
    const neural = f.confidence + (gnnDelta.get(f.id) ?? 0);
    return {
      fact: f,
      finalScore: 0.55 * fused + 0.3 * neural + 0.15 * f.strength,
      flags: (flags.get(f.id) ?? []).sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b)),
      disputedBy: disputedBy.get(f.id) ?? null,
    };
  });

  return { kept, stats, adjudicationWrites };
}

function pushFlag(map: Map<string, AdjudicationFlag[]>, id: string, flag: AdjudicationFlag): void {
  const list = map.get(id);
  if (list === undefined) map.set(id, [flag]);
  else if (!list.includes(flag)) list.push(flag);
}
