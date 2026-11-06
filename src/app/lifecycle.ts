/**
 * 启动序列与实例生命周期（详设 §3.4 / 概设 §11.5）。
 *
 * 顺序是有讲究的：
 *   读配置 → 建目录 → 抢锁（独占创建）→ 探测端口 → 绑定 → 回写锁 → 起服务
 * 抢锁必须在绑端口之前：两个进程同时从 53000 起探，各自都能绑到不同端口，
 * 只靠端口无法互斥。
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { MoshiError } from '../domain/errors.js';
import { safeEnsureDir } from '../infra/fs/safeWrite.js';
import { closeDb, openDb, type Db } from '../infra/sqlite/db.js';
import { migrate, type MigrateResult } from '../infra/sqlite/migrate.js';
import { dataPaths, type Config } from './config.js';
import {
  createLockExclusive,
  inspectLock,
  isPortOpen,
  removeLock,
  writeLock,
  type LockInfo,
} from './lock.js';
import { VERSION } from './version.js';

export { VERSION };

export interface DataPaths {
  root: string;
  db: string;
  logs: string;
  tmp: string;
  lock: string;
  cursors: string;
  importCursors: string;
  collectCursors: string;
  backups: string;
  goldenDir: string;
}

/** 只建必需目录；`archive_dir` 不建——它可能在 U 盘/未挂载卷上，导出时才创建 */
export function ensureDataDirs(cfg: Config): DataPaths {
  const paths = dataPaths(cfg);
  const dirs = [paths.root, paths.logs, paths.tmp, paths.backups];
  // goldenDir 跟着 eval.golden_set 走（P3-A8）：在 data_dir 之内就代建；
  // 被显式配到 data_dir 之外时由用户/seed 自己保证（不越过 safeEnsureDir 的根）
  const rel = path.relative(paths.root, paths.goldenDir);
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) dirs.push(paths.goldenDir);
  for (const dir of dirs) {
    safeEnsureDir(dir, [paths.root]);
  }
  return paths;
}

export async function findFreePort(host: string, start: number, max: number): Promise<number> {
  for (let port = start; port <= max; port += 1) {
    // 必须顺序探测：先到先得，不能并发抢同一个端口
    if (!(await isPortOpen(host, port))) return port;
  }
  throw new MoshiError(
    'E_CONFIG',
    `端口 ${start}–${max} 全部被占用，无法启动（改 server.port / port_scan_max）`,
  );
}

export class AlreadyRunningError extends Error {
  constructor(readonly info: LockInfo) {
    super(`已在运行（pid=${info.pid}, port=${info.port}）`);
    this.name = 'AlreadyRunningError';
  }
}

export interface BootOptions {
  /** 绑定端口的服务；测试用。默认见 `defaultServerFactory` / `handlerFactory` */
  serverFactory?: (port: number) => http.Server;
  /**
   * 路由处理器工厂：拿到已经打开的 db 与 token 后返回一个 listener 或已创建的 server。
   * `boot` 内部才知道端口与 db，所以 MCP/REST 的接线只能从这里进去——
   * 否则 `main.ts` 要自己再开一次库。
   * 返回 `http.Server` 时（如 Fastify），boot 会直接用它 listen；
   * 返回 `RequestListener` 时，boot 会包成 `http.createServer(listener)`。
   * 支持 async：Fastify 需要 `await app.ready()` 后才能交出 server。
   */
  handlerFactory?: (deps: { db: Db; cfg: Config; token: string }) =>
    | Promise<http.RequestListener | http.Server>
    | http.RequestListener
    | http.Server;
  /** 注入锁文件路径（测试用） */
  lockFile?: string;
  version?: string;
}

export interface Instance {
  port: number;
  token: string;
  paths: DataPaths;
  server: http.Server;
  db: Db;
  migration: MigrateResult;
  vectorEnabled: boolean;
  close: () => Promise<void>;
}

const defaultServerFactory = (_port: number): http.Server =>
  http.createServer((_req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end('{"error":"E_NOT_FOUND"}');
  });

/** 有 `handlerFactory` 就用它，否则退回"只回 404"的裸 server（P0-04 的默认行为） */
async function makeFactory(
  handlerFactory: BootOptions['handlerFactory'],
  deps: { db: Db; cfg: Config; token: string },
): Promise<(port: number) => http.Server> {
  if (handlerFactory === undefined) return defaultServerFactory;
  const result = await handlerFactory(deps);
  if (result instanceof http.Server) {
    return (_port: number) => result;
  }
  return (_port: number) => http.createServer(result);
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function boot(cfg: Config, opts: BootOptions = {}): Promise<Instance> {
  const paths = ensureDataDirs(cfg);
  const lockFile = opts.lockFile ?? paths.lock;
  const version = opts.version ?? VERSION;

  const state = await inspectLock(lockFile, cfg.server.host);
  if (state.kind === 'live') throw new AlreadyRunningError(state.info);
  if (state.kind === 'stale') removeLock(lockFile, [paths.root]);

  // 第 4 步：打开 DB + PRAGMA + 迁移（详设 §3.4）
  const opened = openDb({ file: paths.db });
  const db = opened.db;
  let migration: MigrateResult;
  try {
    migration = migrate(db, { backupsDir: paths.backups, vectorEnabled: opened.vectorEnabled });
  } catch (err) {
    closeDb(db);
    removeLock(lockFile, [paths.root]);
    throw err;
  }

  const token = randomBytes(24).toString('base64url');
  const pending: LockInfo = {
    pid: process.pid,
    port: 0,
    token,
    started_at: new Date().toISOString(),
    version,
  };

  if (!createLockExclusive(lockFile, pending, [paths.root])) {
    // 抢锁失败：要么别人刚起来（活），要么刚退出留下坏锁（死）
    const again = await inspectLock(lockFile, cfg.server.host);
    if (again.kind === 'live') throw new AlreadyRunningError(again.info);
    removeLock(lockFile, [paths.root]);
    if (!createLockExclusive(lockFile, pending, [paths.root])) {
      throw new MoshiError('E_BUSY', `抢不到实例锁：${lockFile}`, { lockFile });
    }
  }

  const factory = opts.serverFactory ?? (await makeFactory(opts.handlerFactory, { db, cfg, token }));
  let port = 0;
  let server: http.Server | null = null;
  try {
    port = await findFreePort(cfg.server.host, cfg.server.port, cfg.server.port_scan_max);
    server = factory(port);
    await listen(server, cfg.server.host, port);
  } catch (err) {
    closeDb(db);
    removeLock(lockFile, [paths.root]);
    throw err instanceof MoshiError
      ? err
      : new MoshiError('E_CONFIG', `启动失败：${(err as Error).message}`, {
          cause: (err as Error).message,
        });
  }

  writeLock(lockFile, { ...pending, port }, [paths.root]);

  const bound = server;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      bound.close(() => resolve());
      bound.closeAllConnections?.();
    });
    closeDb(db);
    removeLock(lockFile, [paths.root]);
  };

  return {
    port,
    token,
    paths,
    server: bound,
    db,
    migration,
    vectorEnabled: migration.vectorEnabled,
    close,
  };
}
