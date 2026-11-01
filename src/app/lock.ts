/**
 * 单实例锁（概设 §1.1 第 3 条 / §1.4）。
 *
 * 锁文件 `~/.moshi/daemon.lock` 同时承担两个职责：
 * 1. 单实例互斥——第二个实例看到活锁就退出 0，不报错；
 * 2. 端口发现——UI 从锁文件读实际端口，不写死。
 *
 * 陈旧锁判定：pid 不存在 **或** 端口连不上。两条都要，因为进程可能被强杀
 * （pid 复用）也可能卡死（进程在、端口没监听）。
 */
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import net from 'node:net';

export interface LockInfo {
  pid: number;
  port: number;
  token: string;
  started_at: string;
  version: string;
}

export type LockState =
  | { kind: 'absent' }
  | { kind: 'stale'; info: LockInfo | null; reason: string }
  | { kind: 'live'; info: LockInfo };

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但没权限发信号（Windows 上常见），仍算活着
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isPortOpen(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export function readLock(file: string): LockInfo | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(text) as Partial<LockInfo>;
    if (typeof obj.pid !== 'number' || typeof obj.port !== 'number') return null;
    return {
      pid: obj.pid,
      port: obj.port,
      token: typeof obj.token === 'string' ? obj.token : '',
      started_at: typeof obj.started_at === 'string' ? obj.started_at : '',
      version: typeof obj.version === 'string' ? obj.version : '',
    };
  } catch {
    return null;
  }
}

/** 原子写：先写 .tmp 再 rename，避免读到半个 JSON */
export function writeLock(file: string, info: LockInfo): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(info, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * 独占创建锁文件。成功返回 true；已存在返回 false。
 * 用 `wx` 而不是「先检查再写」——后者在两个进程同时启动时会双双通过。
 */
export function createLockExclusive(file: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, `${JSON.stringify(info, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function removeLock(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // 不存在即已达成目的
  }
}

export async function inspectLock(file: string, host: string): Promise<LockState> {
  const info = readLock(file);
  if (info === null) {
    // 文件存在但读不出来 = 坏锁；文件不存在也走这里
    let exists = true;
    try {
      readFileSync(file);
    } catch {
      exists = false;
    }
    return exists ? { kind: 'stale', info: null, reason: '锁文件损坏' } : { kind: 'absent' };
  }
  if (!isProcessAlive(info.pid)) {
    return { kind: 'stale', info, reason: `pid ${info.pid} 不存在` };
  }
  if (info.port > 0 && !(await isPortOpen(host, info.port))) {
    return { kind: 'stale', info, reason: `pid ${info.pid} 在但端口 ${info.port} 连不上` };
  }
  return { kind: 'live', info };
}
