/**
 * SQLite 连接（详设 §2.2 第 0 段 / §3.5）。
 *
 * PRAGMA 在**每次打开连接**时都要设，不能写进 DDL——迁移脚本只在建库时跑一次，
 * 而 PRAGMA 是连接级的。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { MoshiError } from '../../domain/errors.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** 数据库文件路径，或 ':memory:' */
  file: string;
  /** 只读打开（doctor / 导出用） */
  readonly?: boolean;
  /** 是否尝试加载 sqlite-vec；默认 true */
  loadVector?: boolean;
}

export interface OpenResult {
  db: Db;
  /** sqlite-vec 是否可用 */
  vectorEnabled: boolean;
}

/** sqlite-vec 是可选依赖：没装或平台无二进制都不该让整个库打不开 */
function tryLoadVector(db: Db): boolean {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('sqlite-vec') as {
      load?: (d: Db) => void;
      getLoadablePath?: () => string;
    };
    if (typeof mod.load === 'function') {
      mod.load(db);
      return true;
    }
    if (typeof mod.getLoadablePath === 'function') {
      db.loadExtension(mod.getLoadablePath());
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function openDb(opts: OpenOptions): OpenResult {
  if (opts.file !== ':memory:') {
    mkdirSync(path.dirname(opts.file), { recursive: true });
  }

  let db: Db;
  try {
    db = new Database(opts.file, { readonly: opts.readonly ?? false });
  } catch (err) {
    throw new MoshiError('E_DB', `打不开数据库：${opts.file}`, { cause: (err as Error).message });
  }

  // 顺序有讲究：busy_timeout 要最先设，否则后面任何锁冲突都会立刻抛 SQLITE_BUSY。
  // 10s 而不是 5s：daemon 与导入子进程会同时写同一个文件（WAL 下写者互斥），
  // 导入一批是几百条事实的事务，5s 不够它跑完；等满 10s 仍拿不到锁才交给重试层。
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  if (opts.readonly !== true) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }

  const vectorEnabled = opts.loadVector === false ? false : tryLoadVector(db);
  return { db, vectorEnabled };
}

export function closeDb(db: Db): void {
  if (db.open) db.close();
}

/**
 * 撞锁识别：`busy_timeout` 等满之后 better-sqlite3 抛的就是这些。
 *
 * - `SQLITE_BUSY`：写锁被别的连接/进程拿着；
 * - `SQLITE_BUSY_SNAPSHOT`：WAL 下本事务读到的快照已过期（**只能整笔重来**）；
 * - 老版本/未带 code 的路径只剩消息，认 `database is locked`。
 */
export function isBusyError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return true;
  return typeof message === 'string' && message.includes('database is locked');
}

export interface RetryBusyOptions {
  /** 总尝试次数（含第一次），默认 5 */
  attempts?: number;
  /** 首次退避毫秒，之后每次翻倍，默认 40 */
  baseDelayMs?: number;
  /** 单次退避上限毫秒，默认 1000，防止翻倍到"等不起"的量级 */
  maxDelayMs?: number;
  /** 抖动比例（0..1），默认 0.25：错开两个写者的重试时刻，否则会同步醒过来再撞一次 */
  jitter?: number;
}

const DEFAULT_RETRY: Required<RetryBusyOptions> = {
  attempts: 5,
  baseDelayMs: 40,
  maxDelayMs: 1000,
  jitter: 0.25,
};

/** 第 `attempt` 次失败后的退避：指数翻倍 + 抖动 */
function backoffDelay(attempt: number, o: Required<RetryBusyOptions>): number {
  const base = Math.min(o.baseDelayMs * 2 ** (attempt - 1), o.maxDelayMs);
  const spread = base * o.jitter;
  return Math.max(1, Math.round(base - spread + Math.random() * spread * 2));
}

function withDefaults(opts: RetryBusyOptions): Required<RetryBusyOptions> {
  return { ...DEFAULT_RETRY, ...opts };
}

/**
 * 同步睡眠：`Atomics.wait` 不占 CPU，也不需要事件循环。
 * **事件循环里别用它**——那会让所有请求一起停住，那种场景用 `retryBusyAsync`。
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 外层是否已经在做异步重试。为 true 时内层同步重试直接放行、把错误交给外层：
 * 否则一次撞锁会退化成 5×5 次**阻塞**重试，把 daemon 的事件循环整块焊住。
 */
let asyncRetryDepth = 0;

/**
 * 撞锁重试（同步场景：CLI、导入子进程、同步事务）。
 *
 * `fn` 必须是**可以整体重来**的一段，典型就是整笔事务（`withTransaction` 已经这么用）。
 * **不要**把它套在已经打开的事务内部去重试单条语句：事务内撞锁是快照冲突
 * （读到的版本已经过期），重试那一条只会基于旧快照继续写，必须整笔回滚重来。
 */
export function retryBusySync<T>(fn: () => T, opts: RetryBusyOptions = {}): T {
  if (asyncRetryDepth > 0) return fn();
  const o = withDefaults(opts);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt >= o.attempts) throw err;
      sleepSync(backoffDelay(attempt, o));
    }
  }
}

/**
 * 撞锁重试（事件循环场景：daemon 的钩子 / MCP 写入）。
 *
 * 与 `retryBusySync` 的次数与退避口径相同，区别是退避走 `setTimeout`——
 * 等锁的时候 daemon 还能接别的请求。被包的 `fn` 里如果又有 `withTransaction`，
 * 内层会因为 `asyncRetryDepth` 而放弃同步重试，由这里负责整笔重来。
 */
export async function retryBusyAsync<T>(
  fn: () => T | Promise<T>,
  opts: RetryBusyOptions = {},
): Promise<T> {
  const o = withDefaults(opts);
  for (let attempt = 1; ; attempt += 1) {
    asyncRetryDepth += 1;
    try {
      return await fn();
    } catch (err) {
      if (!isBusyError(err) || attempt >= o.attempts) throw err;
    } finally {
      asyncRetryDepth -= 1;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, backoffDelay(attempt, o));
    });
  }
}

/** 健康检查用：几个关键能力是否可用 */
export function capabilities(db: Db): { fts5: boolean; json1: boolean; vector: boolean } {
  const check = (sql: string): boolean => {
    try {
      db.prepare(sql).get();
      return true;
    } catch {
      return false;
    }
  };
  return {
    fts5: check("SELECT 1 FROM pragma_module_list WHERE name = 'fts5'"),
    json1: check("SELECT json_valid('{}') AS v"),
    vector: check("SELECT 1 FROM pragma_module_list WHERE name = 'vec0'"),
  };
}
