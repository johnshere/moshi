/**
 * 采集扫描的后台驱动（P2-21 / P2-17 收口）。
 *
 * P2-17 起由 `app/jobs/scheduler.ts` 持有扫描节奏（按 `collect.interval_ms` 在
 * 串行队列里触发 `runOnce()`），本 runner **默认不再自装定时器**——否则 daemon
 * 日志里同一个采集任务会出现两条调度链。只有显式传 `intervalMs > 0` 时才自调度
 * （独立使用/测试）。扫描逻辑本身不变。
 *
 * 职责边界：
 * - 只负责"定时跑一遍 `scanAllSources`"，解析/入队/预算全在 `core/collect/scanner.ts`；
 * - 新 annotation 入队后唤醒 `harvestRunner`，让事实不必等 15s 兜底周期；
 * - 不碰 sidecar、不改生命周期。
 */
import { scanAllSources, type ScanAllOptions, type ScanStats } from '../core/collect/scanner.js';
import os from 'node:os';
import { resolveSources, type Config, type ResolvedSource } from './config.js';
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
  /** 覆盖 home（测试用）；`sources` 未给时用它解析默认 source */
  home?: string;
  /** 已解析的 source 实例（P3-A8）；缺省 `resolveSources(cfg, home)` */
  sources?: ResolvedSource[];
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
  // 默认 0：节奏由 P2-17 调度器持有（避免两条调度链）
  const intervalMs = opts.intervalMs ?? 0;
  // P3-A8：源一律走配置解析出的实例（id/root/enabled/field_map 都生效）
  const sources = opts.sources ?? resolveSources(cfg, opts.home ?? os.homedir());

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
