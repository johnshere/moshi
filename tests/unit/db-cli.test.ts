/**
 * P2-08 `moshi db rebuild-strength [--dry-run]`（详设 §8.1 末段）。
 *
 * 验收点：
 * - 全表重算口径可手算（changed 与手算值一致）；
 * - **幂等**：再跑一次 changed = 0（重算不是「再衰减一次」）；
 * - 失效事实强度归 0、行数不变（追加式收口，永不物理删除）；
 * - `--dry-run` 一列都不写；
 * - 未知/缺少子命令退出码 2。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, runCli } from '../../src/app/cli/index.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../fixtures/factories.js';

const DAY = 864e5;

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 假 home：`<home>/.moshi/config.toml` 指向 `<home>/.moshi` 作为 data_dir */
function fakeHome(): { home: string; dataDir: string; dbFile: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'moshi-db-'));
  dirs.push(home);
  const dataDir = path.join(home, '.moshi');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'config.toml'),
    `[storage]\ndata_dir = "${dataDir.replace(/\\/g, '/')}"\n`,
    'utf8',
  );
  return { home, dataDir, dbFile: path.join(dataDir, 'moshi.db') };
}

function withDb(dbFile: string, fn: (db: Db) => void): void {
  const { db } = openDb({ file: dbFile });
  try {
    migrate(db, { backupsDir: path.join(path.dirname(dbFile), 'backups') });
    fn(db);
  } finally {
    closeDb(db);
  }
}

interface CliRun {
  code: number;
  out: string;
  err: string;
}

async function cli(home: string, args: readonly string[]): Promise<CliRun> {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    home,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

describe('cli 注册', () => {
  it('db 命令在 COMMANDS 里（--help 自动带出）', () => {
    expect(COMMANDS.some((c) => c.name === 'db')).toBe(true);
  });
});

describe('db rebuild-strength', () => {
  it('changed 与手算一致（2 条历史 + 1 条失效 → 3），第二次 changed=0', async () => {
    const { home, dbFile } = fakeHome();
    const now = Date.now();
    withDb(dbFile, (db) => {
      // 14 天前衰减过：0.5 → 0.25，必写
      insertFact(db, {
        strength: 0.5,
        lastDecayAt: new Date(now - 14 * DAY).toISOString(),
      });
      // 1 天前衰减过：0.5 → 0.4758，必写
      insertFact(db, {
        strength: 0.5,
        predicate: 'install',
        lastDecayAt: new Date(now - DAY).toISOString(),
      });
      // 失效事实：不管多新，算出来都是 0，必写
      insertFact(db, {
        strength: 0.9,
        predicate: 'port',
        validAt: new Date(now - DAY).toISOString(),
        validTo: new Date(now + DAY).toISOString(),
      });
      // 刚刚衰减过：Δ ≈ 0，不写
      insertFact(db, { strength: 0.5 });
    });

    const first = await cli(home, ['db', 'rebuild-strength']);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.out.trim()) as {
      command: string;
      scanned: number;
      changed: number;
      dry_run: boolean;
    };
    expect(payload).toEqual({
      command: 'db rebuild-strength',
      scanned: 4,
      changed: 3,
      dry_run: false,
    });

    // 幂等：同一天再跑，所有行都已是最新值
    const second = await cli(home, ['db', 'rebuild-strength']);
    expect(second.code).toBe(0);
    const again = JSON.parse(second.out.trim()) as { scanned: number; changed: number };
    expect(again.scanned).toBe(4);
    expect(again.changed).toBe(0);
  });

  it('失效事实强度归 0，行数不变', async () => {
    const { home, dbFile } = fakeHome();
    const now = Date.now();
    let invalidId = '';
    withDb(dbFile, (db) => {
      invalidId = insertFact(db, {
        strength: 0.9,
        validAt: new Date(now - DAY).toISOString(),
        validTo: new Date(now + DAY).toISOString(),
      });
    });

    expect((await cli(home, ['db', 'rebuild-strength'])).code).toBe(0);

    withDb(dbFile, (db) => {
      expect(factRepo.countFacts(db)).toBe(1);
      expect(factRepo.getFact(db, invalidId)?.strength).toBe(0);
    });
  });

  it('--dry-run 只统计不写库', async () => {
    const { home, dbFile } = fakeHome();
    const now = Date.now();
    let staleId = '';
    withDb(dbFile, (db) => {
      staleId = insertFact(db, {
        strength: 0.5,
        lastDecayAt: new Date(now - 14 * DAY).toISOString(),
      });
    });

    const run = await cli(home, ['db', 'rebuild-strength', '--dry-run']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out.trim())).toEqual({
      command: 'db rebuild-strength',
      scanned: 1,
      changed: 1,
      dry_run: true,
    });

    withDb(dbFile, (db) => {
      expect(factRepo.getFact(db, staleId)?.strength).toBe(0.5); // 没被写
    });
  });

  it('无子命令 / 未知子命令 → usage + 退出码 2', async () => {
    const { home } = fakeHome();

    const missing = await cli(home, ['db']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('rebuild-strength');

    const unknown = await cli(home, ['db', 'vacuum']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('rebuild-strength');

    const badFlag = await cli(home, ['db', 'rebuild-strength', '--force']);
    expect(badFlag.code).toBe(2);
    expect(badFlag.err).toContain('rebuild-strength');
  });
});
