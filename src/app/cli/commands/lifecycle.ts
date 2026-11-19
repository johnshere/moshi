/**
 * `moshi lifecycle …` —— 生命周期维护的手动入口（P2② 生命周期缺口）。
 *
 * 三条子命令对应详设 §8.6 JOBS 里还缺的三件事（调度接线留给 daemon）：
 *
 * - `recheck`：对已失效事实做一轮复检，复活 / 维持 / 标记待审。
 * - `ttl arm|expire`：给临时类事实设有效期，到期后收口成**无后继失效**。
 * - `withdraw`：某个来源（episode / 直写批次 / 人工指令）明确撤回时，把它支撑的
 *   活跃事实收口成**无后继失效**（不删行、不改 content、必写 audit）。
 *
 * `recheck` 在现网 1003 条失效上复活 0 条——因为全仓没有产出无后继失效的路径；
 * `ttl`/`withdraw` 补的正是这一环，跑完之后 `recheck --dry-run` 才能看到复活数 > 0。
 *
 * 三条命令都支持 `--dry-run`（一次写都不发）与 `--now`（注入判定基准时刻，调试/测试用）。
 */
import { existsSync } from 'node:fs';
import { recheckExpiredFacts } from '../../../core/lifecycle/recheck.js';
import {
  TTL_DEFAULT_SECONDS,
  armTtlForFacts,
  expireDueFacts,
} from '../../../core/lifecycle/ttl.js';
import { withdrawFacts, type WithdrawSelector } from '../../../core/lifecycle/withdraw.js';
import { isTs } from '../../../domain/time.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { dataPaths } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

const USAGE = [
  '用法：moshi lifecycle <子命令> [参数]',
  '',
  '子命令：',
  '  recheck [--dry-run] [--limit N] [--now ISO]',
  '      对已失效（valid_to 非空）事实做一轮复检：复活 / 维持 / 标记待审',
  '',
  '  ttl arm --id <id[,id,...]> [--ttl-seconds N | --days D] [--dry-run] [--now ISO]',
  '      给事实设有效期：写 ttl_seconds + expired_at（只允许 cache/event/session）',
  '  ttl expire [--dry-run] [--limit N] [--now ISO]',
  '      到期扫描：valid_to = 到期时刻、epistemic_status = invalidated，写 audit',
  '',
  '  withdraw (--episode <id> | --batch <id> | --fact <id[,id,...]>)',
  '           [--by human] [--reason TEXT] [--dry-run] [--limit N] [--now ISO]',
  '      来源撤回：把该来源支撑的活跃事实收口为无后继失效（不建 supersedes 边）',
  '',
  '参数：',
  '  --dry-run       只统计不写库',
  '  --limit N       最多处理 N 条（按 id 升序）',
  '  --now ISO       判定基准时刻（调试/测试用，默认当前时刻）',
  '  --ttl-seconds N 有效期时长（秒），与 --days 二选一',
  '  --days D        有效期天数（1 天 = 86400 秒）',
  '  --by human      撤回来源记为人工指令（audit source=human）',
  '  --reason TEXT   撤回依据，写进 audit reason',
  '',
].join('\n');

interface CommonArgs {
  dryRun: boolean;
  limit: number;
  now?: string;
}

/** 取「--flag value」或「--flag=value」的值；`undefined` 表示参数缺值 */
function flagValue(
  args: readonly string[],
  i: number,
  flag: string,
): { value: string | undefined; next: number } | string {
  const arg = args[i] as string;
  if (arg === flag) {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return `${flag} 需要一个值`;
    return { value, next: i + 2 };
  }
  const value = arg.slice(flag.length + 1);
  if (value === '') return `${flag} 需要一个值`;
  return { value, next: i + 1 };
}

/** `--dry-run` / `--limit N` / `--now ISO` 三个通用参数 */
function parseCommon(
  args: readonly string[],
  parsed: CommonArgs,
): { index: number; error?: string } | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const got = flagValue(args, i, '--limit');
      if (typeof got === 'string') return { index: i, error: got };
      if (!/^\d+$/.test(got.value as string)) return { index: i, error: '--limit 需要一个非负整数' };
      parsed.limit = Number(got.value);
      i = got.next - 1;
      continue;
    }
    if (arg === '--now' || arg.startsWith('--now=')) {
      const got = flagValue(args, i, '--now');
      if (typeof got === 'string') return { index: i, error: got };
      if (!isTs(got.value)) return { index: i, error: '--now 需要一个 ISO 时间戳' };
      parsed.now = got.value as string;
      i = got.next - 1;
      continue;
    }
    return { index: i, error: `未知参数：${arg}` };
  }
  return null;
}

/** 解析失败返回错误文案（与成功返回值区分开） */
function parseRecheckArgs(args: readonly string[]): CommonArgs | string {
  const parsed: CommonArgs = { dryRun: false, limit: 0 };
  const bad = parseCommon(args, parsed);
  if (bad !== null) return bad.error as string;
  return parsed;
}

interface TtlArmArgs extends CommonArgs {
  ids: string[];
  ttlSeconds: number;
}

function parseTtlArmArgs(args: readonly string[]): TtlArmArgs | string {
  const parsed: TtlArmArgs = { dryRun: false, limit: 0, ids: [], ttlSeconds: 0 };
  let seconds: number | undefined;
  let days: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--id' || arg.startsWith('--id=')) {
      const got = flagValue(args, i, '--id');
      if (typeof got === 'string') return got;
      const ids = (got.value as string)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (ids.length === 0) return '--id 需要一个事实 id';
      parsed.ids.push(...ids);
      i = got.next - 1;
      continue;
    }
    if (arg === '--ttl-seconds' || arg.startsWith('--ttl-seconds=')) {
      const got = flagValue(args, i, '--ttl-seconds');
      if (typeof got === 'string') return got;
      if (!/^\d+$/.test(got.value as string) || Number(got.value) <= 0) {
        return '--ttl-seconds 需要一个正整数';
      }
      seconds = Number(got.value);
      i = got.next - 1;
      continue;
    }
    if (arg === '--days' || arg.startsWith('--days=')) {
      const got = flagValue(args, i, '--days');
      if (typeof got === 'string') return got;
      if (!/^\d+(\.\d+)?$/.test(got.value as string) || Number(got.value) <= 0) {
        return '--days 需要一个正数';
      }
      days = Number(got.value);
      i = got.next - 1;
      continue;
    }
    rest.push(arg);
  }
  if (seconds !== undefined && days !== undefined) return '--ttl-seconds 与 --days 只能给一个';
  const bad = parseCommon(rest, parsed);
  if (bad !== null) return bad.error as string;
  if (parsed.ids.length === 0) return 'ttl arm 需要一个 --id';
  parsed.ttlSeconds =
    seconds ?? (days === undefined ? TTL_DEFAULT_SECONDS : Math.round(days * 86_400));
  return parsed;
}

interface WithdrawArgs extends CommonArgs {
  selector?: WithdrawSelector;
  byHuman: boolean;
  note?: string;
}

function parseWithdrawArgs(args: readonly string[]): WithdrawArgs | string {
  const parsed: WithdrawArgs = { dryRun: false, limit: 0, byHuman: false };
  const rest: string[] = [];
  let episodeId: string | undefined;
  let batchId: string | undefined;
  const factIds: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--episode' || arg.startsWith('--episode=')) {
      const got = flagValue(args, i, '--episode');
      if (typeof got === 'string') return got;
      episodeId = got.value as string;
      i = got.next - 1;
      continue;
    }
    if (arg === '--batch' || arg.startsWith('--batch=')) {
      const got = flagValue(args, i, '--batch');
      if (typeof got === 'string') return got;
      batchId = got.value as string;
      i = got.next - 1;
      continue;
    }
    if (arg === '--fact' || arg.startsWith('--fact=')) {
      const got = flagValue(args, i, '--fact');
      if (typeof got === 'string') return got;
      const ids = (got.value as string)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (ids.length === 0) return '--fact 需要一个事实 id';
      factIds.push(...ids);
      i = got.next - 1;
      continue;
    }
    if (arg === '--by' || arg.startsWith('--by=')) {
      const got = flagValue(args, i, '--by');
      if (typeof got === 'string') return got;
      if (got.value !== 'human') return '--by 目前只支持 human';
      parsed.byHuman = true;
      i = got.next - 1;
      continue;
    }
    if (arg === '--reason' || arg.startsWith('--reason=')) {
      const got = flagValue(args, i, '--reason');
      if (typeof got === 'string') return got;
      parsed.note = got.value as string;
      i = got.next - 1;
      continue;
    }
    rest.push(arg);
  }
  const kinds = [episodeId !== undefined, batchId !== undefined, factIds.length > 0].filter(
    (x) => x,
  ).length;
  if (kinds === 0) return 'withdraw 需要 --episode / --batch / --fact 之一';
  if (kinds > 1) return '--episode / --batch / --fact 只能给一个';
  if (episodeId !== undefined) parsed.selector = { kind: 'episode', id: episodeId };
  else if (batchId !== undefined) parsed.selector = { kind: 'batch', id: batchId };
  else parsed.selector = { kind: 'facts', ids: factIds };
  const bad = parseCommon(rest, parsed);
  if (bad !== null) return bad.error as string;
  return parsed;
}

function distribution(counter: Record<string, number>): string {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${String(n)}`)
    .join(' · ');
}

function printRecheck(
  ctx: CommandContext,
  res: Awaited<ReturnType<typeof recheckExpiredFacts>>,
  dryRun: boolean,
): void {
  const head = dryRun ? '复检完成（--dry-run，未写库）' : '复检完成';
  ctx.stdout(`${head}：扫描 ${String(res.scanned)} 条已失效事实\n`);
  ctx.stdout(
    `  复活 ${String(res.reactivated)} · 维持 ${String(res.maintained)} · 待审 ${String(res.pendingReview)}` +
      (res.raced > 0 ? `（并发竞态按维持重算 ${String(res.raced)}）` : '') +
      '\n',
  );
  ctx.stdout(`  判据分布：${distribution(res.byReason) || '（无）'}\n`);
  ctx.stdout(`  复检方式：${distribution(res.byRecheckKind) || '（无）'}\n`);
  ctx.stdout(`  用时 ${String(res.ms)}ms\n`);
}

function printArm(
  ctx: CommandContext,
  res: Awaited<ReturnType<typeof armTtlForFacts>>,
  ttlSeconds: number,
  dryRun: boolean,
): void {
  const head = dryRun ? '设期完成（--dry-run，未写库）' : '设期完成';
  ctx.stdout(`${head}：有效期 ${String(ttlSeconds)}s，设期 ${String(res.armed)} 条事实\n`);
  if (res.alreadyArmed > 0) ctx.stdout(`  已设期跳过 ${String(res.alreadyArmed)} 条（幂等）\n`);
  if (res.closed > 0) ctx.stdout(`  已失效跳过 ${String(res.closed)} 条\n`);
  if (res.skippedRetention > 0) {
    ctx.stdout(`  保留类不允许跳过 ${String(res.skippedRetention)} 条：${distribution(res.byRetention)}\n`);
  }
  if (res.notFound.length > 0) ctx.stdout(`  不存在 ${String(res.notFound.length)} 条：${res.notFound.join(',')}\n`);
  ctx.stdout(`  用时 ${String(res.ms)}ms\n`);
}

function printExpire(
  ctx: CommandContext,
  res: Awaited<ReturnType<typeof expireDueFacts>>,
  dryRun: boolean,
): void {
  const head = dryRun ? '到期扫描完成（--dry-run，未写库）' : '到期扫描完成';
  ctx.stdout(`${head}：扫描 ${String(res.scanned)} 条到期事实\n`);
  ctx.stdout(
    `  收口 ${String(res.closed)} 条（无后继失效）` +
      (res.raced > 0 ? `，并发竞态按跳过重算 ${String(res.raced)} 条` : '') +
      '\n',
  );
  if (res.beforeValidAt > 0) ctx.stdout(`  到期早于生效无法收口 ${String(res.beforeValidAt)} 条\n`);
  ctx.stdout(`  保留类分布：${distribution(res.byRetention) || '（无）'}\n`);
  ctx.stdout(`  用时 ${String(res.ms)}ms\n`);
}

function printWithdraw(
  ctx: CommandContext,
  res: Awaited<ReturnType<typeof withdrawFacts>>,
  dryRun: boolean,
): void {
  const head = dryRun ? '撤回完成（--dry-run，未写库）' : '撤回完成';
  ctx.stdout(
    `${head}：命中 ${String(res.matched)} 条活跃事实，收口 ${String(res.withdrawn)} 条（无后继失效）\n`,
  );
  if (res.alreadyClosed > 0) ctx.stdout(`  已失效跳过 ${String(res.alreadyClosed)} 条（幂等）\n`);
  if (res.raced > 0) ctx.stdout(`  并发竞态按跳过重算 ${String(res.raced)} 条\n`);
  if (res.beforeValidAt > 0) ctx.stdout(`  撤回时刻早于生效无法收口 ${String(res.beforeValidAt)} 条\n`);
  if (res.notFound.length > 0) ctx.stdout(`  不存在 ${String(res.notFound.length)} 条：${res.notFound.join(',')}\n`);
  if (res.ids.length > 0) ctx.stdout(`  事实：${res.ids.join(',')}\n`);
  ctx.stdout(`  用时 ${String(res.ms)}ms\n`);
}

/** 解析阶段的产出：先定计划，再开库——参数错误不碰数据库（也不会触发迁移） */
type Plan =
  | { kind: 'recheck'; a: CommonArgs }
  | { kind: 'ttl_arm'; a: TtlArmArgs }
  | { kind: 'ttl_expire'; a: CommonArgs }
  | { kind: 'withdraw'; a: WithdrawArgs };

function parsePlan(args: readonly string[]): Plan | string {
  const sub = args[0];
  if (sub === 'recheck') {
    const a = parseRecheckArgs(args.slice(1));
    return typeof a === 'string' ? a : { kind: 'recheck', a };
  }
  if (sub === 'ttl') {
    const action = args[1];
    if (action === 'arm') {
      const a = parseTtlArmArgs(args.slice(2));
      return typeof a === 'string' ? a : { kind: 'ttl_arm', a };
    }
    if (action === 'expire') {
      const a = parseRecheckArgs(args.slice(2));
      return typeof a === 'string' ? a : { kind: 'ttl_expire', a };
    }
    return `未知 ttl 动作：${action ?? '（缺）'}`;
  }
  if (sub === 'withdraw') {
    const a = parseWithdrawArgs(args.slice(1));
    if (typeof a === 'string') return a;
    return { kind: 'withdraw', a };
  }
  return `未知子命令：${String(sub)}`;
}

export const lifecycleCommand: Command = {
  name: 'lifecycle',
  summary: '生命周期维护（recheck / ttl / withdraw：无后继失效的产出与复活）',
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === undefined || sub === '--help' || sub === '-h') {
      ctx.stdout(USAGE);
      return sub === undefined ? 2 : 0;
    }

    const plan = parsePlan(ctx.args);
    if (typeof plan === 'string') {
      ctx.stderr(`${plan}\n${USAGE}`);
      return 2;
    }

    const paths = dataPaths(ctx.cfg);
    if (!existsSync(paths.db)) {
      ctx.stderr(`尚未观测到数据库：${paths.db}\n`);
      return 1;
    }

    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });

      if (plan.kind === 'recheck') {
        const res = await recheckExpiredFacts(db, {
          dryRun: plan.a.dryRun,
          limit: plan.a.limit,
          ...(plan.a.now === undefined ? {} : { now: plan.a.now }),
        });
        printRecheck(ctx, res, plan.a.dryRun);
        return 0;
      }

      if (plan.kind === 'ttl_arm') {
        const res = armTtlForFacts(db, {
          ids: plan.a.ids,
          ttlSeconds: plan.a.ttlSeconds,
          dryRun: plan.a.dryRun,
          ...(plan.a.now === undefined ? {} : { now: plan.a.now }),
        });
        printArm(ctx, res, plan.a.ttlSeconds, plan.a.dryRun);
        return res.notFound.length > 0 || res.skippedRetention > 0 ? 1 : 0;
      }

      if (plan.kind === 'ttl_expire') {
        const res = await expireDueFacts(db, {
          dryRun: plan.a.dryRun,
          limit: plan.a.limit,
          ...(plan.a.now === undefined ? {} : { now: plan.a.now }),
        });
        printExpire(ctx, res, plan.a.dryRun);
        return 0;
      }

      const res = await withdrawFacts(db, {
        selector: plan.a.selector as WithdrawSelector,
        byHuman: plan.a.byHuman,
        limit: plan.a.limit,
        dryRun: plan.a.dryRun,
        ...(plan.a.note === undefined ? {} : { note: plan.a.note }),
        ...(plan.a.now === undefined ? {} : { now: plan.a.now }),
      });
      printWithdraw(ctx, res, plan.a.dryRun);
      return res.notFound.length > 0 ? 1 : 0;
    } finally {
      closeDb(db);
    }
  },
};
