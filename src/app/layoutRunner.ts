/**
 * daemon 里的布局节流器（P2-01 / D16）。
 *
 * 为什么要有它：`moshi layout` 只解决"人能手动算一次"，而事实是 harvest 在不断
 * 产出的——不接定时触发，新事实会长时间没有坐标（图上不出现），或者要等用户
 * 想起来敲命令。P2-17 调度器还没开工，这里先按 P2-21 的同类做法，用一个
 * unref 的定时器顶住（台账 §5.2 D-69 的取舍），调度器落地后换驱动、不换逻辑。
 *
 * 节流靠**脏检查**而不是"每次都算"：`countUnlaidFacts` 走一次索引即可，没有新
 * 事实时连 worker 都不起。周期默认 60s（`[layout].interval_ms`），
 * `interval_ms = 0` 或 `enabled = false` 时完全不跑。
 */
import type { Db } from '../infra/sqlite/db.js';
import { countUnlaidFacts } from '../infra/sqlite/layoutRepo.js';
import type { Config } from './config.js';
import { runLayoutJob, type LayoutJobStats } from './jobs/layout.job.js';

/** 只用到 info/error 两条，避免把 pino 类型拖进 app 层 */
export interface LayoutRunnerLog {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface LayoutRunnerOptions {
  db: Db;
  cfg: Config;
  log?: LayoutRunnerLog;
  /** 覆盖配置里的周期（测试用）；`0` = 只靠 `runOnce()` */
  intervalMs?: number;
}

export interface LayoutRunnerState {
  running: boolean;
  runs: number;
  lastMs: number | null;
}

export interface LayoutRunner {
  runOnce(): Promise<LayoutJobStats>;
  stop(): void;
  state(): LayoutRunnerState;
}

/** 兜底周期：1min 足够让新事实及时上屏，又不会把 CPU 烧在 300 tick 上 */
export const LAYOUT_INTERVAL_MS = 60_000;

export function startLayoutRunner(opts: LayoutRunnerOptions): LayoutRunner {
  const { db, cfg, log } = opts;
  const intervalMs = opts.intervalMs ?? cfg.layout.interval_ms;

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let runs = 0;
  let lastMs: number | null = null;

  const runOnce = async (): Promise<LayoutJobStats> => {
    const startedAt = performance.now();
    const stats = await runLayoutJob({ db, cfg });
    runs += 1;
    lastMs = Math.round(performance.now() - startedAt);
    // up-to-date / no-facts 不刷日志：这个 runner 每分钟都会醒一次
    if (stats.mode !== 'skip') {
      log?.info({ event: 'layout.run', ...stats }, 'layout computed');
    }
    return stats;
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    if (countUnlaidFacts(db) === 0) return;
    running = true;
    try {
      await runOnce();
    } catch (err) {
      log?.error({ event: 'layout.failed', err: (err as Error).message }, 'layout job failed');
    } finally {
      running = false;
    }
  };

  if (intervalMs > 0) {
    timer = setInterval(() => void tick(), intervalMs);
    // 不给测试进程添负担：daemon 自己靠 main.ts 的保活定时器撑着
    timer.unref();
  }

  return {
    runOnce,
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
    state(): LayoutRunnerState {
      return { running, runs, lastMs };
    },
  };
}
