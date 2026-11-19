/**
 * 复检（recheck）：已失效事实的「复活 / 维持 / 待审」三选一（P2② 生命周期缺口）。
 *
 * 为什么需要：`consolidate` 只**新增**派生事实，全仓没有任何复检入口（详设 §8.6 的
 * JOBS 里也没有 recheck），于是失效只能单向累积——1550 条事实里 992 条已失效、
 * 558 条活跃，而且没有任何机制把"当时判错了"的行捞回来。
 *
 * ## 判据（全部来自设计文档，不自创新概念）
 *
 * 入口只处理**已失效**（`valid_to` 非空，即"过期"）的事实行，再按 `recheck_kind`
 * 分流。`recheck_kind` 是 V-05 七字段之一（详设 §1.4 / §8.1，`none | command |
 * manual | on_read`），它本身就是"过期后如何确认"的答案，所以本任务只对
 * `command`（命令复检）动手，其余三种维持原状：
 *
 * 1. `none`   → 维持。设计上就没有复检义务（详设 §8.1 "说不清为什么值得记的观测"）。
 * 2. `manual` → 维持（reason=`manual_pending`）。等人/等 UI 队列，自动任务不许替人拍板
 *               （概设 §5.5.2"进 UI 待确认"）。
 * 3. `on_read` → 维持（reason=`on_read_lazy`）。它的复检时机是**读时**（惰性），
 *               不是后台任务。
 * 4. **身份已有活跃行** → 维持（reason=`has_active_successor`）。这是硬约束而非偏好：
 *    复活旧行会让同一身份同时有两个有效取值，同值时更会直接撞
 *    `idx_fact_identity`（`(canonical_key, scope, value_hash) WHERE valid_to IS NULL`）；
 *    而"同身份又有活跃取值"本身就说明旧行已被取代（详设 §2.8 情形 C/D）。
 * 5. **`valid_to` 在未来** → 复活（reason=`valid_to_in_future`）。双时态里 `valid_to`
 *    是**世界的**失效时刻（详设 §2.1）：未来时刻意味着"失效还没发生"，是提前写入的
 *    收口，撤销它不改变任何已发生的事实。
 * 6. **仍有未失效 evidence** → 复活（reason=`evidence_alive`）。`evidence_log` 行随
 *    query_log 保留期一起清（详设 §6.12 回放链），行还在就说明这条事实仍被历史查询
 *    当作证据包的一部分引用；复活时把强度抬到 `VALIDATE_FLOOR`（概设 §5.5.1
 *    "独立验证 s ← max(s, floor)"，初值 0.60），否则失效期间被算成 0 的强度会让它
 *    一复活就沉底。
 * 7. **淘汰候选** → 待审（reason=`idle_prune_candidate`）。口径取自详设 §8.3.4
 *    淘汰候选 SQL 的闲置条件（`last_access_at` 早于 60 天前）：失效后不再被读，
 *    所以以 `valid_to` 作闲置起点。候选**只标记不删**（概设 §5.5.1 第 3 条 /
 *    详设 §8.3.4"产出候选清单，不自动删"），标记落在 `attrs.ext.recheck`。
 * 8. 其余 → 维持（reason=`no_evidence`）。
 *
 * **不作为判据的一项**：`confidence` 回升。置信只在写入/校准路径变化（详设 §5.8），
 * 不随时间衰减，所以"回升"不是可观测状态；拿绝对置信阈值当复活条件等于自造口径。
 *
 * ## 写库口径
 *
 * 复活走 `factRepo.reactivate`（清 `valid_to` + 回 `active` + 强度 floor + 必写
 * audit），待审走 `factRepo.markRecheckPending`（写 `attrs.ext.recheck` + audit）。
 * 两者都**不改 content / attrs.frozen / canonical_key**，也不删任何行。
 */
import { isMoshiError } from '../../domain/errors.js';
import { nowIso, parseTs } from '../../domain/time.js';
import type { Fact } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import {
  hasActiveByIdentity,
  listExpiredFacts,
  markRecheckPending,
  reactivate,
} from '../../infra/sqlite/factRepo.js';
import { hasEvidenceForFact } from '../../infra/sqlite/queryLogRepo.js';

/** 限速（条/秒）。详设 §8.6 调度总则：每任务 20 条/秒；`0` = 不限速 */
export const RECHECK_RATE_PER_SEC = 20;
/** 淘汰候选的闲置天数（详设 §8.3.4） */
export const RECHECK_IDLE_DAYS = 60;
/** 审计来源：与人工撤销失效（`human`）区分开 */
export const RECHECK_SOURCE = 'rule:recheck';

export type RecheckVerdict = 'reactivate' | 'maintain' | 'pending_review';

export type RecheckReason =
  | 'recheck_none'
  | 'manual_pending'
  | 'on_read_lazy'
  | 'has_active_successor'
  | 'valid_to_in_future'
  | 'evidence_alive'
  | 'idle_prune_candidate'
  | 'no_evidence';

export interface RecheckJudgement {
  verdict: RecheckVerdict;
  reason: RecheckReason;
}

/**
 * 判据的外部读数。用函数而不是布尔值：非 `command` 的行不必为它查两次库
 * （1003 条里 51 条是 `none`），也让判据单测可以不建库。
 */
export interface RecheckProbe {
  /** 判定基准时刻（ISO）；由调用方注入，测试可固定 */
  now: string;
  hasActiveSuccessor: () => boolean;
  hasEvidence: () => boolean;
}

/** 失效后是否已闲置到"淘汰候选"口径（详设 §8.3.4 的 60 天） */
export function isIdleExpired(fact: Fact, now: string): boolean {
  if (fact.validTo === null) return false;
  return parseTs(now) - parseTs(fact.validTo) > RECHECK_IDLE_DAYS * 864e5;
}

/** 单条已失效事实的判定（纯函数；判据顺序见文件头，顺序不可换） */
export function judgeExpiredFact(fact: Fact, probe: RecheckProbe): RecheckJudgement {
  if (fact.validTo === null) return { verdict: 'maintain', reason: 'no_evidence' };
  if (fact.recheckKind === 'none') return { verdict: 'maintain', reason: 'recheck_none' };
  if (fact.recheckKind === 'manual') return { verdict: 'maintain', reason: 'manual_pending' };
  if (fact.recheckKind === 'on_read') return { verdict: 'maintain', reason: 'on_read_lazy' };
  if (probe.hasActiveSuccessor()) {
    return { verdict: 'maintain', reason: 'has_active_successor' };
  }
  if (fact.validTo > probe.now) return { verdict: 'reactivate', reason: 'valid_to_in_future' };
  if (probe.hasEvidence()) return { verdict: 'reactivate', reason: 'evidence_alive' };
  if (isIdleExpired(fact, probe.now)) {
    return { verdict: 'pending_review', reason: 'idle_prune_candidate' };
  }
  return { verdict: 'maintain', reason: 'no_evidence' };
}

export interface RecheckOptions {
  /** 本轮最多扫多少条已失效事实；`0`/不传 = 全部 */
  limit?: number;
  /** 只统计不写库（CLI `--dry-run`） */
  dryRun?: boolean;
  /** 限速（条/秒），默认 `RECHECK_RATE_PER_SEC`；`0` = 不限速 */
  ratePerSec?: number;
  /** 判定基准时刻，默认当前时刻（测试注入用） */
  now?: string;
}

export interface RecheckResult {
  /** 扫到的已失效事实数 */
  scanned: number;
  /** 复活数（`dryRun` 时为"将复活"） */
  reactivated: number;
  /** 维持失效数 */
  maintained: number;
  /** 标记待审数（`dryRun` 时为"将标记"） */
  pendingReview: number;
  /** 判定与写库之间被并发改掉、按维持重算的行（并发巩固/人工操作） */
  raced: number;
  /** 判据分布（含维持与待审的原因） */
  byReason: Record<string, number>;
  /** 复检方式分布（`none | command | manual | on_read`） */
  byRecheckKind: Record<string, number>;
  ms: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * 跑一轮复检：扫已失效事实 → 判定 → 复活 / 标记待审 / 维持。
 *
 * 单条写库各自成事务（`reactivate` / `markRecheckPending` 内部已包），
 * 中途失败不会留下"改了一半"的行；下一轮重扫即可补上（可重入）。
 */
export async function recheckExpiredFacts(
  db: Db,
  opts: RecheckOptions = {},
): Promise<RecheckResult> {
  const startedAt = performance.now();
  const dryRun = opts.dryRun ?? false;
  const ratePerSec = opts.ratePerSec ?? RECHECK_RATE_PER_SEC;
  const now = opts.now ?? nowIso();

  const facts = listExpiredFacts(db, opts.limit ?? 0);
  const res: RecheckResult = {
    scanned: facts.length,
    reactivated: 0,
    maintained: 0,
    pendingReview: 0,
    raced: 0,
    byReason: {},
    byRecheckKind: {},
    ms: 0,
  };

  let writes = 0;
  for (const fact of facts) {
    bump(res.byRecheckKind, fact.recheckKind ?? 'none');
    const judgement = judgeExpiredFact(fact, {
      now,
      hasActiveSuccessor: () => hasActiveByIdentity(db, fact.canonicalKey, fact.scope),
      hasEvidence: () => hasEvidenceForFact(db, fact.id),
    });
    bump(res.byReason, judgement.reason);

    if (judgement.verdict === 'maintain') {
      res.maintained += 1;
      continue;
    }
    if (judgement.verdict === 'reactivate') {
      res.reactivated += 1;
      if (dryRun) continue;
      // 限速只在两条写之间：第一条不必等，dry-run 不写库也不必等
      if (ratePerSec > 0 && writes > 0) await delay(Math.ceil(1000 / ratePerSec));
      try {
        reactivate(db, fact.id, { ts: now, source: RECHECK_SOURCE, reason: judgement.reason });
      } catch (err) {
        // 判定与写库之间被并发改掉（已被复活/被新行取代）：不是错误，按维持重算
        if (
          isMoshiError(err) &&
          (err.code === 'E_CONFLICT_IDENTITY' || err.code === 'E_IMMUTABLE')
        ) {
          res.reactivated -= 1;
          res.maintained += 1;
          res.raced += 1;
          continue;
        }
        throw err;
      }
      writes += 1;
      continue;
    }
    res.pendingReview += 1;
    if (dryRun) continue;
    if (ratePerSec > 0 && writes > 0) await delay(Math.ceil(1000 / ratePerSec));
    markRecheckPending(db, fact.id, { ts: now, reason: judgement.reason });
    writes += 1;
  }

  res.ms = Math.round(performance.now() - startedAt);
  return res;
}
