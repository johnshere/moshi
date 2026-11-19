/**
 * 复检（recheck）与 purge 回放链（P2② 生命周期缺口）。
 *
 * 锁定四件事：
 * - 判据表：`recheck_kind` 分流 + 后继/时域/证据/闲置四条判据的**优先级**；
 * - 端到端：复活清 `valid_to` 并把强度抬到 floor、待审只写 `attrs.recheck`、维持一行不动；
 * - `--dry-run`：判定与分布照算，但一次写都不发（无 audit、无 attrs、`valid_to` 不变）；
 * - 仓储守卫：活跃行不能复活（E_IMMUTABLE）、同身份已有活跃行时拒绝复活（E_CONFLICT_IDENTITY）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/app/cli/index.js';
import {
  isIdleExpired,
  judgeExpiredFact,
  recheckExpiredFacts,
  RECHECK_IDLE_DAYS,
} from '../../src/core/lifecycle/recheck.js';
import { addDays } from '../../src/domain/time.js';
import type { Fact } from '../../src/domain/types.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { getFact, reactivate } from '../../src/infra/sqlite/factRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEvidence, insertQueryLog } from '../../src/infra/sqlite/queryLogRepo.js';
import { insertFact, makeEntity, type FactSeed } from '../fixtures/factories.js';

const NOW = '2026-01-02T03:04:05.000Z';

const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  while (dbs.length > 0) {
    const db = dbs.pop();
    if (db !== undefined) closeDb(db);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-recheck-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  dbs.push(db);
  return db;
}

/** 造一条"已失效"事实；默认 `recheck_kind='command'`（复检覆盖的那一类） */
function expiredFact(db: Db, seed: FactSeed = {}): string {
  const validTo = seed.validTo ?? addDays(NOW, -3);
  return insertFact(db, {
    ...seed,
    validAt: seed.validAt ?? addDays(validTo, -10),
    validTo,
    epistemicStatus: seed.epistemicStatus ?? 'invalidated',
    recheckKind: seed.recheckKind ?? 'command',
    strength: seed.strength ?? 0.5,
  });
}

/** 在 fact 上留一条证据（query_log + evidence_log） */
function cite(db: Db, factId: string, queryId = `q-${factId}`): void {
  insertQueryLog(db, {
    id: queryId,
    ts: NOW,
    queryText: 'node 版本',
    queryHash: 'h',
    route: 'local',
    flags: {},
    packed: [factId],
    latencyMs: 1,
  });
  insertEvidence(db, [
    { queryId, mId: 1, factId, rank: 1, score: 1, pool: 'utility', cited: true },
  ]);
}

function probe(o: { successor?: boolean; evidence?: boolean } = {}): {
  now: string;
  hasActiveSuccessor: () => boolean;
  hasEvidence: () => boolean;
} {
  return {
    now: NOW,
    hasActiveSuccessor: () => o.successor === true,
    hasEvidence: () => o.evidence === true,
  };
}

function auditCount(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM audit WHERE tbl = 'fact' AND source = 'rule:recheck'")
    .get() as { n: number };
  return row.n;
}

describe('judgeExpiredFact：判据与优先级', () => {
  it('recheck_kind 分流先于其它判据（none / manual / on_read 一律维持）', () => {
    const db = makeDb();
    const load = (seed: FactSeed): Fact => getFact(db, expiredFact(db, seed)) as Fact;

    expect(judgeExpiredFact(load({ recheckKind: 'none' }), probe({ successor: true }))).toEqual({
      verdict: 'maintain',
      reason: 'recheck_none',
    });
    expect(judgeExpiredFact(load({ recheckKind: 'manual' }), probe({ evidence: true }))).toEqual({
      verdict: 'maintain',
      reason: 'manual_pending',
    });
    expect(judgeExpiredFact(load({ recheckKind: 'on_read' }), probe())).toEqual({
      verdict: 'maintain',
      reason: 'on_read_lazy',
    });
  });

  it('同身份已有活跃行时维持，即便 valid_to 在未来或仍有证据', () => {
    const db = makeDb();
    const future = getFact(db, expiredFact(db, { validTo: addDays(NOW, 5) })) as Fact;
    expect(judgeExpiredFact(future, probe({ successor: true, evidence: true }))).toEqual({
      verdict: 'maintain',
      reason: 'has_active_successor',
    });
  });

  it('无后继时：valid_to 在未来 → 复活', () => {
    const db = makeDb();
    const fact = getFact(db, expiredFact(db, { validTo: addDays(NOW, 5) })) as Fact;
    expect(judgeExpiredFact(fact, probe())).toEqual({
      verdict: 'reactivate',
      reason: 'valid_to_in_future',
    });
  });

  it('无后继时：仍有证据 → 复活', () => {
    const db = makeDb();
    const id = expiredFact(db);
    cite(db, id);
    expect(judgeExpiredFact(getFact(db, id) as Fact, probe({ evidence: true }))).toEqual({
      verdict: 'reactivate',
      reason: 'evidence_alive',
    });
  });

  it('无后继无证据：闲置超过 60 天 → 待审，否则维持', () => {
    const db = makeDb();
    const idle = getFact(db, expiredFact(db, { validTo: addDays(NOW, -(RECHECK_IDLE_DAYS + 1)) })) as Fact;
    expect(isIdleExpired(idle, NOW)).toBe(true);
    expect(judgeExpiredFact(idle, probe())).toEqual({
      verdict: 'pending_review',
      reason: 'idle_prune_candidate',
    });

    const fresh = getFact(db, expiredFact(db, { validTo: addDays(NOW, -3) })) as Fact;
    expect(isIdleExpired(fresh, NOW)).toBe(false);
    expect(judgeExpiredFact(fresh, probe())).toEqual({
      verdict: 'maintain',
      reason: 'no_evidence',
    });
  });

  it('未失效的行不参与复检（valid_to 为空 → 维持）', () => {
    const db = makeDb();
    const id = insertFact(db, { recheckKind: 'command' });
    const fact = getFact(db, id) as Fact;
    expect(judgeExpiredFact(fact, probe({ evidence: true }))).toEqual({
      verdict: 'maintain',
      reason: 'no_evidence',
    });
  });
});

describe('recheckExpiredFacts：写库', () => {
  it('复活 / 维持 / 待审三类都按判据落库，并写 rule:recheck 审计', async () => {
    const db = makeDb();
    const revived = expiredFact(db);
    cite(db, revived);
    const untouched = expiredFact(db);
    const pending = expiredFact(db, { validTo: addDays(NOW, -(RECHECK_IDLE_DAYS + 1)) });
    const subject = { entity_id: makeEntity(db, 'pkg-recheck'), name: 'node' };
    const superseded = expiredFact(db, { subject });
    insertFact(db, { subject }); // 同身份活跃行（不同取值）
    const lazy = expiredFact(db, { recheckKind: 'none' });
    const future = expiredFact(db, { validTo: addDays(NOW, 5) });

    const beforeRevived = getFact(db, revived) as Fact;
    const beforePending = getFact(db, pending) as Fact;
    const beforeUntouched = getFact(db, untouched) as Fact;

    const res = await recheckExpiredFacts(db, { now: NOW, ratePerSec: 0 });
    expect(res.scanned).toBe(6);
    expect(res.reactivated).toBe(2); // 证据仍在 + valid_to 在未来
    expect(res.maintained).toBe(3); // 无证据 / 被取代 / recheck_kind=none
    expect(res.pendingReview).toBe(1);

    const afterRevived = getFact(db, revived) as Fact;
    expect(afterRevived.validTo).toBeNull();
    expect(afterRevived.epistemicStatus).toBe('active');
    expect(afterRevived.strength).toBe(0.6);
    expect(afterRevived.content).toBe(beforeRevived.content);
    expect(afterRevived.validAt).toBe(beforeRevived.validAt);
    expect(afterRevived.expiredAt).toBeNull();

    const afterPending = getFact(db, pending) as Fact;
    expect(afterPending.validTo).toBe(beforePending.validTo);
    expect(afterPending.epistemicStatus).toBe('invalidated');
    expect((afterPending.attrs.ext as unknown as Record<string, unknown>)['recheck']).toMatchObject({
      verdict: 'pending_review',
      reason: 'idle_prune_candidate',
    });

    const afterUntouched = getFact(db, untouched) as Fact;
    expect(afterUntouched.validTo).toBe(beforeUntouched.validTo);
    expect(afterUntouched.strength).toBe(beforeUntouched.strength);

    expect((getFact(db, lazy) as Fact).validTo).not.toBeNull();
    expect((getFact(db, superseded) as Fact).validTo).not.toBeNull();
    expect((getFact(db, future) as Fact).validTo).toBeNull();

    // 三条写操作各一行审计（两次复活 + 一次待审），来源统一 rule:recheck
    expect(auditCount(db)).toBe(3);
    const fields = (
      db
        .prepare("SELECT field FROM audit WHERE source = 'rule:recheck' ORDER BY field")
        .all() as { field: string }[]
    ).map((r) => r.field);
    expect(fields).toEqual(['attrs.ext.recheck', 'valid_to', 'valid_to']);
    const revivedAudit = db
      .prepare("SELECT before_json AS b, after_json AS a FROM audit WHERE field = 'valid_to'")
      .get() as { b: string; a: string };
    expect((JSON.parse(revivedAudit.b) as { valid_to: string }).valid_to).toBe(beforeRevived.validTo);
    expect((JSON.parse(revivedAudit.a) as { valid_to: string | null }).valid_to).toBeNull();
  });

  it('--dry-run：判定照算、一次写都不发', async () => {
    const db = makeDb();
    const revived = expiredFact(db);
    cite(db, revived);
    const pending = expiredFact(db, { validTo: addDays(NOW, -(RECHECK_IDLE_DAYS + 1)) });
    const before = getFact(db, revived) as Fact;

    const res = await recheckExpiredFacts(db, { now: NOW, dryRun: true, ratePerSec: 0 });
    expect(res.scanned).toBe(2);
    expect(res.reactivated).toBe(1);
    expect(res.pendingReview).toBe(1);

    const afterRevived = getFact(db, revived) as Fact;
    expect(afterRevived.validTo).toBe(before.validTo);
    expect(afterRevived.strength).toBe(before.strength);
    expect(
      (getFact(db, pending) as Fact).attrs.ext as unknown as Record<string, unknown>,
    ).not.toHaveProperty('recheck');
    expect(auditCount(db)).toBe(0);
  });

  it('--limit 只扫前 N 条（按 id 升序）', async () => {
    const db = makeDb();
    for (let i = 0; i < 4; i += 1) expiredFact(db);
    const res = await recheckExpiredFacts(db, { now: NOW, limit: 2, dryRun: true });
    expect(res.scanned).toBe(2);
    expect(res.reactivated + res.maintained + res.pendingReview).toBe(2);
  });
});

describe('reactivate 仓储守卫', () => {
  it('活跃行不能复活（E_IMMUTABLE）', () => {
    const db = makeDb();
    const id = insertFact(db, {});
    expect(() => reactivate(db, id)).toThrowError(/不能复活/);
    try {
      reactivate(db, id);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('E_IMMUTABLE');
    }
  });

  it('同身份已有活跃行时拒绝复活（E_CONFLICT_IDENTITY），避免两个有效取值', () => {
    const db = makeDb();
    const subject = { entity_id: makeEntity(db, 'pkg-guard'), name: 'node' };
    const expired = expiredFact(db, { subject });
    insertFact(db, { subject });
    try {
      reactivate(db, expired);
      throw new Error('应当抛 E_CONFLICT_IDENTITY');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('E_CONFLICT_IDENTITY');
    }
    expect((getFact(db, expired) as Fact).validTo).not.toBeNull();
  });
});

describe('moshi lifecycle recheck', () => {
  function fakeHome(): { home: string; dbFile: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-recheck-cli-'));
    dirs.push(home);
    const dataDir = path.join(home, '.moshi');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, 'config.yaml'),
      `storage:\n  data_dir: "${dataDir.replace(/\\/g, '/')}"\n`,
      'utf8',
    );
    return { home, dbFile: path.join(dataDir, 'moshi.db') };
  }

  async function cli(home: string, args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
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

  it('--dry-run --limit：输出分布且不写库', async () => {
    const { home, dbFile } = fakeHome();
    {
      const { db } = openDb({ file: dbFile });
      try {
        migrate(db, { backupsDir: path.join(path.dirname(dbFile), 'backups') });
        expiredFact(db);
        expiredFact(db, { validTo: addDays(NOW, -(RECHECK_IDLE_DAYS + 1)) });
        expiredFact(db);
      } finally {
        closeDb(db);
      }
    }

    const r = await cli(home, ['lifecycle', 'recheck', '--dry-run', '--limit', '2']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('扫描 2 条已失效事实');
    expect(r.out).toContain('--dry-run');
    expect(r.out).toContain('判据分布');

    const { db } = openDb({ file: dbFile });
    try {
      expect(auditCount(db)).toBe(0);
      const n = db
        .prepare('SELECT COUNT(*) AS n FROM fact WHERE valid_to IS NULL')
        .get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it('参数与库缺失：未知子命令 2 / 无库 1', async () => {
    const { home } = fakeHome();
    expect((await cli(home, ['lifecycle', 'bogus'])).code).toBe(2);
    expect((await cli(home, ['lifecycle', 'recheck', '--limit'])).code).toBe(2);
    expect((await cli(home, ['lifecycle', 'recheck', '--limit', 'x'])).code).toBe(2);
    const missing = await cli(home, ['lifecycle', 'recheck']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('尚未观测到数据库');
  });
});
