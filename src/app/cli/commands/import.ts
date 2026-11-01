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
import path from 'node:path';
import { MoshiError } from '../../../domain/errors.js';
import { createSource } from '../../../core/adapters/index.js';
import { CursorStore } from '../../../core/adapters/cursor.js';
import { ingestSession } from '../../../core/write/ingest.js';
import { harvest } from '../../../core/write/harvest.js';
import { openDb, closeDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { rebuildDegree, rebuildFts, tableCounts } from '../../../infra/sqlite/maintenance.js';
import { dataPaths } from '../../config.js';
import type { Command, CommandContext } from '../types.js';

export interface ImportOptions {
  since: string;
  sources: string[];
  batchSize: number;
  factsPerSecond: number;
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
  ms: number;
}

const DEFAULT_SINCE = '1970-01-01T00:00:00.000Z';

/** 极简参数解析：只认 `--key value` 与 `--key=value`，不引第三方库 */
export function parseImportArgs(args: readonly string[]): Partial<ImportOptions> & { help?: boolean } {
  const out: Partial<ImportOptions> & { help?: boolean } = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) break;
    if (a === '--help' || a === '-h') {
      out.help = true;
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
  home: string;
  /** generic-jsonl 的收件目录（`<dataDir>/inbox`） */
  genericInbox: string;
  importCursorsFile: string;
  onProgress?: (line: string) => void;
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
    ms: 0,
  };

  const store = CursorStore.load(deps.importCursorsFile, (reason) => {
    deps.onProgress?.(`游标文件损坏，本次从 0 开始重读（${reason}）\n`);
  });
  const limiter = new RateLimiter(opts.factsPerSecond);

  for (const name of opts.sources) {
    const source = createSource(name, {
      home: deps.home,
      genericRoot: deps.genericInbox,
    });
    if (source === null) {
      result.unavailable.push(name);
      continue;
    }
    const det = await source.detect();
    if (!det.found) {
      result.unavailable.push(name);
      continue;
    }

    for await (const ref of source.listSessions(opts.since)) {
      result.sessions += 1;
      const cursor = store.get(name, ref.path);
      const ing = await ingestSession(db, source, ref, cursor);
      if (ing.error !== undefined) {
        // 出错不推进游标：下次重跑会重读这个文件（episode/annotation 幂等兜底）
        result.failed += 1;
        deps.onProgress?.(`跳过 ${ref.path}：${ing.error}\n`);
        continue;
      }
      result.turns += ing.events;
      store.set(name, ref.path, ing.nextCursor);
      store.save(); // 每个会话读完整就落盘：中断也只丢当前这一个文件

      // 一片一调用：限速与进度都有落点
      for (;;) {
        const h = await harvest(db, { batchSize: opts.batchSize, maxBatches: 1 });
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
      }
    }
  }

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
          '用法：moshi import [--since 2025-01-01] [--source claude-code] [--batch 500] [--rate 20]',
          '',
          '  --since   起始时间（缺省 1970-01-01，即全部历史）',
          '  --source  只导某个来源，可重复；缺省取配置 [ingest] sources',
          '  --batch   每批 annotation 数（默认取 [ingest] import_batch）',
          '  --rate    每秒最多写入多少条事实（默认 20，0 表示不限速）',
          '',
        ].join('\n'),
      );
      return 0;
    }

    const opts: ImportOptions = {
      since: parsed.since ?? DEFAULT_SINCE,
      sources: parsed.sources ?? ctx.cfg.ingest.sources,
      batchSize: parsed.batchSize ?? ctx.cfg.ingest.import_batch,
      factsPerSecond: parsed.factsPerSecond ?? 20,
    };

    const paths = dataPaths(ctx.cfg);
    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });
      const result = await runImport({
        db,
        opts,
        // home 只从 ctx 拿：与 cfg 同源，否则「配置读真实 home、会话扫另一个 home」
        home: ctx.home,
        genericInbox: path.join(paths.root, 'inbox'),
        importCursorsFile: paths.importCursors,
        onProgress: (line) => {
          ctx.stdout(line);
        },
      });

      const counts = tableCounts(db);
      ctx.stdout(
        `\n导入完成：${String(result.sessions)} 个会话、${String(result.turns)} 个回合、` +
          `${String(result.facts)} 条新事实（刷新 ${String(result.refreshed)}）、` +
          `${String(result.quarantined)} 条进隔离区、${String(result.skipped)} 条未识别、` +
          `${String(result.failed)} 条失败，用时 ${(result.ms / 1000).toFixed(1)}s\n` +
          `当前库：${Object.entries(counts)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(' ')}\n`,
      );
      if (result.unavailable.length > 0) {
        ctx.stderr(`未找到可导入的会话源：${result.unavailable.join(', ')}（跳过，不算失败）\n`);
        return 4;
      }
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
