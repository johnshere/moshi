/**
 * `moshi schema <子命令>` —— schema 校验与晋升 diff（详设 §2.6 / §8.5；台账 P2-14）。
 *
 * - `infer`：统计谓词基数性并写回 ontology（详设 §8.5 判定表），同时输出
 *   「待晋升清单」：本次只到 observe 的谓词（样本不足）与 ontology 里 promoted=0 的
 *   线索，供 `/ui/diagnostics` 与人工晋升使用。P2-19-A 项 3 补齐（此前只有后台
 *   `schemaInferRunner` 会跑，用户无法手动触发）。
 * - `validate`：扫全库 fact 的 attrs，对照 `ontology` 里已登记（promoted=1）的
 *   predicate / attr_key 定义，报告违反项与未登记键（待晋升清单）。只读，不写库。
 *   `--snapshot <file>` 顺手把「当前已登记 schema」导出成快照，供晋升后 diff 用。
 * - `diff`：读两个 schema 快照（晋升前 / 晋升后），输出差异清单与迁移脚本**草稿**。
 *   `--to` 省略时用当前库的已登记 schema 当「晋升后」。`--out <file>` 把脚本草稿
 *   落盘（走白名单写盘）；不执行任何 DDL。
 *
 * 退出码沿用 `db` 命令的约定：0 = 通过 / 无差异；1 = 校验有违反项或 IO 错误；
 * 2 = 用法错误。
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildSchemaSnapshot,
  diffSchemaSnapshots,
  parseSchemaSnapshot,
  renderSchemaMigration,
  validateAttrs,
  type SchemaSnapshot,
  type SchemaSnapshotEntry,
} from '../../../core/lifecycle/schema-validate.js';
import { nowIso } from '../../../domain/time.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { listFactsPage } from '../../../infra/sqlite/factRepo.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { listOntologyKeys, loadRegisteredKeys } from '../../../infra/sqlite/ontologyRepo.js';
import { runSchemaInfer } from '../../../core/lifecycle/schema-infer.js';
import { safeWriteFile } from '../../../infra/fs/safeWrite.js';
import { dataPaths } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

/** 每批扫描行数（与 db 命令一致） */
const BATCH = 200;
/** 报告里最多列多少条违反项（库里积压很多时避免刷屏） */
const MAX_REPORTED_VIOLATIONS = 50;

const USAGE = [
  '用法：moshi schema <子命令>',
  '',
  '子命令：',
  '  infer [--dry-run]                                 推断谓词基数性并写回 ontology，打印待晋升清单',
  '  validate [--snapshot <file>]                       校验全库 attrs 是否符合已登记 schema',
  '  diff --from <file> [--to <file>] [--out <file>]    对比晋升前后 schema 快照，输出迁移脚本草稿',
  '',
  'infer 参数：',
  '  --dry-run         只判定不写库（updated=0，planned 给出本会写回的条数）',
  '  --write           显式写回（默认行为，脚本自述用）',
  '',
  'validate 参数：',
  '  --snapshot file   把当前已登记 schema 导出为快照 JSON（晋升前先跑一次）',
  '',
  'diff 参数：',
  '  --from file       晋升前快照（必填，由 validate --snapshot 生成）',
  '  --to file         晋升后快照；省略则用当前库的已登记 schema',
  '  --out file        迁移脚本草稿落盘位置；省略则随 JSON 输出到 stdout',
  '',
].join('\n');

const SUBCOMMANDS = ['infer', 'validate', 'diff'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

/** `--flag value` 形式的公共解析：取下一个非 flag 参数；缺失返回 null */
function takeValue(args: readonly string[], i: number): string | null {
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function snapshotFromDb(db: Parameters<typeof loadRegisteredKeys>[0], generatedAt: string): SchemaSnapshot {
  const entries: SchemaSnapshotEntry[] = loadRegisteredKeys(db).map((key) => ({
    kind: key.kind,
    name: key.name,
    valueType: key.valueType,
    cardinality: key.cardinality,
  }));
  return buildSchemaSnapshot(entries, generatedAt);
}

function writeRoots(ctx: CommandContext): readonly string[] {
  return [ctx.cfg.storage.data_dir, ctx.cfg.storage.archive_dir, ctx.home];
}

/**
 * `schema infer`：跑一次基数性推断并写回 ontology（幂等；`registered_at` 保留首次值）。
 *
 * 输出里区分三件事，避免用户把「已晋升」和「待晋升」混在一起：
 * - `predicates`：本次全部判定（keep / promote / observe）；
 * - `promoted`：本次写成 set / series 的谓词名；
 * - `candidates`：样本不足、本次只 observe 的谓词（下一轮够 20 个 key 再判）；
 * - `pending`：ontology 里 `promoted=0` 的线索（诊断页的「待晋升清单」口径）。
 */
function runInfer(ctx: CommandContext, rest: readonly string[]): number {
  let dryRun = false;
  for (const arg of rest) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--write') continue; // 显式写回；与默认行为一致（脚本自述用）
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
    const generatedAt = nowIso();
    const result = runSchemaInfer(db, { now: generatedAt, dryRun });
    const candidates = result.predicates
      .filter((p) => p.action === 'observe')
      .map((p) => ({
        predicate: p.name,
        keys: p.keys,
        single_ratio: p.single_ratio,
        value_occurrences: p.value_occurrences,
      }));
    const pending = listOntologyKeys(db)
      .filter((key) => !key.promoted)
      .map((key) => ({
        kind: key.kind,
        name: key.name,
        cardinality: key.cardinality,
        sample_count: key.sampleCount,
      }));
    const kept = result.predicates.filter((p) => p.action === 'keep').length;
    const promotedCount = result.predicates.filter((p) => p.action === 'promote').length;
    const observed = result.predicates.filter((p) => p.action === 'observe').length;
    // dry-run 不写库：updated=0，但 planned = 本会写回的条数（cardinality 已判定）
    const planned = result.predicates.filter((p) => p.cardinality !== null).length;
    ctx.stdout(
      `${JSON.stringify({
        command: 'schema infer',
        generated_at: generatedAt,
        dry_run: dryRun,
        predicates: result.predicates,
        attr_keys: result.attr_keys,
        promoted: result.predicates.filter((p) => p.action === 'promote').map((p) => p.name),
        candidates,
        pending,
        summary: {
          updated: dryRun ? 0 : planned,
          planned,
          kept,
          promoted: promotedCount,
          observed,
        },
      })}\n`,
    );
    return 0;
  } finally {
    closeDb(db);
  }
}

function runValidate(ctx: CommandContext, rest: readonly string[]): number {
  let snapshotPath: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--snapshot') {
      const value = takeValue(rest, i);
      if (value === null) {
        ctx.stderr(`--snapshot 需要文件路径\n${USAGE}`);
        return 2;
      }
      snapshotPath = value;
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
    const defs = loadRegisteredKeys(db);

    const violations: { fact_id: string; key: string; expected: string; actual: string }[] = [];
    const unregistered = new Map<string, number>();
    let scanned = 0;
    let violationCount = 0;

    let after = 0;
    for (;;) {
      const page = listFactsPage(db, after, BATCH);
      const last = page[page.length - 1];
      if (last === undefined) break;
      after = last.rowid;
      for (const { fact } of page) {
        scanned += 1;
        const result = validateAttrs(fact.attrs, defs);
        for (const error of result.errors) {
          violationCount += 1;
          if (violations.length < MAX_REPORTED_VIOLATIONS) {
            violations.push({ fact_id: fact.id, ...error });
          }
        }
        for (const key of result.unregisteredKeys) {
          unregistered.set(key, (unregistered.get(key) ?? 0) + 1);
        }
      }
    }

    let snapshotOut: string | null = null;
    if (snapshotPath !== null) {
      const snapshot = snapshotFromDb(db, nowIso());
      safeWriteFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, writeRoots(ctx));
      snapshotOut = snapshotPath;
    }

    const unregisteredList = [...unregistered.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, count]) => ({ key, count }));

    ctx.stdout(
      `${JSON.stringify({
        command: 'schema validate',
        ok: violationCount === 0,
        facts: scanned,
        registered_keys: defs.length,
        violations,
        violation_count: violationCount,
        violations_truncated: violationCount > violations.length,
        unregistered: unregisteredList,
        ...(snapshotOut === null ? {} : { snapshot: snapshotOut }),
      })}\n`,
    );
    return violationCount === 0 ? 0 : 1;
  } finally {
    closeDb(db);
  }
}

function readSnapshotFile(ctx: CommandContext, file: string): SchemaSnapshot | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    ctx.stderr(`无法读取 schema 快照：${file}\n`);
    return null;
  }
  try {
    return parseSchemaSnapshot(text);
  } catch (err) {
    ctx.stderr(`${(err as Error).message}\n`);
    return null;
  }
}

function currentSnapshot(ctx: CommandContext): SchemaSnapshot | null {
  const paths = dataPaths(ctx.cfg);
  if (!existsSync(paths.db)) {
    ctx.stderr(`尚未观测到数据库：${paths.db}\n`);
    return null;
  }
  const { db } = openDb({ file: paths.db });
  try {
    migrate(db, { backupsDir: paths.backups });
    return snapshotFromDb(db, nowIso());
  } finally {
    closeDb(db);
  }
}

function runDiff(ctx: CommandContext, rest: readonly string[]): number {
  let fromPath: string | null = null;
  let toPath: string | null = null;
  let outPath: string | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--from' || arg === '--to' || arg === '--out') {
      const value = takeValue(rest, i);
      if (value === null) {
        ctx.stderr(`${arg} 需要文件路径\n${USAGE}`);
        return 2;
      }
      if (arg === '--from') fromPath = value;
      else if (arg === '--to') toPath = value;
      else outPath = value;
      i += 1;
      continue;
    }
    ctx.stderr(`未知参数：${arg}\n${USAGE}`);
    return 2;
  }

  if (fromPath === null) {
    ctx.stderr(`缺少 --from 快照\n${USAGE}`);
    return 2;
  }

  const before = readSnapshotFile(ctx, fromPath);
  if (before === null) return 1;

  let after: SchemaSnapshot | null;
  if (toPath !== null) {
    after = readSnapshotFile(ctx, toPath);
  } else {
    after = currentSnapshot(ctx);
  }
  if (after === null) return 1;

  const diff = diffSchemaSnapshots(before, after);
  const generatedAt = nowIso();
  const script = renderSchemaMigration(diff, generatedAt);

  if (outPath !== null) {
    safeWriteFile(outPath, script, writeRoots(ctx));
  }

  ctx.stdout(
    `${JSON.stringify({
      command: 'schema diff',
      from: fromPath,
      to: toPath ?? '(current db)',
      generated_at: generatedAt,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
      unchanged: diff.unchanged,
      ...(outPath === null ? { script } : { out: outPath }),
    })}\n`,
  );
  return 0;
}

export const schemaCommand: Command = {
  name: 'schema',
  summary: 'schema 推断/校验/晋升 diff（schema infer | validate | diff）',
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
    if (sub === 'infer') return runInfer(ctx, rest);
    return sub === 'validate' ? runValidate(ctx, rest) : runDiff(ctx, rest);
  },
};
