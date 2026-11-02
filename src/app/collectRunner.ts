/**
 * 采集扫描的后台驱动（P2-21 的生产调用点）。
 *
 * 台账 P2-21 的产出写的是"挂到 P2-17 调度器"，但 P2-17 还没开工。为了不让
 * 扫描器继续当死代码（DoD 第 6 条），这里先用一个自足的定时器接上：与
 * `harvestRunner` 同一套路（`setInterval` + `wake()` + 单轮不重入），
 * 等 P2-17 落地后再把驱动换成调度器，扫描逻辑不用动。
 *
 * 职责边界：
 * - 只负责"定时跑一遍 `scanAllSources`"，解析/入队/预算全在 `core/collect/scanner.ts`；
 * - 新 annotation 入队后唤醒 `harvestRunner`，让事实不必等 15s 兜底周期；
 * - 不碰 sidecar、不改生命周期。
 */
import { scanAllSources, type ScanAllOptions, type ScanStats } from '../core/collect/scanner.js';
import type { Config } from './config.js';
import type { Db } from '../infra/sqlite/db.js';

/** 只用到 info/warn/error 三条，避免把 pino 类型拖进 app 层 */
export interface CollectRunnerLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CollectRunnerOptions {
  db: Db;
  cfg: Config;
  cursorsFile: string;
  home: string;
  genericInbox: string;
  sources?: string[];
  log?: CollectRunnerLog;
  /** 有 annotation 入队时调（通常是 `harvestRunner.wake`） */
  onEnqueued?: () => void;
  /** 覆盖配置里的 `collect.interval_ms`（测试用；`0` = 不自动跑） */
  intervalMs?: number;
}

export interface CollectRunnerState {
  runs: number;
  lastMs: number | null;
  lastError: string | null;
  lastStats: ScanStats | null;
  enabled: boolean;
}

export interface CollectRunner {
  /** 立刻跑一轮（同步等待）；运行中调用只置标记，一轮结束后再补一次 */
  wake(): void;
  /** 同步跑一轮（测试与 CLI 用） */
  runOnce(): Promise<ScanStats | null>;
  stop(): void;
  state(): CollectRunnerState;
}

export function collectConfigOf(cfg: Config) {
  return {
    enabled: cfg.collect.enabled,
    llmScan: cfg.collect.llm_scan,
    llmBatchTurns: cfg.collect.llm_batch_turns,
    llmPerSessionDaily: cfg.collect.llm_per_session_daily,
    llmDailyTokenBudget: cfg.collect.llm_daily_token_budget,
    promptVersion: cfg.collect.prompt_version,
  };
}

export function startCollectRunner(opts: CollectRunnerOptions): CollectRunner {
  const { db, cfg, log } = opts;
  const intervalMs = opts.intervalMs ?? cfg.collect.interval_ms;
  const sources = opts.sources ?? cfg.ingest.sources;

  const st: CollectRunnerState = {
    runs: 0,
    lastMs: null,
    lastError: null,
    lastStats: null,
    enabled: cfg.collect.enabled,
  };

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let again = false;
  let stopped = false;

  const scanOpts: ScanAllOptions = {
    cfg: collectConfigOf(cfg),
    cursorsFile: opts.cursorsFile,
    home: opts.home,
    genericInbox: opts.genericInbox,
    sources,
    // 阶段 2 的 LLM 调用方尚未接入（P3 支路），生产侧不伪造一个本地归纳器
    onProgress: (line) => log?.info({ event: 'collect.scan' }, line.trimEnd()),
  };

  const runOnce = async (): Promise<ScanStats | null> => {
    if (!st.enabled) return null;
    const t0 = Date.now();
    try {
      const res = await scanAllSources(db, scanOpts);
      st.runs += 1;
      st.lastMs = Date.now() - t0;
      st.lastError = null;
      st.lastStats = res.stats;

      const enqueued = res.stats.blockAnnotationsCreated + res.stats.llmCalls;
      if (enqueued > 0) opts.onEnqueued?.();
      if (res.stats.blocksFound > 0 || res.stats.malformed > 0 || res.stats.notices.length > 0) {
        log?.info(
          {
            event: 'collect.round',
            sessions: res.sessions,
            ...res.stats,
            unavailable: res.unavailable,
          },
          'collect round done',
        );
      }
      // 预算耗尽是"今天别再扫 LLM 了"的信号，值得一条 warn（§5.12.5）
      if (res.stats.llmBudgetExhausted) {
        log?.warn({ event: 'llm_scan_budget_exhausted' }, 'LLM 归纳日预算已用尽，阶段 2 停摆');
      }
      return res.stats;
    } catch (err) {
      st.lastError = (err as Error).message;
      log?.error({ event: 'collect.failed', err: st.lastError }, 'collect round failed');
      return null;
    }
  };

  const tick = (): void => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void runOnce().finally(() => {
      running = false;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    });
  };

  const schedule = (): void => {
    if (stopped || intervalMs <= 0) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, intervalMs);
    // 不阻塞进程退出：扫描是后台活，daemon 退出时不该被它拖住
    timer.unref();
  };

  if (st.enabled && intervalMs > 0) schedule();

  return {
    wake: () => {
      tick();
    },
    runOnce,
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    state: () => ({ ...st, lastStats: st.lastStats }),
  };
}
