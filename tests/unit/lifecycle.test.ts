import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/app/config.js';
import { AlreadyRunningError, boot, ensureDataDirs, findFreePort, type Instance } from '../../src/app/lifecycle.js';
import { inspectLock, isPortOpen, readLock, writeLock } from '../../src/app/lock.js';

const opened: Instance[] = [];

afterEach(async () => {
  for (const inst of opened.splice(0)) await inst.close();
});

function makeCfg(): { cfg: Config; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-life-'));
  const file = path.join(dir, 'config.toml');
  writeFileSync(
    file,
    `[storage]\ndata_dir = "${path.join(dir, 'data').replace(/\\/g, '\\\\')}"\n[server]\nport = 53100\nport_scan_max = 53120\n`,
    'utf8',
  );
  return { cfg: loadConfig({ file, home: dir }), dir };
}

describe('数据目录（详设 §3.4 第 2 步）', () => {
  it('建出必需子目录，且不建 archive_dir', () => {
    const { cfg } = makeCfg();
    const paths = ensureDataDirs(cfg);
    expect(existsSync(paths.root)).toBe(true);
    expect(existsSync(paths.logs)).toBe(true);
    expect(existsSync(paths.tmp)).toBe(true);
    expect(existsSync(paths.backups)).toBe(true);
    expect(existsSync(cfg.storage.archive_dir)).toBe(false);
  });
});

describe('端口探测（概设 §1.4）', () => {
  it('跳过被占用端口', async () => {
    const blocker = net.createServer();
    const busy = await findFreePort('127.0.0.1', 53150, 53180);
    await new Promise<void>((r) => blocker.listen(busy, '127.0.0.1', () => r()));
    try {
      const next = await findFreePort('127.0.0.1', busy, 53180);
      expect(next).toBeGreaterThan(busy);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe('单实例锁（概设 §1.1 第 3 条）', () => {
  it('第二个实例拿到 AlreadyRunningError，带 pid 与 port', async () => {
    const { cfg } = makeCfg();
    const first = await boot(cfg);
    opened.push(first);

    const info = readLock(first.paths.lock);
    expect(info).not.toBeNull();
    expect(info?.port).toBe(first.port);
    expect(info?.pid).toBe(process.pid);
    expect(info?.token.length).toBeGreaterThan(20);

    await expect(boot(cfg)).rejects.toBeInstanceOf(AlreadyRunningError);
    try {
      await boot(cfg);
    } catch (err) {
      const e = err as AlreadyRunningError;
      expect(e.message).toContain(`pid=${process.pid}`);
      expect(e.message).toContain(`port=${first.port}`);
    }
  });

  it('关掉第一个之后能接管', async () => {
    const { cfg } = makeCfg();
    const first = await boot(cfg);
    const port = first.port;
    await first.close();
    expect(existsSync(first.paths.lock)).toBe(false);
    expect(await isPortOpen('127.0.0.1', port)).toBe(false);

    const second = await boot(cfg);
    opened.push(second);
    expect(second.port).toBe(port);
  });

  it('陈旧锁：pid 不存在 → 直接接管', async () => {
    const { cfg } = makeCfg();
    const paths = ensureDataDirs(cfg);
    writeLock(paths.lock, {
      pid: 999_999,
      port: 53110,
      token: 'stale',
      started_at: new Date().toISOString(),
      version: '0.1.0',
    });
    expect((await inspectLock(paths.lock, '127.0.0.1')).kind).toBe('stale');

    const inst = await boot(cfg);
    opened.push(inst);
    expect(readLock(paths.lock)?.pid).toBe(process.pid);
  });

  it('陈旧锁：pid 在但端口连不上 → 直接接管', async () => {
    const { cfg } = makeCfg();
    const paths = ensureDataDirs(cfg);
    const dead = net.createServer();
    const deadPort = await findFreePort('127.0.0.1', 53200, 53220);
    await new Promise<void>((r) => dead.listen(deadPort, '127.0.0.1', () => r()));
    await new Promise<void>((r) => dead.close(() => r()));

    writeLock(paths.lock, {
      pid: process.pid, // 自己活着
      port: deadPort, // 但端口已经关了
      token: 'stale',
      started_at: new Date().toISOString(),
      version: '0.1.0',
    });
    expect((await inspectLock(paths.lock, '127.0.0.1')).kind).toBe('stale');

    const inst = await boot(cfg);
    opened.push(inst);
    expect(inst.port).toBeGreaterThan(0);
  });

  it('坏锁文件（半个 JSON）也按陈旧处理', async () => {
    const { cfg } = makeCfg();
    const paths = ensureDataDirs(cfg);
    writeFileSync(paths.lock, '{"pid": 1, "po', 'utf8');
    const inst = await boot(cfg);
    opened.push(inst);
    expect(JSON.parse(readFileSync(paths.lock, 'utf8')).port).toBe(inst.port);
  });
});
