/**
 * `moshi db rebuild-strength [--dry-run]`（P2-08 / 详设 §8.1 末段）。
 *
 * 为什么要这个命令：惰性衰减只在「查询返回前 / 写入后」各算一次，
 * 它保证的是**不跑定时任务也不出错**，但不保证「没人查的老事实」的强度是最新的。
 * 从备份恢复、进程停机几个月、改过时间参数之后，得有一个能把全表拉齐的入口。
 *
 * 语义是**幂等重算**而不是「再衰减一次」：每条按自己的 `last_decay_at` 算到 `now`，
 * 所以连跑两次，第二次 `changed` 必为 0。只写变化行（Δ > 1e-3），
 * `--dry-run` 连一次 UPDATE 都不发。
 */
import { existsSync } from 'node:fs';
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
  '  rebuild-strength [--dry-run]  按当前时刻惰性衰减全表重算强度（幂等；只写有变化的行）',
  '                                --dry-run  只统计不写库',
  '',
].join('\n');

export const dbCommand: Command = {
  name: 'db',
  summary: '库维护（db rebuild-strength [--dry-run]）',
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === undefined) {
      ctx.stderr(`缺少子命令\n${USAGE}`);
      return 2;
    }
    if (sub !== 'rebuild-strength') {
      ctx.stderr(`未知子命令：${sub}\n${USAGE}`);
      return 2;
    }

    const rest = ctx.args.slice(1);
    const unknown = rest.filter((a) => a !== '--dry-run');
    if (unknown.length > 0) {
      ctx.stderr(`未知参数：${unknown.join(' ')}\n${USAGE}`);
      return 2;
    }
    const dryRun = rest.includes('--dry-run');

    const paths = dataPaths(ctx.cfg);
    if (!existsSync(paths.db)) {
      ctx.stderr(`尚未观测到数据库：${paths.db}\n`);
      return 1;
    }

    const now = Date.now();
    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });

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
