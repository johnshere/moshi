/**
 * `moshi import`（详设 §5.11）。
 *
 * 历史会话回填。与日常 harvest 只有一处差别，但那处差别决定成败：
 * **用独立的游标文件 `cursors.import.json`**。共用 `cursors.json` 的话，
 * 一次 `--since 2025-01-01` 会把日常游标推到文件尾，中间的增量从此再也不读——
 * 表现为"导入当天正常，第二天起新会话全丢"。
 *
 * 另外两条：
 * - **限速**（默认 20 条事实/秒）：首次导入几千条事实会把 UI 与 daemon 抢死；
 * - **一片一调用 harvest**：这样限速与进度输出有落点，而不是一次性吸干队列。
 *
 * 退出码（详设 §4.7）：`0` 成功、`1` 一般错误、`2` 参数/配置错、`4` 降级但可用
 * （没找到任何会话源——不是错误，只是这台机器上没有可导入的东西）。
 */
import { MoshiError } from '../../../domain/errors.js';
import { createSourceFor, type ResolvedSource } from '../../../core/adapters/index.js';
import { CursorStore } from '../../../core/adapters/cursor.js';
import { ingestSession } from '../../../core/write/ingest.js';
import { harvest } from '../../../core/write/harvest.js';
import { runSchemaInfer } from '../../../core/lifecycle/schema-infer.js';
import { openDb, closeDb, isBusyError } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { rebuildDegree, rebuildFts, tableCounts } from '../../../infra/sqlite/maintenance.js';
import { dataPaths, resolveSources } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

export interface ImportOptions {
  since: string;
  /** 已解析的 source 实例（命令层 resolveSources 得到，再按 --source 过滤） */
  sources: ResolvedSource[];
  batchSize: number;
  factsPerSecond: number;
}

/** `parseImportArgs` 的产物：`sources` 是过滤词（id 或 adapter 名），不是实例 */
export interface ImportArgs {
  since?: string;
  sources?: string[];
  batchSize?: number;
  factsPerSecond?: number;
  /** 机器可读模式：进度走 stderr，stdout 只输出一行 JSON（daemon 的 /api/import 用它） */
  json?: boolean;
  help?: boolean;
}

export interface ImportResult {
  sessions: number;
  turns: number;
  facts: number;
  refreshed: number;
  quarantined: number;
  skipped: number;
  failed: number;
  /** 找到但没有可用适配器的源名 */
  unavailable: string[];
  /** P1-24：导入后写入/更新谓词基数性的条数 */
  promoted: number;
  ms: number;
}

const DEFAULT_SINCE = '1970-01-01T00:00:00.000Z';

/** 极简参数解析：只认 `--key value` 与 `--key=value`，不引第三方库 */
export function parseImportArgs(args: readonly string[]): ImportArgs {
  const out: ImportArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) break;
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--json') {
      out.json = true;
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      i += 1;
      return next;
    };
    switch (key) {
      case '--since': {
        const v = value();
        if (v !== undefined) out.since = normalizeSince(v);
        break;
      }
      case '--source': {
        const v = value();
        if (v !== undefined) out.sources = [...(out.sources ?? []), v];
        break;
      }
      case '--batch': {
        const v = value();
        if (v !== undefined) out.batchSize = Math.max(1, Number(v));
        break;
      }
      case '--rate': {
        const v = value();
        if (v !== undefined) out.factsPerSecond = Math.max(0, Number(v));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** `2025-01-01` → `2025-01-01T00:00:00.000Z`；已经是完整时间戳就原样用 */
export function normalizeSince(input: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return `${input}T00:00:00.000Z`;
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    throw new MoshiError('E_INPUT', `--since 不是合法日期：${input}`, { input });
  }
  return new Date(ms).toISOString();
}

/**
 * 导入的退出码口径（CLI 与 daemon 的 `/api/import` 共用）。
 *
 * 4 = 配置的源一个都用不上；部分源缺失不算失败——默认源是 `claude-code + dsh`，
 * 机器上缺其中一个目录是常态。一个源都没配（`unavailable` 为空）只是"无事可做"，
 * 仍算成功，所以这里要求 `unavailable` 非空才可能返回 4。
 */
export function importExitCode(sourceCount: number, unavailable: readonly string[]): number {
  return unavailable.length > 0 && sourceCount - unavailable.length <= 0 ? 4 : 0;
}

/** 令牌桶式的简单限速：保证"每秒不超过 N 条" */
export class RateLimiter {
  private nextAt = 0;

  constructor(private readonly perSecond: number) {}

  async take(count: number): Promise<void> {
    if (this.perSecond <= 0 || count <= 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    // 按"这批占用了多少配额"推进下一次可用时间
    this.nextAt = Math.max(now, this.nextAt) + (count / this.perSecond) * 1000;
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

export interface RunImportDeps {
  db: ReturnType<typeof openDb>['db'];
  opts: ImportOptions;
  importCursorsFile: string;
  onProgress?: (line: string) => void;
}

/**
 * 批间让锁：daemon 的钩子 / MCP 写入与导入是同一个库的写者。
 * 一片提交完主动歇 20ms，让等在锁上的写者插进来——否则导入会连着抢锁，
 * 对方每次都得多等一轮（WAL 写者互斥，读不受影响）。
 */
const LOCK_YIELD_MS = 20;

/** 一片 harvest 撞锁（事务级重试已用尽）时的额外重试次数 */
const IMPORT_BUSY_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 导入侧单片 harvest。
 *
 * 事务级的撞锁重试在 `withTransaction` 里（整笔重来）；这里兜的是"重试也抢不到"的
 * 极端情形：annotation 还在队列里（`harvested_at IS NULL`），所以这一片可以留给
 * daemon 的 harvest 或下一次导入，不必让整次导入失败。返回 `null` 表示本轮放弃。
 */
async function harvestOneBatch(
  db: RunImportDeps['db'],
  opts: ImportOptions,
): Promise<Awaited<ReturnType<typeof harvest>> | null> {
  for (let attempt = 1; attempt <= IMPORT_BUSY_ATTEMPTS; attempt += 1) {
    try {
      return await harvest(db, { batchSize: opts.batchSize, maxBatches: 1 });
    } catch (err) {
      if (!isBusyError(err)) throw err;
      if (attempt === IMPORT_BUSY_ATTEMPTS) return null;
      await sleep(LOCK_YIELD_MS * 2 * attempt);
    }
  }
  return null;
}

/**
 * 导入主流程。抽成函数而不是塞在命令里，是为了能在测试里直接调用
 * （命令层只负责解析参数、开库、打印）。
 */
export async function runImport(deps: RunImportDeps): Promise<ImportResult> {
  const { db, opts } = deps;
  const started = Date.now();
  const result: ImportResult = {
    sessions: 0,
    turns: 0,
    facts: 0,
    refreshed: 0,
    quarantined: 0,
    skipped: 0,
    failed: 0,
    unavailable: [],
    promoted: 0,
    ms: 0,
  };

  const store = CursorStore.load(deps.importCursorsFile, (reason) => {
    deps.onProgress?.(`游标文件损坏，本次从 0 开始重读（${reason}）\n`);
  });
  const limiter = new RateLimiter(opts.factsPerSecond);

  for (const spec of opts.sources) {
    const source = createSourceFor(spec);
    if (source === null) {
      result.unavailable.push(spec.id);
      continue;
    }
    const det = await source.detect();
    if (!det.found) {
      result.unavailable.push(spec.id);
      continue;
    }

    for await (const ref of source.listSessions(opts.since)) {
      result.sessions += 1;
      // 游标 key 用 source.id（P3-A8）：两个同 adapter 的实例共用 adapter 名会互相踩
      const cursor = store.get(spec.id, ref.path);
      const ing = await ingestSession(db, source, ref, cursor);
      if (ing.error !== undefined) {
        // 出错不推进游标：下次重跑会重读这个文件（episode/annotation 幂等兜底）
        result.failed += 1;
        deps.onProgress?.(`跳过 ${ref.path}：${ing.error}\n`);
        continue;
      }
      result.turns += ing.events;
      store.set(spec.id, ref.path, ing.nextCursor);
      store.save(); // 每个会话读完整就落盘：中断也只丢当前这一个文件

      // 一片一调用：限速与进度都有落点
      for (;;) {
        const h = await harvestOneBatch(db, opts);
        if (h === null) {
          // 抢不到写锁：剩下的条目留在 annotation 队列里，后台 harvest 会接着做
          deps.onProgress?.('数据库持续被占用，剩余条目留给后台 harvest 处理\n');
          break;
        }
        if (h.scanned === 0) break;
        result.facts += h.created;
        result.refreshed += h.refreshed + h.recreated + h.superseded + h.coexist;
        result.quarantined += h.quarantined;
        result.skipped += h.skipped;
        result.failed += h.failed;
        deps.onProgress?.(
          `imported ${String(result.turns)} turns, ${String(result.facts)} facts, ${String(
            result.quarantined,
          )} quarantined\n`,
        );
        await limiter.take(h.created + h.refreshed);
        await sleep(LOCK_YIELD_MS);
      }
    }
  }

  // P1-24：谓词基数性是互斥裁决的前置（adjudicate ② 见不到 single-valued 就不判冲突）。
  // 导入是"批量写事实"的唯一入口，这里算一次；daemon 启动另有 schemaInferRunner 兜底。
  const schema = runSchemaInfer(db);
  result.promoted = schema.predicates.filter((p) => p.action !== 'observe').length;

  rebuildFts(db);
  rebuildDegree(db);
  result.ms = Date.now() - started;
  return result;
}

export const importCommand: Command = {
  name: 'import',
  summary: '历史会话回填（独立游标，限速）',
  run: async (ctx: CommandContext): Promise<number> => {
    const parsed = parseImportArgs(ctx.args);
    if (parsed.help === true) {
      ctx.stdout(
        [
          '用法：moshi import [--since 2025-01-01] [--source claude-code] [--batch 500] [--rate 20] [--json]',
          '',
          '  --since   起始时间（缺省 1970-01-01，即全部历史）',
          '  --source  按 source id 过滤（也接受 adapter 名），可重复；缺省取配置 [ingest] sources',
          '  --batch   每批 annotation 数（默认取 [ingest] import_batch）',
          '  --rate    每秒最多写入多少条事实（默认 20，0 表示不限速）',
          '  --json    进度走 stderr，stdout 只输出一行 JSON 结果（机器调用用）',
          '',
        ].join('\n'),
      );
      return 0;
    }

    // P3-A8：配置里的 source 声明解析成实例；`--source` 只做过滤（id 或 adapter 名）
    const allSources = resolveSources(ctx.cfg, ctx.home);
    const wanted = parsed.sources;
    const sources =
      wanted === undefined
        ? allSources
        : allSources.filter((s) => wanted.includes(s.id) || wanted.includes(s.adapter));
    const unknown = (wanted ?? []).filter(
      (w) => !allSources.some((s) => s.id === w || s.adapter === w),
    );

    const opts: ImportOptions = {
      since: parsed.since ?? DEFAULT_SINCE,
      sources,
      batchSize: parsed.batchSize ?? ctx.cfg.ingest.import_batch,
      factsPerSecond: parsed.factsPerSecond ?? 20,
    };
    // `--json`：进度改走 stderr，stdout 留干净给最后一行 JSON
    const json = parsed.json === true;
    const progress = json ? ctx.stderr : ctx.stdout;

    const paths = dataPaths(ctx.cfg);
    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });
      const result = await runImport({
        db,
        opts,
        importCursorsFile: paths.importCursors,
        onProgress: progress,
      });
      // CLI 上写错的 --source 与"配置的源不可用"同样处理：跳过，不算失败
      const unavailable = [...unknown, ...result.unavailable];
      // 退出码只看"配置的源有没有一个能用上"：双源默认下缺 ~/.dsh 只跳过 dsh
      const code = importExitCode(sources.length, result.unavailable);
      if (unavailable.length > 0) {
        ctx.stderr(
          code === 4
            ? `未找到可导入的会话源：${unavailable.join(', ')}（跳过，不算失败）\n`
            : `跳过不可用的会话源：${unavailable.join(', ')}\n`,
        );
      }

      if (json) {
        // daemon 的 /api/import 子进程按 stdout 最后一行解析，别的都不要往 stdout 写
        ctx.stdout(`${JSON.stringify({ ...result, unavailable, ok: code === 0 })}\n`);
        return code;
      }

      const counts = tableCounts(db);
      ctx.stdout(
        `\n导入完成：${String(result.sessions)} 个会话、${String(result.turns)} 个回合、` +
          `${String(result.facts)} 条新事实（刷新 ${String(result.refreshed)}）、` +
          `${String(result.quarantined)} 条进隔离区、${String(result.skipped)} 条未识别、` +
          `${String(result.failed)} 条失败、谓词基数性更新 ${String(result.promoted)} 条，` +
          `用时 ${(result.ms / 1000).toFixed(1)}s\n` +
          `当前库：${Object.entries(counts)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(' ')}\n`,
      );
      return code;
    } finally {
      closeDb(db);
    }
  },
};
