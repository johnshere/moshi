/**
 * δ 门控与重跑裁决（详设 §7.5；台账 P3-08）。
 *
 * `gat_mode='on'` 时，模型给的 δ 不是"直接加到置信上就完事"——五步门控：
 *
 *   1. `|δ| > delta_cap` → clamp（`model.delta_cap`，默认 0.15）
 *   2. `cand = clamp(confidence + δ, 0, 1)`
 *   3. `overturn_prob > 0.5` 且 `δ < 0` → 丢弃（模型自己都不确定，就别下调）
 *   4. 用 `cand` 重跑符号裁决（只影响该事实所在的互斥组）
 *   5. 若裁决结果翻转（原胜者变败者）→ 丢弃 δ，保留原值
 *   6. 否则落库：`confidence = cand`、`confidence_source = 'gat_delta'`、写 audit
 *
 * 第 5 步是 K3 的代码化：**符号硬约束可以覆盖神经高分**。不做这条，训练几轮后
 * GAT 会把互斥裁决全推翻——而它没有能力做这件事。
 *
 * 反翻转的判定粒度是 `canonical_key`：同一互斥组里任何一个事实的 `disputedBy`
 * 关系变了，就整组回退（δ 是给组里的某个事实加的，单看单个事实无法判断组内平衡
 * 是否已被破坏）。
 */
import type { Fact } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import { setConfidence } from '../../infra/sqlite/factRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import { adjudicate, type AdjudicateOptions, type AdjudicateResult } from './adjudicate.js';
import type { SubgraphEdge } from './subgraph.js';

export const DEFAULT_DELTA_CAP = 0.15;
/** `overturn_prob` 超过这个值就不允许下调置信（详设 §7.5 第 3 步） */
export const OVERTURN_GUARD = 0.5;

export interface NeuralScore {
  delta: number;
  overturnProb: number;
}

export type RejectReason = 'overturn_guard' | 'mutex_flip' | 'unchanged';

export interface AppliedDelta {
  factId: string;
  before: number;
  after: number;
  delta: number;
}

export interface RejectedDelta {
  factId: string;
  reason: RejectReason;
}

export interface GateResult {
  result: AdjudicateResult;
  applied: AppliedDelta[];
  rejected: RejectedDelta[];
}

/** 步骤 1–3：纯函数，单测直接打这里 */
export function gateOne(
  confidence: number,
  score: NeuralScore,
  cap: number = DEFAULT_DELTA_CAP,
): { applied: boolean; value: number; delta: number; reason?: RejectReason } {
  const delta = Math.min(cap, Math.max(-cap, score.delta)); // ①
  if (score.overturnProb > OVERTURN_GUARD && delta < 0) {
    return { applied: false, value: confidence, delta, reason: 'overturn_guard' }; // ③
  }
  const cand = Math.min(1, Math.max(0, confidence + delta)); // ②
  if (Math.abs(cand - confidence) < 1e-9) {
    return { applied: false, value: confidence, delta, reason: 'unchanged' };
  }
  return { applied: true, value: cand, delta };
}

function disputedSignature(result: AdjudicateResult): Map<string, string> {
  const sig = new Map<string, string>();
  for (const item of result.kept) {
    // "谁压住了谁" = 组内平衡；败者用自身也记一条，避免只看胜者漏掉换人
    sig.set(item.fact.id, item.disputedBy ?? '');
  }
  return sig;
}

/** 同 canonical_key 下有没有任何事实的裁决关系发生变化 */
function groupFlipped(
  before: Map<string, string>,
  after: Map<string, string>,
  groupIds: readonly string[],
): boolean {
  for (const id of groupIds) {
    if (!before.has(id) || !after.has(id)) return true; // 被低置信丢弃/重新加入 = 翻转
    if (before.get(id) !== after.get(id)) return true;
  }
  return false;
}

export interface ApplyDeltasOptions extends AdjudicateOptions {
  scores: ReadonlyMap<string, NeuralScore>;
  deltaCap?: number;
  /** audit 的 `reason`（`model:<版本>`） */
  modelVersion?: string | null;
  /** false = 只算不落库（测试 / 预演） */
  persist?: boolean;
}

/**
 * 步骤 1–6 的编排。返回**已经算好的裁决结果**（调用方直接用它，不要再 adjudicate 一次）。
 */
export function applyNeuralDeltas(
  db: Db,
  facts: readonly Fact[],
  edges: readonly SubgraphEdge[],
  opts: ApplyDeltasOptions,
): GateResult {
  const cap = opts.deltaCap ?? DEFAULT_DELTA_CAP;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const baseOpts: AdjudicateOptions = {
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.base === undefined ? {} : { base: opts.base }),
    ...(opts.keepExpired === undefined ? {} : { keepExpired: opts.keepExpired }),
  };

  // ── ④ 的对照：不带 δ 的裁决 ──
  const baseline = adjudicate(db, facts, edges, baseOpts);

  // ── 1–3：逐个事实门控 ──
  const applied: AppliedDelta[] = [];
  const rejected: RejectedDelta[] = [];
  const patched = new Map<string, Fact>();
  for (const [factId, score] of opts.scores) {
    const fact = byId.get(factId);
    if (fact === undefined) continue; // 模型打了不在候选里的节点：忽略
    const gated = gateOne(fact.confidence, score, cap);
    if (!gated.applied) {
      rejected.push({ factId, reason: gated.reason ?? 'unchanged' });
      continue;
    }
    patched.set(factId, { ...fact, confidence: gated.value, confidenceSource: 'gat_delta' });
    applied.push({ factId, before: fact.confidence, after: gated.value, delta: gated.delta });
  }

  if (applied.length === 0) {
    return { result: baseline, applied, rejected };
  }

  // ── ④ 重跑裁决（用 cand 当置信）──
  const trialFacts = facts.map((f) => patched.get(f.id) ?? f);
  const trial = adjudicate(db, trialFacts, edges, baseOpts);

  // ── ⑤ 同组翻转 → 整组回退 ──
  const beforeSig = disputedSignature(baseline);
  const afterSig = disputedSignature(trial);
  const flipKeys = new Set<string>();
  for (const item of applied) {
    const fact = byId.get(item.factId)!;
    if (flipKeys.has(fact.canonicalKey)) continue;
    const groupIds = facts.filter((f) => f.canonicalKey === fact.canonicalKey).map((f) => f.id);
    if (groupFlipped(beforeSig, afterSig, groupIds)) flipKeys.add(fact.canonicalKey);
  }
  const survivors = applied.filter((a) => !flipKeys.has(byId.get(a.factId)!.canonicalKey));
  for (const a of applied) {
    if (flipKeys.has(byId.get(a.factId)!.canonicalKey)) rejected.push({ factId: a.factId, reason: 'mutex_flip' });
  }

  if (survivors.length === 0) {
    return { result: baseline, applied: [], rejected };
  }

  const finalFacts =
    survivors.length === applied.length
      ? trialFacts
      : facts.map((f) => {
          const keep = survivors.some((s) => s.factId === f.id);
          return keep ? (patched.get(f.id) ?? f) : f;
        });
  const result = survivors.length === applied.length ? trial : adjudicate(db, finalFacts, edges, baseOpts);

  // ── ⑥ 落库 + audit ──
  // 整批一个事务：中途失败（并发删除 → E_NOT_FOUND）不能留下"改了一半"的置信，
  // 否则下一次查询看到的是同一批 δ 只生效一部分的状态。
  if (opts.persist !== false) {
    const reason = `model:${opts.modelVersion ?? 'unknown'}`;
    withTransaction(db, () => {
      for (const s of survivors) {
        setConfidence(db, s.factId, {
          value: s.after,
          source: 'gat_delta',
          reason,
          ...(opts.now === undefined ? {} : { ts: opts.now }),
        });
      }
    });
  }

  return { result, applied: survivors, rejected };
}
