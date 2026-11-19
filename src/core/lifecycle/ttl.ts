/**
 * TTL 到期：把「采用期已结束」的事实收口成**无后继失效**（P2② 生命周期缺口）。
 *
 * ## 为什么需要
 *
 * 现网 1003 条失效事实里，946 条 `has_active_successor`（被新版本取代）、51 条
 * `recheck_kind=none`，复检复活 **0** 条——说明全仓的失效都来自"写入路径的情形 C"，
 * 没有一条来自"到期"或"撤回"。复检规则本身不是缺口，**缺的是产出无后继失效的路径**。
 *
 * ## 判据（全部来自设计文档）
 *
 * - 三条时间轴（`docs/调研-Agent记忆系统范围模型.md` §范围模型）：
 *   真值有效期 `valid_at/valid_to`；记录/采用期 `recorded_at/expired_at`；
 *   保留期 `expires_at`/TTL（**会话级、临时记忆**）。
 *   所以 TTL 只允许落在临时类：`retention_class ∈ {cache, event, session}`；
 *   `durable` 是长期记忆（详设 §5.3.1 V-05 门禁：durable 必须有准入理由），
 *   给它设有效期等于自造"长期记忆会过期"的语义，直接拒绝。
 * - `expired_at` = 系统何时不再采用这条记录（调研 doc 的同名列）。设期即写
 *   `expired_at = now + ttl`，到期扫描以它为界；`ttl_seconds` 记原始时长。
 * - 到期收口：`valid_to = expired_at`（**采用期结束的时刻**，不是扫描时刻——扫描
 *   可能晚几小时，写扫描时刻会把"本该已失效"的那段区间算成有效，污染时间切片）、
 *   `epistemic_status='invalidated'`（详设 §2.4 I6：`valid_to` 非空 ⇒ invalidated）、
 *   `superseded_by` 保持 NULL（**没有后继**，因此不建 `supersedes` 边）。
 * - 不删行、不改 content/attrs（概设 §5.5.4 红线；详设 §8.1 第 2 条：失效事实
 *   强度算 0 但行保留），每次收口必写 audit（`field='valid_to'`，`source='rule:ttl'`）。
 *
 * ## 与复检的关系（重要）
 *
 * 收口后 `valid_to` 在**过去**，复检的 `valid_to_in_future` 判据不会命中；能否被
 * 捞回取决于 `evidence_alive`（这条事实仍躺在历史查询的证据包里）与
 * `recheck_kind='command'`（`none/manual/on_read` 在判据最前面就维持了）。这是
 * 设计使然：TTL 收口的是"临时观测"，只有**确实被引用过**且承诺命令复检的行才该
 * 回来；回来时 `reactivate` 会清 `expired_at`（见 factRepo.reactivate），所以不会
 * 被下一轮 TTL 立刻再收口（两个循环不抖动）。
 */
import { addMs } from '../../domain/time.js';
import type { Fact } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import { armTtl, closeFactWithAudit, getFact, listDueTtlFacts } from '../../infra/sqlite/factRepo.js';

/** 限速（条/秒）。详设 §8.6 调度总则：每任务 20 条/秒；`0` = 不限速 */
export const TTL_RATE_PER_SEC = 20;
/** 审计来源（与人工撤销 `human`、复检 `rule:recheck` 区分） */
export const TTL_SOURCE = 'rule:ttl';
/** 默认有效期：1 天（模块常量，CLI 可用 `--ttl-seconds` / `--days` 覆盖；不改 config） */
export const TTL_DEFAULT_SECONDS = 86_400;
/** 允许设有效期的保留类（调研 doc：TTL 只服务保留期/临时记忆；durable 是长期记忆） */
export const TTL_ARMABLE_RETENTION: readonly string[] = ['cache', 'event', 'session'];

export type TtlArmSkip = 'already_armed' | 'closed' | 'retention_durable' | 'not_found';

export interface ArmTtlOptions {
  /** 目标事实 id（人工指定，不做全表批量——设有效期是显式决策） */
  ids: readonly string[];
  /** 有效期时长（秒） */
  ttlSeconds: number;
  /** 设期基准时刻，默认当前时刻（测试注入用） */
  now?: string;
  /** 只统计不写库（CLI `--dry-run`） */
  dryRun?: boolean;
}

export interface ArmTtlResult {
  /** 实际设期（`dryRun` 时为"将设期"）的条数 */
  armed: number;
  /** 已设过有效期、本次不动也不写审计（幂等） */
  alreadyArmed: number;
  /** 已失效（`valid_to` 非空），不能再设期 */
  closed: number;
  /** 保留类不允许设 TTL（`durable`），按跳过处理并计数 */
  skippedRetention: number;
  /** 不存在的 id（调用方决定是否视为错误） */
  notFound: string[];
  /** 跳过的保留类分布（`durable n`） */
  byRetention: Record<string, number>;
  ms: number;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * 给一批事实设有效期。**幂等**：已设过 `expired_at` 的行原样跳过，不写第二条审计；
 * 重复执行同一批 `--id` 第二次返回 `armed: 0 / alreadyArmed: N`。
 */
export function armTtlForFacts(db: Db, opts: ArmTtlOptions): ArmTtlResult {
  const startedAt = performance.now();
  const now = opts.now ?? new Date().toISOString();
  const dryRun = opts.dryRun ?? false;
  const res: ArmTtlResult = {
    armed: 0,
    alreadyArmed: 0,
    closed: 0,
    skippedRetention: 0,
    notFound: [],
    byRetention: {},
    ms: 0,
  };
  const expiresAt = addMs(now, opts.ttlSeconds * 1000);

  for (const id of opts.ids) {
    const fact = getFact(db, id);
    if (fact === null) {
      res.notFound.push(id);
      continue;
    }
    if (fact.validTo !== null) {
      res.closed += 1;
      continue;
    }
    const retention = fact.retentionClass ?? 'null';
    if (!TTL_ARMABLE_RETENTION.includes(retention)) {
      res.skippedRetention += 1;
      bump(res.byRetention, retention);
      continue;
    }
    if (fact.expiredAt !== null) {
      res.alreadyArmed += 1;
      continue;
    }
    res.armed += 1;
    if (dryRun) continue;
    armTtl(db, id, {
      ttlSeconds: opts.ttlSeconds,
      expiresAt,
      source: TTL_SOURCE,
      reason: `ttl_armed:${opts.ttlSeconds}s`,
      ts: now,
    });
  }

  res.ms = Math.round(performance.now() - startedAt);
  return res;
}

export interface ExpireTtlOptions {
  /** 本轮最多收口多少条；`0`/不传 = 全部到期行（按 id 升序） */
  limit?: number;
  /** 只统计不写库 */
  dryRun?: boolean;
  /** 限速（条/秒），默认 `TTL_RATE_PER_SEC`；`0` = 不限速 */
  ratePerSec?: number;
  /** 扫描基准时刻，默认当前时刻（测试注入用） */
  now?: string;
}

export interface ExpireTtlResult {
  /** 到期但仍活跃的事实数 */
  scanned: number;
  /** 收口数（`dryRun` 时为"将收口"） */
  closed: number;
  /** 与判定之间被并发收口/复活、按跳过重算的行 */
  raced: number;
  /** `expired_at <= valid_at`（设期时 ttl 太短或行是"未来事实"），无法收口 */
  beforeValidAt: number;
  /** 到期行的保留类分布 */
  byRetention: Record<string, number>;
  ms: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 跑一轮到期扫描：`expired_at <= now AND valid_to IS NULL` → 收口为无后继失效。
 *
 * 单条收口各自成事务（`closeFactWithAudit` 内部已包）；中途失败不会留下"改了一半"
 * 的行，下一轮重扫即可补上（可重入）。
 */
export async function expireDueFacts(
  db: Db,
  opts: ExpireTtlOptions = {},
): Promise<ExpireTtlResult> {
  const startedAt = performance.now();
  const dryRun = opts.dryRun ?? false;
  const ratePerSec = opts.ratePerSec ?? TTL_RATE_PER_SEC;
  const now = opts.now ?? new Date().toISOString();

  const facts: Fact[] = listDueTtlFacts(db, now, opts.limit ?? 0);
  const res: ExpireTtlResult = {
    scanned: facts.length,
    closed: 0,
    raced: 0,
    beforeValidAt: 0,
    byRetention: {},
    ms: 0,
  };

  let writes = 0;
  for (const fact of facts) {
    bump(res.byRetention, fact.retentionClass ?? 'null');
    const validTo = fact.expiredAt ?? null;
    if (validTo === null || !(validTo > fact.validAt)) {
      res.beforeValidAt += 1;
      continue;
    }
    res.closed += 1;
    if (dryRun) continue;
    // 限速只在两条写之间：第一条不必等，dry-run 不写库也不必等
    if (ratePerSec > 0 && writes > 0) await delay(Math.ceil(1000 / ratePerSec));
    const done = closeFactWithAudit(db, fact.id, {
      validTo,
      status: 'invalidated',
      supersededBy: null,
      source: TTL_SOURCE,
      reason: 'ttl_elapsed',
      ts: now,
    });
    if (!done) {
      res.closed -= 1;
      res.raced += 1;
      continue;
    }
    writes += 1;
  }

  res.ms = Math.round(performance.now() - startedAt);
  return res;
}
