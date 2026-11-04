/**
 * 写入闭环的消费者（P1-22）。
 *
 * `memory_annotate` 只把事实**入队**（`annotation` 表），真正落图要经 `harvest` 的六步。
 * 在此之前，harvest 的唯一调用点是 `moshi import`——也就是说 Agent 通过 MCP 说"记住"，
 * 事实会一直躺在缓冲区里，直到某天有人手动跑一次 import。这个 runner 补的就是这一段：
 *
 * - **唤醒**：`annotate` 提交事务后调 `wake()`，立即消费，不等轮询周期。
 * - **兜底**：即便没人唤醒（比如队列是上一次进程留下的），每 `intervalMs` 也会扫一轮。
 * - **限深**：单轮最多 `maxBatches` 批，队列再长也会让出事件循环，不阻塞 HTTP。
 * - **不重入**：运行中再来的唤醒只置一个 `again` 标记，一轮结束后再补一次，不并发跑两轮。
 * - **收尾巩固**：一轮 harvest 结束后串行跑情景→语义巩固（P2-09）与过程提炼（P2-10）。
 *   巩固是低优先级后台维护，跑挂了只记日志，不影响已经落库的事实。
 *
 * 不做的事：不碰 sidecar、不写归档、不改生命周期状态——那些有各自的触发点。
 */
import {
  consolidate,
  extractProcedures,
  type ConsolidateOptions,
  type ProcedureOptions,
} from '../core/lifecycle/consolidate.js';
import { harvest, type HarvestResult } from '../core/write/harvest.js';
import { countPending, countErrors } from '../infra/sqlite/annotationRepo.js';
import type { Db } from '../infra/sqlite/db.js';

/** 只用到 info/error 两条，避免把 pino 的类型拖进 app 层 */
export interface HarvestRunnerLog {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface HarvestRunnerOptions {
  db: Db;
  log?: HarvestRunnerLog;
  /** 无唤醒时的兜底扫描周期；`0` = 只靠 `wake()` 驱动（测试用） */
  intervalMs?: number;
  batchSize?: number;
  maxBatches?: number;
  /**
   * harvest 收尾的情景→语义巩固（P2-09）。默认开，参数直通 `consolidate`；
   * `false` = 关掉（只想测写入链路、或调用方自己控制巩固时机）。
   */
  consolidate?: ConsolidateOptions | false;
  /** harvest 收尾的过程提炼（P2-10）。默认开，`false` = 关掉 */
  procedures?: ProcedureOptions | false;
}

export interface HarvestRunnerState {
  pending: number;
  errors: number;
  runs: number;
  lastMs: number | null;
}

export interface HarvestRunner {
  /** 有新入队时调用；空闲时立刻跑一轮，运行中则排队再跑一轮 */
  wake(): void;
  /** 同步跑一轮（测试与 CLI 用），返回 harvest 的统计 */
  runOnce(): Promise<HarvestResult>;
  stop(): void;
  state(): HarvestRunnerState;
}

/** 兜底周期：15s 足够快（入队到可见的延迟上限），又不会空转得太频繁 */
export const HARVEST_INTERVAL_MS = 15_000;
export const HARVEST_BATCH_SIZE = 50;
/** 单轮最多 8 批 × 50 = 400 条；再长的积压交给下一轮，避免长时间占住事件循环 */
export const HARVEST_MAX_BATCHES = 8;

export function startHarvestRunner(opts: HarvestRunnerOptions): HarvestRunner {
  const { db, log } = opts;
  const intervalMs = opts.intervalMs ?? HARVEST_INTERVAL_MS;
  const batchSize = opts.batchSize ?? HARVEST_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? HARVEST_MAX_BATCHES;
  const consolidateOpts = opts.consolidate === false ? null : (opts.consolidate ?? {});
  const procedureOpts = opts.procedures === false ? null : (opts.procedures ?? {});

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  let stopped = false;
  let runs = 0;
  let lastMs: number | null = null;

  const runOnce = async (): Promise<HarvestResult> => {
    const startedAt = performance.now();
    const res = await harvest(db, { batchSize, maxBatches });
    // 只在真有变化或出错时写日志，空转不刷屏
    if (res.created + res.refreshed + res.superseded + res.coexist > 0 || res.failed > 0) {
      log?.info(
        { event: 'harvest.run', ...res },
        res.failed > 0 ? 'harvest finished with errors' : 'harvest applied',
      );
    }
    if (consolidateOpts !== null) {
      // 巩固失败不冒泡：写入闭环是主线，巩固只是它后面的低优先级维护
      try {
        const c = await consolidate(db, consolidateOpts);
        if (c.created + c.superseded > 0) {
          log?.info({ event: 'consolidate.run', ...c }, 'episodic consolidated');
        }
      } catch (err) {
        log?.error(
          { event: 'consolidate.failed', err: (err as Error).message },
          'consolidate round failed',
        );
      }
    }
    if (procedureOpts !== null) {
      try {
        const p = await extractProcedures(db, procedureOpts);
        if (p.created + p.superseded > 0) {
          log?.info({ event: 'procedure.run', ...p }, 'procedures extracted');
        }
      } catch (err) {
        log?.error(
          { event: 'procedure.failed', err: (err as Error).message },
          'procedure round failed',
        );
      }
    }
    runs += 1;
    lastMs = Math.round(performance.now() - startedAt);
    return res;
  };

  const pump = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await runOnce();
      } while (again && !stopped);
    } catch (err) {
      // harvest 内部的单条失败已经 markError，走到这里的是库级异常（锁、磁盘满）
      log?.error({ event: 'harvest.failed', err: (err as Error).message }, 'harvest round failed');
    } finally {
      running = false;
    }
  };

  const wake = (): void => {
    if (stopped) return;
    setImmediate(() => void pump());
  };

  if (intervalMs > 0) {
    timer = setInterval(() => {
      if (stopped) return;
      if (countPending(db) > 0) void pump();
    }, intervalMs);
    // 不给测试进程添负担：daemon 自己靠 main.ts 的保活定时器撑着
    timer.unref();
  }

  return {
    wake,
    runOnce,
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
    state(): HarvestRunnerState {
      return { pending: countPending(db), errors: countErrors(db), runs, lastMs };
    },
  };
}
