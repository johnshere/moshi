/**
 * 来源撤回：某个来源（episode / 直写批次 / 人工指令）明确撤回时，把它支撑的
 * 活跃事实收口成**无后继失效**（P2② 生命周期缺口）。
 *
 * ## 文档依据
 *
 * - 概设 §3.4：「支持**按来源批量回滚**（某次 harvest 或某个 episode 产生的全部
 *   事实），对应综述 §14.7 的对抗防御。」
 * - 概设 §2.2 / §3.6.3：**失效 = 写 `valid_to`，不删行**——撤回改的是"这条事实
 *   何时结束"，不是"这条事实曾经写过什么"；`content` 一字不改。
 * - 概设 §5.5.4 红线：允许标 `invalidated`/`pruned`，禁止改写 content、删除事实行。
 *   所以撤回**不是** `moshi revoke <batch_id>`（P2-23 直写撤销，物理删行，语义是
 *   "写错了"），而是追加式收口，语义是"来源撤了，它支撑的结论不再成立"。
 * - 详设 §8.3.1 撤回语义补注：源撤回导致活跃源不足 → 反向对账收口，并写
 *   `rule:consolidate_reconcile` audit；人工否决另立墓碑。本路径沿用同一分层：
 *   规则触发的撤回记 `rule:source_withdraw`，人工指令记 `human`，两者不混。
 *
 * ## 为什么是"无后继"
 *
 * 撤回的事实**不找后继**：没有新观测取代它，也没有 `supersedes` 边——`superseded_by`
 * 保持 NULL。这正是复检缺口的那一类：`has_active_successor === false`，所以
 * `recheck` 的"身份已有活跃行"短路不会把它挡回去。
 *
 * 但"没有后继"还不够：撤回的事实若曾进过历史查询的证据包，`recheck` 的
 * `evidence_alive` 判据会把它又捞回来，等于撤回无效。所以撤回收口时**同一事务**
 * 在 `attrs.ext.withdrawn` 写墓碑（`{by, ts, reason}`，`ext` 是 schema 预留的 JSON
 * 扩展槽，不加列、不改 content），`recheck` 看到墓碑一律维持（判据第 4 条，
 * 排在 `evidence_alive` 之前）。撤回因此是**单向**的：只有人工显式复活才能翻案。
 *
 * ## 范围边界
 *
 * 只收口**直接由该来源产出**的事实（`fact.source_episode` / `fact.batch_id`）。
 * 派生事实（`confidence_source='derived'`，靠 `derived_from` 边挂上来）的反向对账
 * 属于 consolidate 的 `rule:consolidate_reconcile`（详设 §8.3.1），不在本路径。
 *
 * ## 幂等
 *
 * 只命中 `valid_to IS NULL` 的行，所以同一条撤回指令第二次执行命中 0 条、不写审计；
 * 单条收口在事务里再校验一次 `valid_to IS NULL`，并发下也不会重复收口。
 */
import { MoshiError } from '../../domain/errors.js';
import type { Fact } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import { getById as getEpisode } from '../../infra/sqlite/episodeRepo.js';
import {
  closeFactWithAudit,
  getFact,
  listActiveBySource,
} from '../../infra/sqlite/factRepo.js';

/** 限速（条/秒）。详设 §8.6 调度总则：每任务 20 条/秒；`0` = 不限速 */
export const WITHDRAW_RATE_PER_SEC = 20;
/** 规则触发的撤回（来源撤回、批量对账） */
export const WITHDRAW_SOURCE = 'rule:source_withdraw';
/** 人工指令撤回（UI/CLI 上的显式否决） */
export const WITHDRAW_HUMAN_SOURCE = 'human';

export type WithdrawSelector =
  | { kind: 'episode'; id: string }
  | { kind: 'batch'; id: string }
  | { kind: 'facts'; ids: readonly string[] };

export interface WithdrawOptions {
  selector: WithdrawSelector;
  /** 撤回依据的备注，追加进审计 `reason`（可选） */
  note?: string | null;
  /** true = 人工指令撤回，审计 `source` 记 `human` */
  byHuman?: boolean;
  /** 本轮最多收口多少条；`0`/不传 = 全部命中 */
  limit?: number;
  /** 只统计不写库（CLI `--dry-run`） */
  dryRun?: boolean;
  /** 限速（条/秒），默认 `WITHDRAW_RATE_PER_SEC`；`0` = 不限速 */
  ratePerSec?: number;
  /** 撤回时刻，默认当前时刻（测试注入用） */
  now?: string;
}

export interface WithdrawResult {
  /** 命中并需要收口的活跃事实数（`dryRun` 时为"将收口"） */
  matched: number;
  /** 实际收口数（`dryRun` 时等于 matched） */
  withdrawn: number;
  /** 并发下已被别处收口、按跳过重算的行 */
  raced: number;
  /** `valid_to` 已非空（重复执行/已被取代）而跳过的行 */
  alreadyClosed: number;
  /** `now <= valid_at`（撤回时刻早于事实生效），无法收口 */
  beforeValidAt: number;
  /** 不存在的 id（episode 不存在抛错；`--fact` 里不存在的 id 记在这里） */
  notFound: string[];
  /** 命中的事实 id（截断到前 50，供 CLI 展示证据） */
  ids: string[];
  ms: number;
}

/** 审计 `reason`：`withdrawn:episode:<id>` / `withdrawn:batch:<id>` / `withdrawn:fact:<id,...>` */
export function withdrawReason(selector: WithdrawSelector, note?: string | null): string {
  const head =
    selector.kind === 'episode'
      ? `withdrawn:episode:${selector.id}`
      : selector.kind === 'batch'
        ? `withdrawn:batch:${selector.id}`
        : `withdrawn:fact:${selector.ids.join(',')}`;
  return note === undefined || note === null || note === '' ? head : `${head}|${note}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 跑一条撤回指令：解析目标 → 逐条无后继收口（写 audit）。
 *
 * `--episode` 会先校验 episode 存在：拼错 id 时静默收口 0 条最危险（看起来"成功"），
 * 直接抛 `E_NOT_FOUND`。`--batch` 没有独立主表（`batch_id` 只是列），无法校验，
 * 命中 0 条即如实报 0；重复执行同一 batch 撤回也因此天然幂等。
 */
export async function withdrawFacts(
  db: Db,
  opts: WithdrawOptions,
): Promise<WithdrawResult> {
  const startedAt = performance.now();
  const dryRun = opts.dryRun ?? false;
  const ratePerSec = opts.ratePerSec ?? WITHDRAW_RATE_PER_SEC;
  const now = opts.now ?? new Date().toISOString();
  const source = opts.byHuman === true ? WITHDRAW_HUMAN_SOURCE : WITHDRAW_SOURCE;
  const reason = withdrawReason(opts.selector, opts.note);

  const res: WithdrawResult = {
    matched: 0,
    withdrawn: 0,
    raced: 0,
    alreadyClosed: 0,
    beforeValidAt: 0,
    notFound: [],
    ids: [],
    ms: 0,
  };

  let targets: Fact[] = [];
  if (opts.selector.kind === 'facts') {
    for (const id of opts.selector.ids) {
      const fact = getFact(db, id);
      if (fact === null) {
        res.notFound.push(id);
        continue;
      }
      if (fact.validTo !== null) {
        res.alreadyClosed += 1;
        continue;
      }
      targets.push(fact);
    }
  } else if (opts.selector.kind === 'episode') {
    if (getEpisode(db, opts.selector.id) === null) {
      throw new MoshiError('E_NOT_FOUND', `episode 不存在：${opts.selector.id}`, {
        episodeId: opts.selector.id,
      });
    }
    targets = listActiveBySource(db, { episodeId: opts.selector.id }, opts.limit ?? 0);
  } else {
    targets = listActiveBySource(db, { batchId: opts.selector.id }, opts.limit ?? 0);
  }

  let writes = 0;
  for (const fact of targets) {
    if (!(now > fact.validAt)) {
      res.beforeValidAt += 1;
      continue;
    }
    res.matched += 1;
    if (res.ids.length < 50) res.ids.push(fact.id);
    if (dryRun) {
      res.withdrawn += 1;
      continue;
    }
    if (ratePerSec > 0 && writes > 0) await delay(Math.ceil(1000 / ratePerSec));
    const done = closeFactWithAudit(db, fact.id, {
      validTo: now,
      status: 'invalidated',
      supersededBy: null,
      source,
      reason,
      ts: now,
      // 墓碑：撤回是人的/规则的明确决定，复检看到它一律维持（recheck 判据第 4 条），
      // 否则一条曾进过历史查询证据包的撤回事实会被 evidence_alive 又捞回来。
      tombstone: { by: source, ts: now, reason },
    });
    if (!done) {
      res.matched -= 1;
      res.raced += 1;
      continue;
    }
    res.withdrawn += 1;
    writes += 1;
  }

  res.ms = Math.round(performance.now() - startedAt);
  return res;
}
