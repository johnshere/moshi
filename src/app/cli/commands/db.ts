/**
 * `moshi db <子命令>` —— 库维护入口（P2-08 强度重算、P2-09 巩固）。
 *
 * `rebuild-strength`：惰性衰减只在「查询返回前 / 写入后」各算一次，它保证的是
 * **不跑定时任务也不出错**，但不保证「没人查的老事实」的强度是最新的。从备份恢复、
 * 进程停机几个月、改过时间参数之后，得有一个能把全表拉齐的入口。语义是**幂等重算**
 * 而不是「再衰减一次」：每条按自己的 `last_decay_at` 算到 `now`，所以连跑两次，
 * 第二次 `changed` 必为 0。只写变化行（Δ > 1e-3）。
 *
 * `consolidate`：手动跑一轮情景→语义巩固（平时由 harvest runner 收尾自动跑）。
 * 幂等键是源 id 集合指纹，所以连跑两次 `created` 必为 0。
 *
 * 两个子命令都支持 `--dry-run`（一次写都不发）。
 */
import { existsSync } from 'node:fs';
import {
  consolidate,
  CONSOLIDATE_RATE_PER_SEC,
} from '../../../core/lifecycle/consolidate.js';
import { applyStrength } from '../../../core/lifecycle/strength.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import {
  decayFacts,
  listFactsPage,
  STRENGTH_WRITE_EPS,
} from '../../../infra/sqlite/factRepo.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { dataPaths } from '../../config.js';
import type { Command } from '../types.js';

/** 每批行数（详设 §8.1：「最后按 200 行一批写回」） */
const BATCH = 200;

const USAGE = [
  '用法：moshi db <子命令>',
  '',
  '子命令：',
  '  rebuild-strength [--dry-run]               按当前时刻惰性衰减全表重算强度（幂等；只写有变化的行）',
  '  consolidate [--dry-run] [--rate <n>]       把同 key ≥3 条 episodic 归纳成 1 条 semantic 要点',
  '',
  '公共参数：',
  '  --dry-run  只统计不写库',
  '',
  'consolidate 专属参数：',
  `  --rate n   每秒最多处理多少组（默认 ${CONSOLIDATE_RATE_PER_SEC}；0 = 不限速）`,
  '',
].join('\n');

const SUBCOMMANDS = ['rebuild-strength', 'consolidate'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

export const dbCommand: Command = {
  name: 'db',
  summary: '库维护（db rebuild-strength | db consolidate 均支持 --dry-run）',
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === undefined) {
      ctx.stderr(`缺少子命令\n${USAGE}`);
      return 2;
    }
    if (!isSubcommand(sub)) {
      ctx.stderr(`未知子命令：${sub}\n${USAGE}`);
      return 2;
    }

    const rest = ctx.args.slice(1);
    let dryRun = false;
    let rate: number | null = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] as string;
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '--rate' && sub === 'consolidate') {
        const raw = rest[i + 1];
        const n = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          ctx.stderr(`--rate 需要非负整数\n${USAGE}`);
          return 2;
        }
        rate = n;
        i += 1;
        continue;
      }
      ctx.stderr(`未知参数：${arg}\n${USAGE}`);
      return 2;
    }

    const paths = dataPaths(ctx.cfg);
    if (!existsSync(paths.db)) {
      ctx.stderr(`尚未观测到数据库：${paths.db}\n`);
      return 1;
    }

    const now = Date.now();
    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });

      if (sub === 'consolidate') {
        const res = await consolidate(db, {
          dryRun,
          ...(rate === null ? {} : { ratePerSec: rate }),
        });
        ctx.stdout(`${JSON.stringify({ command: 'db consolidate', ...res, dry_run: dryRun })}\n`);
        return 0;
      }

      let scanned = 0;
      let changed = 0;
      let after = 0;
      for (;;) {
        const page = listFactsPage(db, after, BATCH);
        const last = page[page.length - 1];
        if (last === undefined) break;
        after = last.rowid;
        scanned += page.length;

        const facts = page.map((p) => p.fact);
        if (dryRun) {
          for (const f of facts) {
            if (Math.abs(applyStrength(f, { kind: 'none' }, now) - f.strength) > STRENGTH_WRITE_EPS) {
              changed += 1;
            }
          }
        } else {
          const before = new Map(facts.map((f) => [f.id, f.strength]));
          for (const f of decayFacts(db, facts, now)) {
            if (Math.abs(f.strength - (before.get(f.id) ?? f.strength)) > STRENGTH_WRITE_EPS) {
              changed += 1;
            }
          }
        }
      }

      ctx.stdout(
        `${JSON.stringify({
          command: 'db rebuild-strength',
          scanned,
          changed,
          dry_run: dryRun,
        })}\n`,
      );
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
