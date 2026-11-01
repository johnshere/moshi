/**
 * 启动序列与实例生命周期（详设 §3.4 / 概设 §11.5）。
 *
 * 顺序是有讲究的：
 *   读配置 → 建目录 → 抢锁（独占创建）→ 探测端口 → 绑定 → 回写锁 → 起服务
 * 抢锁必须在绑端口之前：两个进程同时从 53000 起探，各自都能绑到不同端口，
 * 只靠端口无法互斥。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { MoshiError } from '../domain/errors.js';
import { dataPaths, type Config } from './config.js';
import {
  createLockExclusive,
  inspectLock,
  isPortOpen,
  removeLock,
  writeLock,
  type LockInfo,
} from './lock.js';

export const VERSION = '0.1.0';

export interface DataPaths {
  root: string;
  db: string;
  logs: string;
  tmp: string;
  lock: string;
  cursors: string;
  backups: string;
}

/** 只建必需目录；`archive_dir` 不建——它可能在 U 盘/未挂载卷上，导出时才创建 */
export function ensureDataDirs(cfg: Config): DataPaths {
  const paths = dataPaths(cfg);
  for (const dir of [paths.root, paths.logs, paths.tmp, paths.backups]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export async function findFreePort(host: string, start: number, max: number): Promise<number> {
  for (let port = start; port <= max; port += 1) {
    // eslint-disable-next-line no-await-in-loop -- 必须顺序探测，先到先得
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
  /** 绑定端口的服务；P0-18 换成 Fastify。默认给一个只回 404 的裸 server */
  serverFactory?: (port: number) => http.Server;
  /** 注入锁文件路径（测试用） */
  lockFile?: string;
  version?: string;
}

export interface Instance {
  port: number;
  token: string;
  paths: DataPaths;
  server: http.Server;
  close: () => Promise<void>;
}

const defaultServerFactory = (_port: number): http.Server =>
  http.createServer((_req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end('{"error":"E_NOT_FOUND"}');
  });

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
  if (state.kind === 'stale') removeLock(lockFile);

  const token = randomBytes(24).toString('base64url');
  const pending: LockInfo = {
    pid: process.pid,
    port: 0,
    token,
    started_at: new Date().toISOString(),
    version,
  };

  if (!createLockExclusive(lockFile, pending)) {
    // 抢锁失败：要么别人刚起来（活），要么刚退出留下坏锁（死）
    const again = await inspectLock(lockFile, cfg.server.host);
    if (again.kind === 'live') throw new AlreadyRunningError(again.info);
    removeLock(lockFile);
    if (!createLockExclusive(lockFile, pending)) {
      throw new MoshiError('E_BUSY', `抢不到实例锁：${lockFile}`, { lockFile });
    }
  }

  const factory = opts.serverFactory ?? defaultServerFactory;
  let port = 0;
  let server: http.Server | null = null;
  try {
    port = await findFreePort(cfg.server.host, cfg.server.port, cfg.server.port_scan_max);
    server = factory(port);
    await listen(server, cfg.server.host, port);
  } catch (err) {
    removeLock(lockFile);
    throw err instanceof MoshiError
      ? err
      : new MoshiError('E_CONFIG', `启动失败：${(err as Error).message}`, {
          cause: (err as Error).message,
        });
  }

  writeLock(lockFile, { ...pending, port });

  const bound = server;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      bound.close(() => resolve());
      bound.closeAllConnections?.();
    });
    removeLock(lockFile);
  };

  return { port, token, paths, server: bound, close };
}
