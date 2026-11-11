/**
 * P2-08 `moshi db rebuild-strength [--dry-run]`（详设 §8.1 末段）。
 *
 * 验收点：
 * - 全表重算口径可手算（changed 与手算值一致）；
 * - **幂等**：再跑一次 changed = 0（重算不是「再衰减一次」）；
 * - 失效事实强度归 0、行数不变（追加式收口，永不物理删除）；
 * - `--dry-run` 一列都不写；
 * - 未知/缺少子命令退出码 2。
 *
 * 另含 P2-09 `moshi db consolidate [--dry-run] [--rate n]`：幂等、dry-run 不写库、参数校验。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, runCli } from '../../src/app/cli/index.js';
import { ingestEvent } from '../../src/core/write/ingest.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { migrate, TARGET_VERSION } from '../../src/infra/sqlite/migrate.js';
import { insertEdge, insertFact, makeEntity } from '../fixtures/factories.js';

const DAY = 864e5;

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 假 home：`<home>/.moshi/config.yaml` 指向 `<home>/.moshi` 作为 data_dir */
function fakeHome(): { home: string; dataDir: string; dbFile: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'moshi-db-'));
  dirs.push(home);
  const dataDir = path.join(home, '.moshi');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'config.yaml'),
    `storage:\n  data_dir: "${dataDir.replace(/\\/g, '/')}"\n`,
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

    const unknown = await cli(home, ['db', 'no-such-sub']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('rebuild-strength');

    const badFlag = await cli(home, ['db', 'rebuild-strength', '--force']);
    expect(badFlag.code).toBe(2);
    expect(badFlag.err).toContain('rebuild-strength');
  });
});

/** 同 key 的三条 episodic 观测：工厂的默认 subject 每次都新建实体，这里必须复用同一个 */
function seedEpisodic(db: Db, values: readonly string[]): void {
  const entityId = makeEntity(db, 'svc-cli');
  for (const value of values) {
    insertFact(db, {
      subject: { entity_id: entityId, name: 'node' },
      predicate: 'runtime_state',
      value,
      ftype: 'episodic',
    });
  }
}

function seedProcedure(db: Db): void {
  let second = 0;
  for (const session of ['s1', 's2', 's3']) {
    for (const cmd of ['pnpm install', 'pnpm build', 'pnpm test']) {
      second += 1;
      const ts = new Date(Date.UTC(2026, 10, 4, 0, 0, second)).toISOString();
      ingestEvent(db, {
        ts,
        sessionId: session,
        cwd: '/work/cli',
        agent: 'test',
        rawHash: `${session}:${ts}:${cmd}`,
        rawPath: '/tmp/session.jsonl',
        role: 'tool',
        tool: { name: 'Bash', input: { command: cmd }, output: 'ok', exitCode: 0 },
      });
    }
  }
}

describe('db consolidate（P2-09）', () => {
  it('把同 key ≥3 条 episodic 归纳成 1 条要点；再跑一次 created=0', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, (db) => seedEpisodic(db, ['listening', 'idle', 'crashed']));

    const first = await cli(home, ['db', 'consolidate']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out.trim())).toMatchObject({
      command: 'db consolidate',
      groups: 1,
      created: 1,
      skipped: 0,
      superseded: 0,
      dry_run: false,
    });

    // 幂等：同一批源事实不会再产出一个要点
    const second = await cli(home, ['db', 'consolidate']);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out.trim())).toMatchObject({ created: 0, skipped: 1 });

    withDb(dbFile, (db) => {
      expect(factRepo.countFacts(db)).toBe(4);
      expect(db.prepare("SELECT COUNT(*) AS n FROM edge WHERE etype = 'derived_from'").get()).toEqual({
        n: 3,
      });
    });
  });

  it('--dry-run 只统计不写库；--rate 可覆盖限速', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, (db) => seedEpisodic(db, ['listening', 'idle', 'crashed']));

    const run = await cli(home, ['db', 'consolidate', '--dry-run', '--rate', '0']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out.trim())).toMatchObject({ created: 1, dry_run: true });

    withDb(dbFile, (db) => {
      expect(factRepo.countFacts(db)).toBe(3); // 一个要点都没写
    });
  });

  it('--rate 非数字 / 未知参数 → 退出码 2', async () => {
    const { home } = fakeHome();

    const badRate = await cli(home, ['db', 'consolidate', '--rate', 'abc']);
    expect(badRate.code).toBe(2);
    expect(badRate.err).toContain('--rate');

    const badFlag = await cli(home, ['db', 'consolidate', '--force']);
    expect(badFlag.code).toBe(2);
    expect(badFlag.err).toContain('consolidate');
  });

  it('同一命令提炼过程并输出 procedures；第二次零新增', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, seedProcedure);

    const first = await cli(home, ['db', 'consolidate', '--rate', '0']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out.trim())).toMatchObject({
      command: 'db consolidate',
      procedures: { candidates: 1, created: 1, skipped: 0, superseded: 0 },
      dry_run: false,
    });

    const second = await cli(home, ['db', 'consolidate', '--rate', '0']);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out.trim())).toMatchObject({
      procedures: { candidates: 1, created: 0, skipped: 1, superseded: 0 },
    });
    withDb(dbFile, (db) => {
      expect(factRepo.countFacts(db)).toBe(1);
    });
  });

  it('过程提炼 --dry-run 不写实体、事实或边', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, seedProcedure);

    const run = await cli(home, ['db', 'consolidate', '--dry-run', '--rate', '0']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out.trim())).toMatchObject({
      procedures: { candidates: 1, created: 1 },
      dry_run: true,
    });
    withDb(dbFile, (db) => {
      expect(factRepo.countFacts(db)).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM edge').get()).toEqual({ n: 0 });
    });
  });
});

describe('db migrate（P2-19A-03）', () => {
  it('已最新：dry-run 与实跑都打印 已是最新 (vN)', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, (db) => insertFact(db, {}));

    const dry = await cli(home, ['db', 'migrate', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`已是最新 (v${TARGET_VERSION})`);

    const real = await cli(home, ['db', 'migrate']);
    expect(real.code).toBe(0);
    expect(real.out).toContain(`已是最新 (v${TARGET_VERSION})`);
  });

  it('v5 库：dry-run 列出 006/007 且不写库，实跑迁到 TARGET 并留迁移前备份', async () => {
    const { home, dbFile } = fakeHome();
    const backups = path.join(path.dirname(dbFile), 'backups');
    const { db } = openDb({ file: dbFile });
    try {
      migrate(db, { backupsDir: backups, target: 5 });
    } finally {
      closeDb(db);
    }

    const dry = await cli(home, ['db', 'migrate', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`待执行 2 个迁移（v5 → v${TARGET_VERSION}）`);
    expect(dry.out).toContain('006_');
    expect(dry.out).toContain('007_');
    expect(dry.out).toContain('--dry-run：未写库');

    const before = openDb({ file: dbFile });
    try {
      const row = before.db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(row.user_version).toBe(5);
    } finally {
      closeDb(before.db);
    }

    const real = await cli(home, ['db', 'migrate']);
    expect(real.code).toBe(0);
    expect(real.out).toContain(`迁移完成：v5 → v${TARGET_VERSION}（2 个文件）`);
    expect(real.out).toContain('迁移前备份：');

    const after = openDb({ file: dbFile });
    try {
      const row = after.db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(row.user_version).toBe(TARGET_VERSION);
    } finally {
      closeDb(after.db);
    }
  });

  it('库版本高于程序支持 → 退出码 1，不降级', async () => {
    const { home, dbFile } = fakeHome();
    const { db } = openDb({ file: dbFile });
    try {
      migrate(db, { backupsDir: path.join(path.dirname(dbFile), 'backups') });
      db.pragma(`user_version = ${String(TARGET_VERSION + 1)}`);
    } finally {
      closeDb(db);
    }

    const run = await cli(home, ['db', 'migrate']);
    expect(run.code).toBe(1);
    expect(run.err).toContain('不允许降级');
  });
});

describe('db backup（P2-19A-03）', () => {
  it('打印 备份 -> 路径 (1 个文件, X MB) 且文件存在', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, (db) => insertFact(db, {}));

    const run = await cli(home, ['db', 'backup']);
    expect(run.code).toBe(0);
    const match = /备份 -> (.+?) \(1 个文件, (\d+\.\d{2}) MB\)/.exec(run.out);
    expect(match).not.toBeNull();
    expect(existsSync(match![1]!)).toBe(true);
    expect(statSync(match![1]!).size).toBeGreaterThan(0);
  });

  it('--keep 裁掉最旧的备份（保留最近 keep 份）', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, (db) => insertFact(db, {}));
    const backups = path.join(path.dirname(dbFile), 'backups');
    mkdirSync(backups, { recursive: true });
    const old = new Date(2000, 0, 1);
    for (const name of ['moshi-20000101-000000.db', 'moshi-20000102-000000.db', 'moshi-20000103-000000.db']) {
      const file = path.join(backups, name);
      writeFileSync(file, 'old');
      utimesSync(file, old, old);
    }

    const run = await cli(home, ['db', 'backup', '--keep', '2']);
    expect(run.code).toBe(0);
    const dbs = readdirSync(backups).filter((f) => f.endsWith('.db'));
    expect(dbs.length).toBe(2);
  });

  it('--keep 非正整数 / 非本子命令参数 → 退出码 2', async () => {
    const { home } = fakeHome();
    const badKeep = await cli(home, ['db', 'backup', '--keep', '0']);
    expect(badKeep.code).toBe(2);
    expect(badKeep.err).toContain('--keep');

    const badFlag = await cli(home, ['db', 'vacuum', '--dry-run']);
    expect(badFlag.code).toBe(2);
  });
});

describe('db vacuum / rebuild-degree（P2-19A-03）', () => {
  it('vacuum 打印前后 DB 与 WAL 大小', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, (db) => {
      insertFact(db, {});
      insertFact(db, { predicate: 'install' });
    });

    const run = await cli(home, ['db', 'vacuum']);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/DB .+ → .+（WAL .+ → .+）/);
  });

  it('rebuild-degree 打印修正行数与 degree_mismatch 前后值', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, (db) => {
      const a = insertFact(db, {});
      const b = insertFact(db, { predicate: 'install' });
      insertEdge(db, a, b);
      // 人为打坏存储列，制造对账差值
      db.prepare('UPDATE fact SET degree = 9').run();
    });

    const first = await cli(home, ['db', 'rebuild-degree']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('degree 重建完成：2 行；degree_mismatch 2 → 0');

    const second = await cli(home, ['db', 'rebuild-degree']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('degree_mismatch 0 → 0');
  });
});

describe('db rebuild-edges（P1-20）', () => {
  it('对存量事实补边：首次 created>0，第二次 created=0，边只增不删', async () => {
    const { home, dbFile } = fakeHome();
    let entityId = '';
    withDb(dbFile, (db) => {
      entityId = makeEntity(db, 'svc-rebuild');
      // 同实体同谓词：旧事实已收口（valid_to 非空），新事实更晚 → supersedes 边
      insertFact(db, {
        subject: { entity_id: entityId, name: 'svc-rebuild' },
        predicate: 'port',
        value: '3000',
        validAt: '2026-11-01T00:00:00.000Z',
        validTo: '2026-11-02T00:00:00.000Z',
      });
      insertFact(db, {
        subject: { entity_id: entityId, name: 'svc-rebuild' },
        predicate: 'port',
        value: '4000',
        validAt: '2026-11-03T00:00:00.000Z',
      });
    });

    const first = await cli(home, ['db', 'rebuild-edges']);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.out.trim()) as {
      command: string;
      facts: number;
      created: number;
      created_by_rule: Record<string, number>;
      skipped: number;
      edges_before: number;
      edges_after: number;
    };
    expect(firstPayload.command).toBe('db rebuild-edges');
    expect(firstPayload.facts).toBe(2);
    expect(firstPayload.created).toBeGreaterThanOrEqual(1);
    expect(firstPayload.created_by_rule['supersedes']).toBeGreaterThanOrEqual(1);
    expect(firstPayload.skipped).toBe(0);
    expect(firstPayload.edges_after).toBeGreaterThan(firstPayload.edges_before);

    const second = await cli(home, ['db', 'rebuild-edges']);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.out.trim()) as {
      created: number;
      edges_before: number;
      edges_after: number;
    };
    expect(secondPayload.created).toBe(0);
    expect(secondPayload.edges_after).toBe(secondPayload.edges_before);
    expect(secondPayload.edges_after).toBe(firstPayload.edges_after);

    // 只增不删：两次之后边仍全部有效，事实行未被改动
    withDb(dbFile, (db) => {
      const active = db.prepare('SELECT COUNT(*) AS n FROM edge WHERE valid_to IS NULL').get() as {
        n: number;
      };
      expect(active.n).toBe(firstPayload.edges_after);
      const facts = db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number };
      expect(facts.n).toBe(2);
    });
  });

  it('--help 打印 rebuild-edges 用法', async () => {
    const { home } = fakeHome();
    const run = await cli(home, ['db', 'rebuild-edges', '--help']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('rebuild-edges');
  });
});

describe('db --help', () => {
  it('db --help / db backup --help 打印用法并退出 0', async () => {
    const { home } = fakeHome();

    const top = await cli(home, ['db', '--help']);
    expect(top.code).toBe(0);
    expect(top.out).toContain('backup [--keep <n>]');

    const sub = await cli(home, ['db', 'backup', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.out).toContain('用法：moshi db');
  });
});
