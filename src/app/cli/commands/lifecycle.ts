/**
 * `moshi lifecycle recheck [--dry-run] [--limit N]`（P2② 生命周期缺口）。
 *
 * 复检本身是后台任务的形态（详设 §8.6 的 JOBS 里还缺这一项），调度接线留给
 * daemon；这里先给一个能手动跑一轮的入口：装好/灌库之后、改过判据之后、
 * 或者想在 UI 里核对"到底有多少条该复活"时，不必等下一次 03:00。
 *
 * `--dry-run` 一次写都不发（判定、分布、耗时全部算出来），用来核对判据效果。
 */
import { existsSync } from 'node:fs';
import { recheckExpiredFacts } from '../../../core/lifecycle/recheck.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { dataPaths } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

const USAGE = [
  '用法：moshi lifecycle <子命令> [参数]',
  '',
  '子命令：',
  '  recheck [--dry-run] [--limit N]   对已失效（valid_to 非空）事实做一轮复检',
  '                                    复活 / 维持 / 标记待审，结果写库并留 audit',
  '',
  '参数：',
  '  --dry-run   只统计不写库',
  '  --limit N   最多扫描 N 条（按 id 升序）',
  '',
].join('\n');

interface RecheckArgs {
  dryRun: boolean;
  limit: number;
}

/** 解析失败返回错误文案（与成功返回值区分开） */
function parseRecheckArgs(args: readonly string[]): RecheckArgs | string {
  const parsed: RecheckArgs = { dryRun: false, limit: 0 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg === '--limit' ? args[i + 1] : arg.slice('--limit='.length);
      if (arg === '--limit') i += 1;
      if (raw === undefined || !/^\d+$/.test(raw)) return '--limit 需要一个非负整数';
      parsed.limit = Number(raw);
      continue;
    }
    return `未知参数：${arg}`;
  }
  return parsed;
}

function distribution(counter: Record<string, number>): string {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${String(n)}`)
    .join(' · ');
}

function printRecheck(ctx: CommandContext, res: Awaited<ReturnType<typeof recheckExpiredFacts>>, dryRun: boolean): void {
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

export const lifecycleCommand: Command = {
  name: 'lifecycle',
  summary: '生命周期维护（recheck：已失效事实复活/维持/待审）',
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === undefined || sub === '--help' || sub === '-h') {
      ctx.stdout(USAGE);
      return sub === undefined ? 2 : 0;
    }
    if (sub !== 'recheck') {
      ctx.stderr(`未知子命令：${sub}\n${USAGE}`);
      return 2;
    }

    const parsed = parseRecheckArgs(ctx.args.slice(1));
    if (typeof parsed === 'string') {
      ctx.stderr(`${parsed}\n${USAGE}`);
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
      const res = await recheckExpiredFacts(db, {
        dryRun: parsed.dryRun,
        limit: parsed.limit,
      });
      printRecheck(ctx, res, parsed.dryRun);
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
