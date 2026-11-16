/**
 * 撞锁重试（V-07B）：daemon 与导入子进程同时写同一个库时的让锁逻辑。
 *
 * 两类用例：
 * - 假错误：确定性验证次数 / 退避 / 非撞锁立即上抛 —— 真实撞锁的时序没法精确控制；
 * - 真实双连接：临时文件 + 两个 `openDb`，A 持写锁、B 撞锁后经重试转成功。
 *   `:memory:` 不行——每个连接是各自独立的内存库，永远不会互相撞锁。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  isBusyError,
  openDb,
  retryBusyAsync,
  retryBusySync,
  type Db,
} from '../../src/infra/sqlite/db.js';
import { withTransaction } from '../../src/infra/sqlite/tx.js';

/** better-sqlite3 撞锁错误的真实形状：`Error` 上挂 `code`，消息是 `database is locked` */
function busyError(
  code: 'SQLITE_BUSY' | 'SQLITE_BUSY_SNAPSHOT' = 'SQLITE_BUSY',
): Error & { code: string } {
  const err = new Error('database is locked') as Error & { code: string };
  err.code = code;
  return err;
}

/** 测试里退避压到 1ms：验证次数，不验证真实等待 */
const FAST = { baseDelayMs: 1, jitter: 0 } as const;

const cleanups: (() => void)[] = [];
afterEach(() => {
  // 后进先出：`openDb` 的 close 是在 tmpDir 之后登记的，必须先关库再删目录，
  // 否则 Windows 上文件还被句柄占着，rmSync 直接 EPERM。
  for (const fn of cleanups.splice(0).reverse()) fn();
});

/** 清掉临时目录（Windows 上 close 之后再删，否则句柄占用会 EPERM） */
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * 两个连接指向同一个临时库文件：A 当"写锁持有者"（daemon / 导入子进程），B 是被挡的那方。
 * B 的 busy_timeout 缩短到 50ms：测试不想陪它等满正常的 10s。
 */
function openPair(): { a: Db; b: Db } {
  const dir = tmpDir('moshi-busy-');
  const file = path.join(dir, 'moshi.db');
  const a = openDb({ file, loadVector: false }).db;
  const b = openDb({ file, loadVector: false }).db;
  cleanups.push(() => {
    closeDb(a);
    closeDb(b);
  });
  a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  b.pragma('busy_timeout = 50');
  return { a, b };
}

describe('isBusyError', () => {
  it('认得 better-sqlite3 的三种撞锁形状', () => {
    expect(isBusyError(busyError('SQLITE_BUSY'))).toBe(true);
    expect(isBusyError(busyError('SQLITE_BUSY_SNAPSHOT'))).toBe(true);
    expect(isBusyError(new Error('database is locked'))).toBe(true);
  });

  it('普通错误不算撞锁', () => {
    expect(isBusyError(new Error('UNIQUE constraint failed: fact.id'))).toBe(false);
    expect(isBusyError({ code: 'SQLITE_ERROR', message: 'no such table: fact' })).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError('database is locked')).toBe(false);
  });
});

describe('retryBusySync', () => {
  it('撞锁后重试，成功即返回', () => {
    let calls = 0;
    const value = retryBusySync(
      () => {
        calls += 1;
        if (calls < 3) throw busyError();
        return 'ok';
      },
      { ...FAST, attempts: 5 },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('非撞锁错误立即上抛，一次都不重试', () => {
    let calls = 0;
    expect(() =>
      retryBusySync(() => {
        calls += 1;
        throw new Error('boom');
      }, FAST),
    ).toThrow('boom');
    expect(calls).toBe(1);
  });

  it('超过尝试上限抛最后一次的原错误', () => {
    let calls = 0;
    const error = busyError('SQLITE_BUSY_SNAPSHOT');
    try {
      retryBusySync(
        () => {
          calls += 1;
          throw error;
        },
        { ...FAST, attempts: 3 },
      );
      expect.unreachable('应当抛出撞锁错误');
    } catch (err) {
      expect(err).toBe(error);
    }
    expect(calls).toBe(3);
  });
});

describe('retryBusyAsync', () => {
  it('撞锁后重试，成功即返回', async () => {
    let calls = 0;
    const value = await retryBusyAsync(
      () => {
        calls += 1;
        if (calls < 3) throw busyError();
        return 'ok';
      },
      { ...FAST, attempts: 5 },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('非撞锁错误立即上抛', async () => {
    let calls = 0;
    await expect(
      retryBusyAsync(() => {
        calls += 1;
        throw new Error('boom');
      }, FAST),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('超过尝试上限抛原错误', async () => {
    let calls = 0;
    await expect(
      retryBusyAsync(
        () => {
          calls += 1;
          throw busyError();
        },
        { ...FAST, attempts: 2 },
      ),
    ).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(calls).toBe(2);
  });

  it('退避期间事件循环不被阻塞（daemon 还能接别的请求）', async () => {
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 5);
    let calls = 0;
    const value = await retryBusyAsync(
      () => {
        calls += 1;
        if (calls < 2) throw busyError();
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 30, jitter: 0 },
    );
    clearTimeout(timer);
    expect(value).toBe('ok');
    expect(ticked).toBe(true);
  });
});

describe('真实双连接：写锁被占时的重试', () => {
  it('busy_timeout 提到 10s', () => {
    const dir = tmpDir('moshi-busy-pragma-');
    const { db } = openDb({ file: path.join(dir, 'moshi.db'), loadVector: false });
    cleanups.push(() => closeDb(db));
    expect(db.pragma('busy_timeout', { simple: true })).toBe(10_000);
  });

  it('撞锁 → 识别为 BUSY → 锁释放后 retryBusySync 写入成功', () => {
    const { a, b } = openPair();
    a.exec('BEGIN IMMEDIATE');
    a.prepare('INSERT INTO t (v) VALUES (?)').run('a');

    let caught: unknown;
    try {
      b.prepare('INSERT INTO t (v) VALUES (?)').run('b');
    } catch (err) {
      caught = err;
    }
    expect(isBusyError(caught)).toBe(true);

    a.exec('COMMIT');

    const info = retryBusySync(() => b.prepare('INSERT INTO t (v) VALUES (?)').run('b'), FAST);
    expect(info.changes).toBe(1);
    expect(b.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([{ v: 'a' }, { v: 'b' }]);
  });

  it('withTransaction 持锁期间重试到上限后上抛，锁释放后整笔重来成功', () => {
    const { a, b } = openPair();
    // 每次尝试的 busy_timeout 压到 10ms，避免这条用例等满默认的 10s×5
    b.pragma('busy_timeout = 10');
    a.exec('BEGIN IMMEDIATE');
    a.prepare('INSERT INTO t (v) VALUES (?)').run('hold');

    expect(() =>
      withTransaction(b, () => {
        b.prepare('INSERT INTO t (v) VALUES (?)').run('blocked');
      }),
    ).toThrow(/database is locked/);

    a.exec('COMMIT');

    const out = withTransaction(b, () => {
      const info = b.prepare('INSERT INTO t (v) VALUES (?)').run('after');
      return info.changes;
    });
    expect(out).toBe(1);
    expect(b.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([
      { v: 'hold' },
      { v: 'after' },
    ]);
  });

  it('锁在 120ms 后由另一个回调释放：retryBusyAsync 包住整笔事务后写入成功', async () => {
    const { a, b } = openPair();
    a.exec('BEGIN IMMEDIATE');
    a.prepare('INSERT INTO t (v) VALUES (?)').run('hold');

    // 注意：retryBusySync 用 Atomics.wait 睡，睡的时候定时器不会触发；
    // 这段"定时释放 + 重试"的时序只能在异步重试（setTimeout 退避）下验证。
    const release = setTimeout(() => {
      a.exec('COMMIT');
    }, 120);

    const out = await retryBusyAsync(
      () =>
        withTransaction(b, () => b.prepare('INSERT INTO t (v) VALUES (?)').run('async')),
      { attempts: 6, baseDelayMs: 40, jitter: 0 },
    );
    clearTimeout(release);

    expect(out.changes).toBe(1);
    expect(b.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([
      { v: 'hold' },
      { v: 'async' },
    ]);
  });
});
