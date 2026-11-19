/**
 * `moshi samples` —— 训练样本构造与导出（详设 §7.4；台账 P3-05 / P3-06）。
 *
 * - `build`：把库里两类原料转成 `training_sample`
 *   - `adjudication.outcome` → `label_kind='overturn'`（非循环标签，训 `overturn` 头）
 *   - `feedback.verdict`     → `label_kind='rank'`（循环标签，只训 `delta` 头）
 *   幂等：样本 id 由来源行 id 派生，重复跑只补新行。`--since` 语义是
 *   `outcome_at`/`ts` **严格晚于**该时间（与详设原 SQL 一致）。
 * - `export`：把样本展开成 `moshi-subgraph/2` payload 的 JSONL，供
 *   `sidecar/train.py` 训练。子图与边特征只在 TS 侧算（D-153）。
 *
 * 退出码沿用 `db`/`schema` 命令的约定：0 = 成功；1 = 没库/IO 错误；2 = 用法错误。
 */
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildTrainingSamples } from '../../../core/lifecycle/train-samples.js';
import { exportTrainingPayloads } from '../../../core/lifecycle/train-export.js';
import type { SamplePayloadRecord } from '../../../core/lifecycle/train-export.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { countSamplesByKind } from '../../../infra/sqlite/trainingSampleRepo.js';
import { safeCreateWriteStream, safeRemoveFile } from '../../../infra/fs/safeWrite.js';
import { SidecarClient } from '../../../infra/sidecar/client.js';
import { dataPaths } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

const USAGE = [
  '用法：moshi samples <子命令>',
  '',
  '子命令：',
  '  build  [--since <iso8601>] [--dry-run]            从 adjudication/feedback 构造训练样本',
  '  export [--out <file>] [--since <iso>] [--limit N] [--no-query-vectors]',
  '                                                    导出 moshi-subgraph/2 JSONL 供训练',
  '',
  'build 参数：',
  '  --since <iso>   只处理 outcome_at/ts 严格晚于该时间的来源行（增量回填）',
  '  --dry-run       只统计"本会写多少条"，不写库',
  '',
  'export 参数：',
  '  --out <file>    输出路径；默认 <data_dir>/train/samples.jsonl',
  '  --since <iso>   只导出 created_at 晚于该时间的样本',
  '  --limit N       最多导出 N 条（调试用）',
  '  --no-query-vectors  不用 sidecar 编码 query_text，query_vector 全为 null',
  '',
].join('\n');

function takeValue(args: readonly string[], i: number): string | null {
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function writeRoots(ctx: CommandContext): readonly string[] {
  return [ctx.cfg.storage.data_dir, ctx.cfg.storage.archive_dir, ctx.home];
}

/**
 * JSONL 逐条流式落盘。
 *
 * 不能在内存里拼整串：一条 64 节点的子图约 0.4 MB，几百条就超过 V8 的字符串上限
 * （实测 923 条报 `Invalid string length`，文件一条都没写出来）。逐条写 + 背压即可。
 */
async function writeJsonl(
  file: string,
  records: readonly SamplePayloadRecord[],
  roots: readonly string[],
): Promise<void> {
  const stream = safeCreateWriteStream(file, roots, 'w');
  try {
    for (const record of records) {
      if (!stream.write(`${JSON.stringify(record)}\n`)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
  } catch (err) {
    stream.destroy();
    safeRemoveFile(file, roots);
    throw err;
  }
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

async function runExport(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  let out: string | undefined;
  let since: string | undefined;
  let limit: number | undefined;
  let useQueryVectors = true;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === '--no-query-vectors') {
      useQueryVectors = false;
      continue;
    }
    if (arg === '--out' || arg === '--since' || arg === '--limit') {
      const value = takeValue(rest, i);
      if (value === null) {
        ctx.stderr(`${arg} 需要一个值\n${USAGE}`);
        return 2;
      }
      i += 1;
      if (arg === '--out') {
        out = value;
      } else if (arg === '--since') {
        if (Number.isNaN(Date.parse(value))) {
          ctx.stderr(`--since 不是合法时间：${value}\n${USAGE}`);
          return 2;
        }
        since = value;
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          ctx.stderr(`--limit 必须是正整数：${value}\n${USAGE}`);
          return 2;
        }
        limit = n;
      }
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
  const outFile = out ?? path.join(path.dirname(paths.db), 'train', 'samples.jsonl');

  const { db } = openDb({ file: paths.db });
  let sidecar: SidecarClient | undefined;
  try {
    migrate(db, { backupsDir: paths.backups });

    // query_vector 不是必需：sidecar 起不来就降级为 null（模型会跳过交叉注意力），
    // 但要明确告诉用户这次导出的向量覆盖率是 0，而不是静默产出半份数据。
    let encode: ((texts: string[]) => Promise<number[][] | null>) | undefined;
    if (useQueryVectors) {
      const silent = { info: () => {}, warn: () => {}, error: () => {} };
      sidecar = new SidecarClient({ cfg: ctx.cfg, logger: silent });
      try {
        await sidecar.ensureStarted();
        const client = sidecar;
        encode = (texts) => client.encode(texts);
      } catch (e) {
        ctx.stderr(`sidecar 不可用，query_vector 将全为 null：${e instanceof Error ? e.message : String(e)}\n`);
        sidecar = undefined;
      }
    }

    const result = await exportTrainingPayloads(db, {
      ...(since === undefined ? {} : { since }),
      ...(limit === undefined ? {} : { limit }),
      ...(encode === undefined ? {} : { queryVectors: encode }),
    });

    await writeJsonl(outFile, result.records, writeRoots(ctx));
    ctx.stdout(
      `${JSON.stringify(
        {
          out: outFile,
          ...result.stats,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (e) {
    ctx.stderr(`导出失败：${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    if (sidecar !== undefined) await sidecar.terminate().catch(() => {});
    closeDb(db);
  }
}

export const samplesCommand: Command = {
  name: 'samples',
  summary: '构造/导出训练样本（adjudication→overturn，feedback→rank）',
  run: async (ctx) => {
    const sub = ctx.args[0];
    if (sub === undefined || sub === '--help' || sub === '-h') {
      ctx.stdout(USAGE);
      return sub === undefined ? 2 : 0;
    }
    if (sub === 'build') return runBuild(ctx, ctx.args.slice(1));
    if (sub === 'export') return runExport(ctx, ctx.args.slice(1));
    ctx.stderr(`未知子命令：${sub}\n${USAGE}`);
    return 2;
  },
};
