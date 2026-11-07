/**
 * `moshi samples build` —— 训练样本构造（详设 §7.4；台账 P3-05）。
 *
 * 把库里两类原料转成 `training_sample`：
 * - `adjudication.outcome` → `label_kind='overturn'`（非循环标签，训 `overturn` 头）
 * - `feedback.verdict`     → `label_kind='rank'`（循环标签，只训 `delta` 头）
 *
 * 幂等：样本 id 由来源行 id 派生，重复跑只补新行。`--since` 用于增量回填，
 * 语义是 `outcome_at`/`ts` **严格晚于**该时间（与详设原 SQL 一致）。
 *
 * 退出码沿用 `db`/`schema` 命令的约定：0 = 成功；1 = 没库/IO 错误；2 = 用法错误。
 */
import { existsSync } from 'node:fs';
import { buildTrainingSamples } from '../../../core/lifecycle/train-samples.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { countSamplesByKind } from '../../../infra/sqlite/trainingSampleRepo.js';
import { dataPaths } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

const USAGE = [
  '用法：moshi samples <子命令>',
  '',
  '子命令：',
  '  build [--since <iso8601>] [--dry-run]   从 adjudication/feedback 构造训练样本',
  '',
  'build 参数：',
  '  --since <iso>   只处理 outcome_at/ts 严格晚于该时间的来源行（增量回填）',
  '  --dry-run       只统计"本会写多少条"，不写库',
  '',
].join('\n');

function takeValue(args: readonly string[], i: number): string | null {
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function runBuild(ctx: CommandContext, rest: readonly string[]): number {
  let since: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--since') {
      const value = takeValue(rest, i);
      if (value === null) {
        ctx.stderr(`--since 需要一个 ISO 时间\n${USAGE}`);
        return 2;
      }
      if (Number.isNaN(Date.parse(value))) {
        ctx.stderr(`--since 不是合法时间：${value}\n${USAGE}`);
        return 2;
      }
      since = value;
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

  const { db } = openDb({ file: paths.db });
  try {
    migrate(db, { backupsDir: paths.backups });
    const result = buildTrainingSamples(db, {
      ...(since === undefined ? {} : { since }),
      ...(dryRun ? { dryRun } : {}),
    });
    const counts = countSamplesByKind(db);
    ctx.stdout(
      `${JSON.stringify(
        {
          since: result.since,
          dry_run: result.dryRun,
          adjudication: result.adjudication,
          feedback: result.feedback,
          created: result.created,
          counts,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } finally {
    closeDb(db);
  }
}

export const samplesCommand: Command = {
  name: 'samples',
  summary: '构造训练样本（adjudication→overturn，feedback→rank）',
  run: async (ctx) => {
    const sub = ctx.args[0];
    if (sub === undefined || sub === '--help' || sub === '-h') {
      ctx.stdout(USAGE);
      return sub === undefined ? 2 : 0;
    }
    if (sub === 'build') return runBuild(ctx, ctx.args.slice(1));
    ctx.stderr(`未知子命令：${sub}\n${USAGE}`);
    return 2;
  },
};
