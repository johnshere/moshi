/**
 * 后台任务调度器（P2-17 / 详设 §8.6）。
 *
 * 设计要点：
 * - **cron 驱动 + 依赖链**：`harvest` 到点后依次触发 `consolidate`、`infer`；`export`
 *   到点后触发 `layout`；`backup` 独立按小时跑。依赖用 `after` 表达，优先级升序执行。
 * - **串行**：所有任务共享一条队列（并发 1，单写者）；片间 `setImmediate` 让出事件循环，
 *   不在同步 CPU 活里把 HTTP/MCP 请求卡住。
 * - **错过不补跑**：每次 tick 只看「当前这一分钟」，两分钟前的 tick 不追溯（harvest 有游标，
 *   下次自然补齐）。
 * - **超时**：单任务默认 10 分钟硬超时；超时写 `warn`、记录状态并继续下一任务。
 * - **限速**：`createRateLimiter` 提供每任务 20 条/秒的令牌桶；任务通过 `ctx.throttle(n)` 消费。
 * - **采集扫描**：`collectRunner` 不再自装定时器，由本调度器按 `collect.interval_ms` 触发，
 *   并复用同一串行队列（同一时刻只有一条调度链）。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { archiveAll } from '../../core/archive/index.js';
import { writeArchiveLedger } from '../../core/archive/topic.js';
import { consolidate } from '../../core/lifecycle/consolidate.js';
import { runSchemaInfer } from '../../core/lifecycle/schema-infer.js';
import { harvest } from '../../core/write/harvest.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from '../../infra/sqlite/db.js';
import { countUnlaidFacts } from '../../infra/sqlite/layoutRepo.js';
import { countEdges } from '../../infra/sqlite/edgeRepo.js';
import { schemaRev, setMeta } from '../../infra/sqlite/metaRepo.js';
import { safeEnsureDir, safeRemoveFile } from '../../infra/fs/safeWrite.js';
import { dataPaths, type Config } from '../config.js';
import { runCommunityOnce } from '../communityRunner.js';
import { runLayoutJob } from './layout.job.js';

/** 单任务硬超时：10 分钟（详设 §8.6） */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
/** 每任务限速：20 条/秒（详设 §8.6） */
export const RATE_LIMIT_PER_SECOND = 20;
/** 调度器自身 tick 周期：15s 足够命中分钟粒度的 cron，又不至于空转 */
export const SCHEDULER_TICK_MS = 15_000;

export interface SchedulerLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobContext {
  db: Db;
  cfg: Config;
  log: SchedulerLog;
  now: Date;
  signal: AbortSignal;
  /** 消费令牌桶（参数=本片处理条数），用于把任务吞吐压到 20 条/秒 */
  throttle: (items?: number) => Promise<void>;
}

export interface SchedulerJob {
  name: string;
  /** 5 段 cron（分 时 日 月 周）；与 `after` 二选一或并存 */
  cron?: string;
  /** 依赖任务：父任务在本轮执行后触发（无 cron 的任务只靠 after 触发） */
  after?: string;
  /** 数值越小越先跑 */
  priority: number;
  run(ctx: JobContext): Promise<unknown>;
}

export interface JobRunResult {
  name: string;
  status: 'ok' | 'failed' | 'timeout' | 'skipped';
  ms: number;
  error?: string;
}

export interface SchedulerState {
  running: string | null;
  queued: number;
  runs: number;
  lastMinute: number | null;
  lastRuns: Record<string, JobRunResult>;
}

export interface Scheduler {
  /** 按当前时间跑一轮到点的任务（测试可注入 now）；同一年分钟只触发一次 */
  runDue(now?: Date): Promise<JobRunResult[]>;
  /** 显式跑一个任务（不经 cron，用于 forceRun / 测试） */
  runJob(name: string): Promise<JobRunResult>;
  stop(): void;
  state(): SchedulerState;
}

export interface SchedulerOptions {
  db: Db;
  cfg: Config;
  log: SchedulerLog;
  /** 覆盖默认 JOBS（测试与定制化） */
  jobs?: readonly SchedulerJob[];
  /** collectRunner.runOnce 的注入点；不传则不驱动采集扫描 */
  collect?: () => Promise<unknown> | unknown;
  /**
   * harvestRunner.runOnce 的注入点：cron 到点时复用 daemon 里那一个 runner，
   * 让「唤醒 / 15s 兜底 / 03:00 cron」三条触发源共用同一条单飞链路（P2-17 收口）。
   * 不传则直接调核心 `harvest()`（测试与独立进程用）。
   */
  harvest?: () => Promise<unknown> | unknown;
  /** 覆盖单任务超时（测试用） */
  timeoutMs?: number;
  /** 自动 tick 周期；0 = 不装定时器（测试用） */
  timerMs?: number;
  /** 时间源（测试用） */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// cron（5 段：分 时 日 月 周；支持 `*`、`a-b`、`*/n`、`a-b/n`、逗号列表）
// ---------------------------------------------------------------------------

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** 日/周字段是否被限制：两者都限制时按标准 cron 取 OR */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (m === null) throw new Error(`invalid cron ${label} field: ${field}`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step <= 0) throw new Error(`invalid cron ${label} step: ${field}`);
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else if (m[1]!.includes('-')) {
      const [a, b] = m[1]!.split('-').map(Number) as [number, number];
      lo = a;
      hi = b;
    } else {
      lo = Number(m[1]);
      hi = step === 1 ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${label} out of range: ${field}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields: ${expr}`);
  return {
    minutes: parseCronField(fields[0]!, 0, 59, 'minute'),
    hours: parseCronField(fields[1]!, 0, 23, 'hour'),
    // 允许 0 与 7 都表示周日：周字段按 0-7 解析，匹配时 7 归一到 0
    days: parseCronField(fields[2]!, 1, 31, 'day'),
    months: parseCronField(fields[3]!, 1, 12, 'month'),
    weekdays: parseCronField(fields[4]!, 0, 7, 'weekday'),
    dayRestricted: fields[2] !== '*',
    weekdayRestricted: fields[4] !== '*',
  };
}

export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.minutes.has(at.getMinutes())) return false;
  if (!spec.hours.has(at.getHours())) return false;
  if (!spec.months.has(at.getMonth() + 1)) return false;
  const dow = at.getDay();
  const dayOk = spec.days.has(at.getDate());
  const weekOk = spec.weekdays.has(dow) || (dow === 0 && spec.weekdays.has(7));
  if (spec.dayRestricted && spec.weekdayRestricted) return dayOk || weekOk;
  return dayOk && weekOk;
}

// ---------------------------------------------------------------------------
// 限速（令牌桶）
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** 消费 n 个令牌；不足时等到下一个窗口补满 */
  take(n?: number): Promise<void>;
  available(): number;
}

export function createRateLimiter(opts: {
  capacity?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): RateLimiter {
  const capacity = Math.max(1, opts.capacity ?? RATE_LIMIT_PER_SECOND);
  const intervalMs = Math.max(1, opts.intervalMs ?? 1000);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let tokens = capacity;
  let last = now();
  const refill = (): void => {
    const t = now();
    const elapsed = t - last;
    if (elapsed <= 0) return;
    const gained = Math.floor((elapsed * capacity) / intervalMs);
    if (gained > 0) {
      tokens = Math.min(capacity, tokens + gained);
      last += Math.floor((gained * intervalMs) / capacity);
    }
  };
  return {
    async take(n = 1): Promise<void> {
      const want = Math.max(1, Math.min(n, capacity));
      for (;;) {
        refill();
        if (tokens >= want) {
          tokens -= want;
          return;
        }
        await sleep(Math.max(1, Math.ceil(((want - tokens) * intervalMs) / capacity)));
      }
    },
    available(): number {
      refill();
      return tokens;
    },
  };
}

// ---------------------------------------------------------------------------
// 默认 JOBS（详设 §8.6）
// ---------------------------------------------------------------------------

function backupStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

function pruneBackups(backupsDir: string, keep: number, roots: readonly string[]): number {
  const files = readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, mtime: statSync(path.join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = files.slice(Math.max(1, keep));
  for (const s of stale) safeRemoveFile(path.join(backupsDir, s.f), roots);
  return stale.length;
}

function buildDefaultJobs(
  cfg: Config,
  harvestRun?: () => Promise<unknown> | unknown,
): SchedulerJob[] {
  // 社区周重建的脏检查状态：等价 `startCommunityRunner().runOnce()` 的判据
  // （schema_rev + 活跃边数）。调度器接管周级节奏后不再起 runner 定时器，
  // 但也不能每天 harvest 链都把无变化的图重算一遍；记"跑完后的 schema_rev"
  // 是因为社区摘要写库会推高它（同 communityRunner 注释）。
  let communityLastRev: number | null = null;
  let communityLastEdgeCount: number | null = null;

  return [
    {
      name: 'backup',
      cron: `0 ${cfg.storage.backup_hour} * * *`,
      priority: 5,
      async run({ db, cfg: c, now }) {
        const paths = dataPaths(c);
        safeEnsureDir(paths.backups, [paths.root]);
        const file = path.join(paths.backups, `moshi-${backupStamp(now)}.db`);
        await db.backup(file);
        const removed = pruneBackups(paths.backups, c.storage.backup_keep, [paths.backups, paths.root]);
        return { file, removed };
      },
    },
    {
      name: 'harvest',
      cron: cfg.ingest.harvest_cron,
      priority: 10,
      async run({ db, cfg: c }) {
        const res =
          harvestRun !== undefined
            ? await harvestRun()
            : await harvest(db, { batchSize: c.ingest.harvest_batch, maxBatches: 8 });
        // 详设 §8.6：meta.last_harvest_at 必须更新，/api/diag 与首次引导页都读它
        setMeta(db, 'last_harvest_at', nowIso());
        return res;
      },
    },
    {
      name: 'consolidate',
      after: 'harvest',
      priority: 20,
      async run({ db, cfg: c }) {
        return consolidate(db, { maxContentBytes: c.ingest.max_fact_bytes });
      },
    },
    {
      name: 'infer',
      after: 'consolidate',
      priority: 30,
      async run({ db }) {
        return runSchemaInfer(db);
      },
    },
    {
      name: 'export',
      cron: cfg.archive.export_cron,
      priority: 40,
      async run({ db, cfg: c }) {
        const paths = dataPaths(c);
        const roots = [c.storage.archive_dir, paths.root];
        const res = archiveAll(db, { archiveDir: c.storage.archive_dir, roots });
        const ledger = writeArchiveLedger(db, { archiveDir: c.storage.archive_dir, roots });
        return { docs: res.docs.length, written: res.written, proposed: res.proposed, ledger: ledger.path };
      },
    },
    {
      name: 'layout',
      after: 'export',
      priority: 50,
      async run({ db, cfg: c }) {
        if (!c.layout.enabled) return { skipped: 'layout-disabled' };
        if (countUnlaidFacts(db) === 0) return { skipped: 'up-to-date' };
        return runLayoutJob({ db, cfg: c });
      },
    },
    {
      // 社区周重建（P2-19A）：独立周级 cron 是兜底触发点；after:'infer' 把
      // 它挂进 harvest 链尾，保证「schema/事实先更新、社区后重建」且只触发一次。
      // 日常链路是否真重算由下面的脏检查决定，无变化的图直接跳过。
      name: 'community',
      cron: '0 5 * * 0',
      after: 'infer',
      priority: 60,
      async run({ db }) {
        const rev = schemaRev(db);
        const edgeCount = countEdges(db, true);
        if (communityLastRev === rev && communityLastEdgeCount === edgeCount) {
          return { skipped: 'up-to-date' };
        }
        const result = runCommunityOnce(db);
        // 摘要写入会推高 schema_rev，必须记跑完后的值（否则下一轮空转）
        communityLastRev = schemaRev(db);
        communityLastEdgeCount = edgeCount;
        return result;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 调度器
// ---------------------------------------------------------------------------

const TIMEOUT = Symbol('timeout');

export function startScheduler(opts: SchedulerOptions): Scheduler {
  const { db, cfg, log } = opts;
  const jobs = new Map<string, SchedulerJob>();
  for (const job of opts.jobs ?? buildDefaultJobs(cfg, opts.harvest)) jobs.set(job.name, job);
  const specs = new Map<string, CronSpec>();
  for (const job of jobs.values()) {
    if (job.cron !== undefined) specs.set(job.name, parseCron(job.cron));
  }

  const clock = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const limiter = createRateLimiter({ capacity: RATE_LIMIT_PER_SECOND, intervalMs: 1000 });
  const state: SchedulerState = { running: null, queued: 0, runs: 0, lastMinute: null, lastRuns: {} };
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastCollectAt = 0;

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    state.queued += 1;
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    void next.finally(() => {
      state.queued = Math.max(0, state.queued - 1);
    });
    return next;
  };

  const runOne = async (name: string, now: Date): Promise<JobRunResult> => {
    const job = jobs.get(name);
    const startedAt = Date.now();
    if (job === undefined) {
      return { name, status: 'failed', ms: 0, error: 'unknown job' };
    }
    if (stopped) return { name, status: 'skipped', ms: 0 };
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeout.unref?.();
    state.running = name;
    log.info({ event: 'scheduler.job.start', job: name, at: nowIso() }, `scheduler job ${name} start`);
    let status: JobRunResult['status'] = 'ok';
    let error: string | undefined;
    try {
      const ctx: JobContext = {
        db,
        cfg,
        log,
        now,
        signal: controller.signal,
        throttle: (items = 1) => limiter.take(items),
      };
      const running = job.run(ctx);
      const result = await Promise.race([
        running.then(() => 'done' as const),
        new Promise<typeof TIMEOUT>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(TIMEOUT), { once: true });
        }),
      ]);
      if (result === TIMEOUT || timedOut) {
        status = 'timeout';
        log.warn(
          { event: 'scheduler.job.timeout', job: name, timeout_ms: timeoutMs },
          `scheduler job ${name} timed out`,
        );
        void running.catch(() => undefined);
      } else {
        log.info(
          { event: 'scheduler.job.done', job: name, ms: Date.now() - startedAt },
          `scheduler job ${name} done`,
        );
      }
    } catch (err) {
      status = 'failed';
      error = (err as Error).message;
      log.error(
        { event: 'scheduler.job.failed', job: name, err: error, ms: Date.now() - startedAt },
        `scheduler job ${name} failed`,
      );
    } finally {
      clearTimeout(timeout);
      state.running = null;
      state.runs += 1;
      // 片间让出：任务之间不连续占住事件循环（详设 §8.6 不抢占）
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const result: JobRunResult = { name, status, ms: Date.now() - startedAt, ...(error === undefined ? {} : { error }) };
    state.lastRuns[name] = result;
    return result;
  };

  const dueNames = (now: Date): string[] => {
    const due = new Set<string>();
    for (const [name, spec] of specs) {
      if (cronMatches(spec, now)) due.add(name);
    }
    // 依赖链：父任务在本轮出现时，把 after 它的任务一并带进来（按优先级升序执行）
    let added = true;
    while (added) {
      added = false;
      for (const job of jobs.values()) {
        if (job.after !== undefined && due.has(job.after) && !due.has(job.name)) {
          due.add(job.name);
          added = true;
        }
      }
    }
    return [...due].sort((a, b) => (jobs.get(a)!.priority - jobs.get(b)!.priority) || a.localeCompare(b));
  };

  const collectDue = (now: Date): boolean => {
    if (opts.collect === undefined || !cfg.collect.enabled) return false;
    if (cfg.collect.interval_ms <= 0) return false;
    return now.getTime() - lastCollectAt >= cfg.collect.interval_ms;
  };

  const runDue = (now: Date = clock()): Promise<JobRunResult[]> => {
    if (stopped) return Promise.resolve([]);
    const minute = Math.floor(now.getTime() / 60_000);
    if (state.lastMinute === minute) return Promise.resolve([]);
    state.lastMinute = minute;
    const names = dueNames(now);
    const collect = collectDue(now);
    if (collect) lastCollectAt = now.getTime();
    if (names.length === 0 && !collect) return Promise.resolve([]);
    return enqueue(async () => {
      const out: JobRunResult[] = [];
      for (const name of names) out.push(await runOne(name, now));
      if (collect) {
        out.push(await runCollect());
      }
      return out;
    });
  };

  const runCollect = async (): Promise<JobRunResult> => {
    const startedAt = Date.now();
    state.running = 'collect';
    log.info({ event: 'scheduler.job.start', job: 'collect', at: nowIso() }, 'scheduler job collect start');
    try {
      await opts.collect!();
      log.info(
        { event: 'scheduler.job.done', job: 'collect', ms: Date.now() - startedAt },
        'scheduler job collect done',
      );
      const res: JobRunResult = { name: 'collect', status: 'ok', ms: Date.now() - startedAt };
      state.lastRuns.collect = res;
      return res;
    } catch (err) {
      log.error(
        { event: 'scheduler.job.failed', job: 'collect', err: (err as Error).message },
        'scheduler job collect failed',
      );
      const res: JobRunResult = {
        name: 'collect',
        status: 'failed',
        ms: Date.now() - startedAt,
        error: (err as Error).message,
      };
      state.lastRuns.collect = res;
      return res;
    } finally {
      state.running = null;
      state.runs += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const timerMs = opts.timerMs ?? SCHEDULER_TICK_MS;
  if (timerMs > 0) {
    timer = setInterval(() => {
      void runDue(clock());
    }, timerMs);
    // daemon 靠 main.ts 的保活定时器撑着，调度器定时器不阻止测试进程退出
    timer.unref();
  }
  lastCollectAt = clock().getTime();

  return {
    runDue,
    runJob: (name: string) => enqueue(() => runOne(name, clock())),
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
    state(): SchedulerState {
      return { ...state, lastRuns: { ...state.lastRuns } };
    },
  };
}
