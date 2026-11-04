/**
 * `moshi db <子命令>` —— 库维护入口（P2-08 强度重算、P2-09 巩固、P2-19A 备份/迁移/重建）。
 *
 * `rebuild-strength`：惰性衰减只在「查询返回前 / 写入后」各算一次，它保证的是
 * **不跑定时任务也不出错**，但不保证「没人查的老事实」的强度是最新的。从备份恢复、
 * 进程停机几个月、改过时间参数之后，得有一个能把全表拉齐的入口。语义是**幂等重算**
 * 而不是「再衰减一次」：每条按自己的 `last_decay_at` 算到 `now`，所以连跑两次，
 * 第二次 `changed` 必为 0。只写变化行（Δ > 1e-3）。
 *
 * `consolidate`：手动跑一轮情景→语义巩固与过程提炼（平时由 harvest runner 收尾自动跑）。
 * 幂等键是源 id 集合指纹或活跃过程身份，所以连跑两次 `created` 必为 0。
 *
 * `backup`：把当前库备份到 `<data_dir>/backups/moshi-<stamp>.db`，按 `--keep`（默认
 * `storage.backup_keep`）裁掉旧备份。命名与裁剪口径与调度器的 backup job 一致；
 * 真正的拷贝走 better-sqlite3 的 `db.backup()`（不重写 SQLite 备份逻辑）。
 *
 * `vacuum`：`VACUUM` + WAL 截断，打印前后 `size_mb` / `wal_mb`。
 * `migrate [--dry-run]`：显式把库迁到 `TARGET_VERSION`；`--dry-run` 只列待执行文件。
 * `rebuild-degree`：按活跃边重算 `fact.degree`，打印重建行数与 `degree_mismatch` 前后值。
 *
 * 老两个子命令都支持 `--dry-run`（一次写都不发）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runCommunityOnce } from '../../communityRunner.js';
import {
  consolidate,
  CONSOLIDATE_RATE_PER_SEC,
  extractProcedures,
} from '../../../core/lifecycle/consolidate.js';
import { applyStrength } from '../../../core/lifecycle/strength.js';
import { MoshiError } from '../../../domain/errors.js';
import { safeEnsureDir, safeRemoveFile } from '../../../infra/fs/safeWrite.js';
import { closeDb, openDb, type Db } from '../../../infra/sqlite/db.js';
import { readDbInfo } from '../../../infra/sqlite/diagRepo.js';
import {
  decayFacts,
  listFactsPage,
  STRENGTH_WRITE_EPS,
} from '../../../infra/sqlite/factRepo.js';
import { rebuildDegree, vacuum } from '../../../infra/sqlite/maintenance.js';
import {
  checkpointWal,
  currentUserVersion,
  defaultMigrationsDir,
  listMigrations,
  migrate,
  TARGET_VERSION,
} from '../../../infra/sqlite/migrate.js';
import { degreeMismatches } from '../../../infra/sqlite/views.js';
import { dataPaths } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

/** 每批行数（详设 §8.1：「最后按 200 行一批写回」） */
const BATCH = 200;

const USAGE = [
  '用法：moshi db <子命令> [参数]',
  '',
  '子命令：',
  '  rebuild-strength [--dry-run]               按当前时刻惰性衰减全表重算强度（幂等；只写有变化的行）',
  '  consolidate [--dry-run] [--rate <n>]       归纳同 key episodic 要点，并提炼同 cwd 重复工具过程',
  '  community [--dry-run]                      全图 Louvain 重算社区划分（Jaccard≥0.5 继承旧 id）',
  '  backup [--keep <n>]                        备份当前库到 backups/，并裁掉超过 keep 份的旧备份',
  '  vacuum                                     回收空闲页并截断 WAL（打印前后大小）',
  '  migrate [--dry-run]                        迁移到本程序支持的版本（--dry-run 只列待执行文件）',
  '  rebuild-degree                             按活跃边重算 fact.degree（打印修正行数与对账差值）',
  '',
  '公共参数：',
  '  --dry-run  只统计不写库',
  '',
  'consolidate 专属参数：',
  `  --rate n   每秒最多处理多少组（默认 ${CONSOLIDATE_RATE_PER_SEC}；0 = 不限速）`,
  '',
  'backup 专属参数：',
  '  --keep n   保留最近 n 份备份（默认 storage.backup_keep）',
  '',
  '--help    显示本帮助',
  '',
].join('\n');

const SUBCOMMANDS = [
  'rebuild-strength',
  'consolidate',
  'community',
  'backup',
  'vacuum',
  'migrate',
  'rebuild-degree',
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

interface ParsedArgs {
  dryRun: boolean;
  rate: number | null;
  keep: number | null;
  help: boolean;
}

/** 支持 `--dry-run` 的子命令（vacuum/backup/rebuild-degree 本身就是动作，不接受空跑） */
const DRY_RUN_SUBS: readonly Subcommand[] = [
  'rebuild-strength',
  'consolidate',
  'community',
  'migrate',
];

/** 参数校验收口：非法参数一律退出码 2（与既有子命令一致） */
function parseArgs(
  sub: Subcommand,
  rest: readonly string[],
  ctx: CommandContext,
): ParsedArgs | null {
  const out: ParsedArgs = { dryRun: false, rate: null, keep: null, help: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--dry-run' && DRY_RUN_SUBS.includes(sub)) {
      out.dryRun = true;
      continue;
    }
    if (arg === '--rate' && sub === 'consolidate') {
      const raw = rest[i + 1];
      const n = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        ctx.stderr(`--rate 需要非负整数\n${USAGE}`);
        return null;
      }
      out.rate = n;
      i += 1;
      continue;
    }
    if (arg === '--keep' && sub === 'backup') {
      const raw = rest[i + 1];
      const n = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        ctx.stderr(`--keep 需要正整数\n${USAGE}`);
        return null;
      }
      out.keep = n;
      i += 1;
      continue;
    }
    ctx.stderr(`未知参数：${arg}\n${USAGE}`);
    return null;
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 与调度器 backup job 同一命名口径：`moshi-YYYY-MM-DD-HHMMSS.db` */
function backupStamp(at: Date): string {
  return [
    at.getFullYear(),
    pad2(at.getMonth() + 1),
    pad2(at.getDate()),
  ].join('-') + `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
}

/** 同一秒跑两次 backup 时不覆盖前一份：追加 -2/-3 */
function uniqueBackupPath(dir: string, stamp: string): string {
  let file = path.join(dir, `moshi-${stamp}.db`);
  let seq = 2;
  while (existsSync(file)) {
    file = path.join(dir, `moshi-${stamp}-${seq}.db`);
    seq += 1;
  }
  return file;
}

/** 按 mtime 保留最近 keep 份 `.db`（与 scheduler.pruneBackups 同口径） */
function pruneBackups(backupsDir: string, keep: number, roots: readonly string[]): number {
  const files = readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, mtime: statSync(path.join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const stale of files.slice(Math.max(1, keep))) {
    safeRemoveFile(path.join(backupsDir, stale.f), roots);
    removed += 1;
  }
  return removed;
}

function formatMb(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} MB`;
}

interface BackupReport {
  path: string;
  files: number;
  sizeMb: number;
  removed: number;
  keep: number;
}

async function runBackup(db: Db, keep: number, paths: ReturnType<typeof dataPaths>): Promise<BackupReport> {
  const roots = [paths.backups, paths.root];
  safeEnsureDir(paths.backups, roots);
  const file = uniqueBackupPath(paths.backups, backupStamp(new Date()));
  await db.backup(file);
  const removed = pruneBackups(paths.backups, keep, roots);
  const sizeMb = statSync(file).size / (1024 * 1024);
  return { path: file, files: 1, sizeMb, removed, keep };
}

interface MigrateReport {
  from: number;
  to: number;
  pending: { version: number; file: string }[];
  applied: string[];
  backupPath: string | null;
  latest: boolean;
}

function runMigrate(
  db: Db,
  paths: ReturnType<typeof dataPaths>,
  dryRun: boolean,
): MigrateReport {
  const from = currentUserVersion(db);
  if (from > TARGET_VERSION) {
    throw new MoshiError(
      'E_CONFIG',
      `数据库版本 ${from} 高于本程序支持的 ${TARGET_VERSION}：不允许降级（概设 §2.3）`,
      { from, target: TARGET_VERSION },
    );
  }
  const pending = listMigrations(defaultMigrationsDir()).filter(
    (f) => f.version > from && f.version <= TARGET_VERSION,
  );
  if (from === TARGET_VERSION) {
    return {
      from,
      to: from,
      pending: [],
      applied: [],
      backupPath: null,
      latest: true,
    };
  }
  if (dryRun) {
    return {
      from,
      to: TARGET_VERSION,
      pending,
      applied: [],
      backupPath: null,
      latest: false,
    };
  }
  const res = migrate(db, { backupsDir: paths.backups, target: TARGET_VERSION });
  return {
    from: res.from,
    to: res.to,
    pending,
    applied: res.applied,
    backupPath: res.backupPath,
    latest: false,
  };
}

function printMigrate(ctx: CommandContext, report: MigrateReport, dryRun: boolean): void {
  if (report.latest) {
    ctx.stdout(`已是最新 (v${report.from})\n`);
    return;
  }
  if (dryRun) {
    ctx.stdout(`待执行 ${report.pending.length} 个迁移（v${report.from} → v${report.to}）：\n`);
    for (const item of report.pending) {
      ctx.stdout(`  ${path.basename(item.file)}\n`);
    }
    ctx.stdout('--dry-run：未写库\n');
    return;
  }
  ctx.stdout(`迁移完成：v${report.from} → v${report.to}（${report.applied.length} 个文件）\n`);
  for (const file of report.applied) ctx.stdout(`  ${file}\n`);
  if (report.backupPath !== null) ctx.stdout(`迁移前备份：${report.backupPath}\n`);
}

function printVacuum(ctx: CommandContext, before: ReturnType<typeof readDbInfo>, after: ReturnType<typeof readDbInfo>): void {
  ctx.stdout(
    `DB ${formatMb(before.size_mb)} → ${formatMb(after.size_mb)}（WAL ${formatMb(before.wal_mb)} → ${formatMb(after.wal_mb)}）\n`,
  );
}

function runRebuildDegree(db: Db): { rows: number; before: number; after: number } {
  const before = degreeMismatches(db).length;
  const rows = rebuildDegree(db);
  const after = degreeMismatches(db).length;
  return { rows, before, after };
}

export const dbCommand: Command = {
  name: 'db',
  summary: '库维护（db rebuild-strength | consolidate | community | backup | vacuum | migrate | rebuild-degree）',
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === '--help' || sub === '-h' || sub === 'help') {
      ctx.stdout(USAGE);
      return 0;
    }
    if (sub === undefined) {
      ctx.stderr(`缺少子命令\n${USAGE}`);
      return 2;
    }
    if (!isSubcommand(sub)) {
      ctx.stderr(`未知子命令：${sub}\n${USAGE}`);
      return 2;
    }

    const parsed = parseArgs(sub, ctx.args.slice(1), ctx);
    if (parsed === null) return 2;
    if (parsed.help) {
      ctx.stdout(USAGE);
      return 0;
    }

    const paths = dataPaths(ctx.cfg);
    if (!existsSync(paths.db)) {
      ctx.stderr(`尚未观测到数据库：${paths.db}\n`);
      return 1;
    }

    const now = Date.now();
    const { db } = openDb({ file: paths.db });
    try {
      // migrate 子命令必须自己看版本（不能被「先自动迁移」抹掉待执行列表）
      if (sub === 'migrate') {
        try {
          const report = runMigrate(db, paths, parsed.dryRun);
          printMigrate(ctx, report, parsed.dryRun);
          return 0;
        } catch (err) {
          if (err instanceof MoshiError) {
            ctx.stderr(`${err.message}\n`);
            return 1;
          }
          throw err;
        }
      }

      migrate(db, { backupsDir: paths.backups });

      if (sub === 'backup') {
        const keep = parsed.keep ?? ctx.cfg.storage.backup_keep;
        const report = await runBackup(db, keep, paths);
        ctx.stdout(
          `备份 -> ${report.path} (${report.files} 个文件, ${formatMb(report.sizeMb)})\n`,
        );
        if (report.removed > 0) {
          ctx.stdout(`已清理 ${report.removed} 个旧备份（保留 ${report.keep} 个）\n`);
        }
        return 0;
      }

      if (sub === 'vacuum') {
        const before = readDbInfo(db);
        vacuum(db);
        checkpointWal(db);
        printVacuum(ctx, before, readDbInfo(db));
        return 0;
      }

      if (sub === 'rebuild-degree') {
        const report = runRebuildDegree(db);
        ctx.stdout(
          `degree 重建完成：${report.rows} 行；degree_mismatch ${report.before} → ${report.after}\n`,
        );
        return 0;
      }

      if (sub === 'consolidate') {
        const options = {
          dryRun: parsed.dryRun,
          maxContentBytes: ctx.cfg.ingest.max_fact_bytes,
          ...(parsed.rate === null ? {} : { ratePerSec: parsed.rate }),
        };
        const res = await consolidate(db, options);
        const procedures = await extractProcedures(db, options);
        ctx.stdout(
          `${JSON.stringify({ command: 'db consolidate', ...res, procedures, dry_run: parsed.dryRun })}\n`,
        );
        return 0;
      }

      if (sub === 'community') {
        const res = runCommunityOnce(db, { dryRun: parsed.dryRun });
        ctx.stdout(`${JSON.stringify({ command: 'db community', ...res, dry_run: parsed.dryRun })}\n`);
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
        if (parsed.dryRun) {
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
          dry_run: parsed.dryRun,
        })}\n`,
      );
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
