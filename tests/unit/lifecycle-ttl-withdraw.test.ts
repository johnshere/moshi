/**
 * TTL 到期 / 来源撤回：两条「无后继失效」的产出路径（P2② 生命周期缺口）。
 *
 * 锁定的东西：
 * - TTL 边界：`expired_at <= now` 刚好到期即收口，早 1 秒不动；收口写
 *   `valid_to = expired_at`、`invalidated`、`superseded_by = NULL`；
 * - 保留类守卫：`durable` 不允许设 TTL（TTL 只服务保留期/临时记忆）；
 * - 幂等：同一批 `--id` 设期第二次不改不写审计；到期扫描/撤回第二次命中 0；
 * - 撤回：按 episode / batch / 人工指令三种选择器收口活跃事实，不删行、不改 content，
 *   `--by human` 的审计来源是 `human`；
 * - 复检能捞回：TTL 收口 + 仍有证据 + `recheck_kind='command'` 的事实，下一轮
 *   `recheck` 复活数 > 0（本次任务的核心验收点）。
 * - 撤回是单向的：撤回收口写 `attrs.ext.withdrawn` 墓碑，复检判据 `withdrawn` 必须先于
 *   `evidence_alive`，否则曾进过证据包的撤回事实会被复检捞回。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/app/cli/index.js';
import { judgeExpiredFact, recheckExpiredFacts } from '../../src/core/lifecycle/recheck.js';
import { armTtlForFacts, expireDueFacts, TTL_DEFAULT_SECONDS } from '../../src/core/lifecycle/ttl.js';
import { withdrawFacts } from '../../src/core/lifecycle/withdraw.js';
import { addMs } from '../../src/domain/time.js';
import type { Fact } from '../../src/domain/types.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { getFact } from '../../src/infra/sqlite/factRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { hasEvidenceForFact, insertEvidence, insertQueryLog } from '../../src/infra/sqlite/queryLogRepo.js';
import { insertFact, type FactSeed } from '../fixtures/factories.js';

const NOW = '2026-01-02T03:04:05.000Z';
const LATER = addMs(NOW, 60 * 60 * 1000);

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
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-ttl-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  dbs.push(db);
  return db;
}

/** 造一条临时类活跃事实（cache，`recheck_kind='command'`——能被复检捞回的那类） */
function cacheFact(db: Db, seed: FactSeed = {}): string {
  return insertFact(db, {
    retentionClass: 'cache',
    recheckKind: 'command',
    validAt: NOW,
    ...seed,
  });
}

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

function audits(db: Db, source?: string): { field: string | null; before: string | null; after: string | null }[] {
  const where = source === undefined ? "tbl = 'fact'" : "tbl = 'fact' AND source = ?";
  const params = source === undefined ? [] : [source];
  return db
    .prepare(`SELECT field, before_json AS before, after_json AS after FROM audit WHERE ${where} ORDER BY id`)
    .all(...params) as { field: string | null; before: string | null; after: string | null }[];
}

function insertEpisode(db: Db, id: string): void {
  db.prepare('INSERT INTO episode (id, session, ts, raw_hash, raw_path, summary) VALUES (?, NULL, ?, ?, NULL, NULL)').run(
    id,
    NOW,
    `raw-${id}`,
  );
}

describe('TTL 设期（arm）', () => {
  it('给 cache 事实设期：写 ttl_seconds + expired_at，content 不动，必写 audit', () => {
    const db = makeDb();
    const id = cacheFact(db);
    const before = getFact(db, id) as Fact;

    const res = armTtlForFacts(db, { ids: [id], ttlSeconds: 3600, now: NOW });
    expect(res.armed).toBe(1);
    expect(res.notFound).toEqual([]);

    const after = getFact(db, id) as Fact;
    expect(after.ttlSeconds).toBe(3600);
    expect(after.expiredAt).toBe(LATER);
    expect(after.validTo).toBeNull(); // 设期不是收口
    expect(after.content).toBe(before.content);
    expect(after.attrs).toEqual(before.attrs);

    const rows = audits(db, 'rule:ttl');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.field).toBe('expired_at');
    expect(JSON.parse(rows[0]?.after as string)).toMatchObject({
      ttl_seconds: 3600,
      expired_at: LATER,
    });
  });

  it('边界：设期时刻已过 → 第二次设期幂等（不写第二条审计）', () => {
    const db = makeDb();
    const id = cacheFact(db);
    armTtlForFacts(db, { ids: [id], ttlSeconds: 60, now: NOW });
    const second = armTtlForFacts(db, { ids: [id], ttlSeconds: 60, now: addMs(NOW, 10_000) });
    expect(second.armed).toBe(0);
    expect(second.alreadyArmed).toBe(1);
    expect(audits(db, 'rule:ttl')).toHaveLength(1);
    expect((getFact(db, id) as Fact).expiredAt).toBe(addMs(NOW, 60_000));
  });

  it('durable 不允许设 TTL（保留期只服务临时记忆），不给已失效行设期', () => {
    const db = makeDb();
    const durable = insertFact(db, { retentionClass: 'durable', recheckKind: 'command', validAt: NOW });
    const closed = insertFact(db, { retentionClass: 'cache', validAt: addMs(NOW, -2000), validTo: addMs(NOW, -1000), epistemicStatus: 'invalidated' });

    const res = armTtlForFacts(db, { ids: [durable, closed, 'fact_nope'], ttlSeconds: 60, now: NOW });
    expect(res.armed).toBe(0);
    expect(res.skippedRetention).toBe(1);
    expect(res.byRetention).toEqual({ durable: 1 });
    expect(res.closed).toBe(1);
    expect(res.notFound).toEqual(['fact_nope']);
    expect(audits(db, 'rule:ttl')).toHaveLength(0);
    expect((getFact(db, durable) as Fact).expiredAt).toBeNull();
  });

  it('--dry-run 只统计不写库；默认 ttl 是模块常量 1 天', () => {
    const db = makeDb();
    const id = cacheFact(db);
    const res = armTtlForFacts(db, { ids: [id], ttlSeconds: TTL_DEFAULT_SECONDS, now: NOW, dryRun: true });
    expect(res.armed).toBe(1);
    expect((getFact(db, id) as Fact).expiredAt).toBeNull();
    expect(audits(db, 'rule:ttl')).toHaveLength(0);
  });
});

describe('TTL 到期扫描（expire）', () => {
  it('刚好到期即收口：valid_to = expired_at、invalidated、无后继、保留 ttl/expired_at', async () => {
    const db = makeDb();
    const id = cacheFact(db);
    armTtlForFacts(db, { ids: [id], ttlSeconds: 60, now: NOW });
    const before = getFact(db, id) as Fact;

    // 早 1 秒：未到期
    expect((await expireDueFacts(db, { now: addMs(NOW, 59_000) })).scanned).toBe(0);

    const res = await expireDueFacts(db, { now: addMs(NOW, 60_000), ratePerSec: 0 });
    expect(res.scanned).toBe(1);
    expect(res.closed).toBe(1);

    const after = getFact(db, id) as Fact;
    expect(after.validTo).toBe(before.expiredAt);
    expect(after.epistemicStatus).toBe('invalidated');
    expect(after.supersededBy).toBeNull();
    expect(after.content).toBe(before.content);
    expect(after.attrs).toEqual(before.attrs);
    expect(after.ttlSeconds).toBe(60);
    expect(after.expiredAt).toBe(before.expiredAt);

    const rows = audits(db, 'rule:ttl').filter((r) => r.field === 'valid_to');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.after as string)).toMatchObject({
      valid_to: before.expiredAt,
      epistemic_status: 'invalidated',
      superseded_by: null,
    });

    // 幂等：第二轮扫不到（valid_to 非空）
    const second = await expireDueFacts(db, { now: addMs(NOW, 120_000), ratePerSec: 0 });
    expect(second.scanned).toBe(0);
    expect(audits(db, 'rule:ttl').filter((r) => r.field === 'valid_to')).toHaveLength(1);
  });

  it('--dry-run 不写库；未设期的事实不参与到期扫描', async () => {
    const db = makeDb();
    const armed = cacheFact(db);
    armTtlForFacts(db, { ids: [armed], ttlSeconds: 60, now: NOW, dryRun: true });
    const bare = cacheFact(db);
    expect((await expireDueFacts(db, { now: addMs(NOW, 120_000), ratePerSec: 0 })).scanned).toBe(0);
    expect(audits(db)).toHaveLength(0);

    armTtlForFacts(db, { ids: [armed], ttlSeconds: 60, now: NOW });
    const dry = await expireDueFacts(db, { now: addMs(NOW, 120_000), dryRun: true, ratePerSec: 0 });
    expect(dry.closed).toBe(1);
    expect((getFact(db, armed) as Fact).validTo).toBeNull();
    expect((getFact(db, bare) as Fact).validTo).toBeNull();
    expect(audits(db).filter((r) => r.field === 'valid_to')).toHaveLength(0);
  });
});

describe('来源撤回（withdraw）', () => {
  it('按 episode 撤回收口它支撑的活跃事实，不删行、不改 content、留 rule 审计', async () => {
    const db = makeDb();
    insertEpisode(db, 'ep_1');
    const a = cacheFact(db, { sourceEpisode: 'ep_1' });
    const b = insertFact(db, { retentionClass: 'durable', sourceEpisode: 'ep_1', validAt: NOW });
    insertEpisode(db, 'ep_2');
    const other = cacheFact(db, { sourceEpisode: 'ep_2' });
    const closed = insertFact(db, { sourceEpisode: 'ep_1', validAt: addMs(NOW, -2000), validTo: addMs(NOW, -1000), epistemicStatus: 'invalidated' });
    const before = getFact(db, a) as Fact;
    const total = (db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n;

    const res = await withdrawFacts(db, { selector: { kind: 'episode', id: 'ep_1' }, now: LATER, ratePerSec: 0 });
    expect(res.matched).toBe(2);
    expect(res.withdrawn).toBe(2);
    expect(res.alreadyClosed).toBe(0);

    for (const id of [a, b]) {
      const after = getFact(db, id) as Fact;
      expect(after.validTo).toBe(LATER);
      expect(after.epistemicStatus).toBe('invalidated');
      expect(after.supersededBy).toBeNull(); // 无后继
      expect(after.content).toBe(id === a ? before.content : after.content);
    }
    expect((getFact(db, other) as Fact).validTo).toBeNull();
    expect((getFact(db, closed) as Fact).validTo).toBe(addMs(NOW, -1000));
    expect((db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n).toBe(total);

    const rows = audits(db, 'rule:source_withdraw');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.field === 'valid_to')).toBe(true);
    expect(JSON.parse(rows[0]?.after as string)).toMatchObject({ valid_to: LATER, superseded_by: null });

    // 幂等：第二次命中 0，不写第三条审计
    const second = await withdrawFacts(db, { selector: { kind: 'episode', id: 'ep_1' }, now: LATER, ratePerSec: 0 });
    expect(second.matched).toBe(0);
    expect(second.withdrawn).toBe(0);
    expect(audits(db, 'rule:source_withdraw')).toHaveLength(2);
  });

  it('按 batch 撤回；--by human 记 human 来源；--fact 支持不存在的 id', async () => {
    const db = makeDb();
    const a = insertFact(db, { batchId: 'b_1', origin: 'mcp_direct', validAt: NOW });
    const b = insertFact(db, { batchId: 'b_1', origin: 'mcp_direct', validAt: NOW });
    const c = insertFact(db, { validAt: NOW });

    const res = await withdrawFacts(db, {
      selector: { kind: 'batch', id: 'b_1' },
      byHuman: true,
      note: '用户否定了这次直写',
      now: LATER,
      ratePerSec: 0,
    });
    expect(res.withdrawn).toBe(2);
    const human = audits(db, 'human');
    expect(human).toHaveLength(2);
    expect((getFact(db, a) as Fact).validTo).toBe(LATER);
    expect((getFact(db, b) as Fact).validTo).toBe(LATER);
    expect((getFact(db, c) as Fact).validTo).toBeNull();

    const byFact = await withdrawFacts(db, {
      selector: { kind: 'facts', ids: [c, a, 'fact_nope'] },
      now: LATER,
      ratePerSec: 0,
    });
    expect(byFact.withdrawn).toBe(1);
    expect(byFact.alreadyClosed).toBe(1);
    expect(byFact.notFound).toEqual(['fact_nope']);
    expect((getFact(db, c) as Fact).validTo).toBe(LATER);
  });

  it('episode 不存在 → E_NOT_FOUND（拼错 id 不能静默 0 条）', async () => {
    const db = makeDb();
    await expect(
      withdrawFacts(db, { selector: { kind: 'episode', id: 'ep_nope' }, now: LATER }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('--dry-run：命中数照算，一行不写', async () => {
    const db = makeDb();
    insertEpisode(db, 'ep_1');
    const a = cacheFact(db, { sourceEpisode: 'ep_1' });
    const res = await withdrawFacts(db, {
      selector: { kind: 'episode', id: 'ep_1' },
      now: LATER,
      dryRun: true,
    });
    expect(res.matched).toBe(1);
    expect(res.withdrawn).toBe(1);
    expect((getFact(db, a) as Fact).validTo).toBeNull();
    expect(audits(db)).toHaveLength(0);
  });
});

describe('收口后复检有活干', () => {
  it('TTL 收口 + 仍有证据 + recheck_kind=command → 下一轮 recheck 复活', async () => {
    const db = makeDb();
    const id = cacheFact(db);
    cite(db, id);
    armTtlForFacts(db, { ids: [id], ttlSeconds: 60, now: NOW });
    const expired = await expireDueFacts(db, { now: addMs(NOW, 120_000), ratePerSec: 0 });
    expect(expired.closed).toBe(1);
    expect((getFact(db, id) as Fact).validTo).not.toBeNull();

    const dry = await recheckExpiredFacts(db, { now: addMs(NOW, 180_000), dryRun: true, ratePerSec: 0 });
    expect(dry.scanned).toBe(1);
    expect(dry.reactivated).toBe(1);
    expect(dry.byReason['evidence_alive']).toBe(1);
  });

  it('撤回收口的事实没有后继：确实无活跃同身份行，无证据则维持', async () => {
    const db = makeDb();
    insertEpisode(db, 'ep_1');
    const id = insertFact(db, { retentionClass: 'durable', recheckKind: 'command', sourceEpisode: 'ep_1', validAt: NOW });
    await withdrawFacts(db, { selector: { kind: 'episode', id: 'ep_1' }, now: LATER, ratePerSec: 0 });

    const closed = getFact(db, id) as Fact;
    expect(closed.validTo).toBe(LATER);
    expect(closed.supersededBy).toBeNull(); // 无后继：没有新行、也没有 supersedes 边

    const res = await recheckExpiredFacts(db, { now: addMs(LATER, 60_000), dryRun: true, ratePerSec: 0 });
    expect(res.scanned).toBe(1);
    expect(res.maintained).toBe(1);
    // 撤回写了墓碑 → 判据 'withdrawn'（墓碑先于 evidence/后继/闲置判据）
    expect(res.byReason['withdrawn']).toBe(1);
  });

  it('撤回 + 曾进过证据包 → 墓碑压过 evidence_alive，复检不复活', async () => {
    const db = makeDb();
    insertEpisode(db, 'ep_1');
    const cited = cacheFact(db, { sourceEpisode: 'ep_1' });
    const plain = cacheFact(db, { sourceEpisode: 'ep_1' });
    cite(db, cited);

    await withdrawFacts(db, { selector: { kind: 'episode', id: 'ep_1' }, now: LATER, ratePerSec: 0 });
    // 证据确实还在——否则这条用例证明不了"墓碑压过 evidence_alive"
    expect(hasEvidenceForFact(db, cited)).toBe(true);

    const res = await recheckExpiredFacts(db, { now: addMs(LATER, 60_000), dryRun: true, ratePerSec: 0 });
    expect(res.scanned).toBe(2);
    expect(res.reactivated).toBe(0);
    expect(res.maintained).toBe(2);
    expect(res.byReason['withdrawn']).toBe(2);
    expect(res.byReason['evidence_alive']).toBeUndefined();

    const after = getFact(db, cited) as Fact;
    expect(after.validTo).toBe(LATER); // 仍失效
    expect((getFact(db, plain) as Fact).validTo).toBe(LATER);
    expect(after.attrs.ext['withdrawn']).toMatchObject({
      by: 'rule:source_withdraw',
      ts: LATER,
      reason: `withdrawn:episode:ep_1`,
    });
  });

  it('judgeExpiredFact：墓碑判据排在 evidence_alive / 后继之前', async () => {
    const db = makeDb();
    const id = insertFact(db, {
      retentionClass: 'cache',
      recheckKind: 'command',
      validAt: addMs(NOW, -2000),
      validTo: addMs(NOW, -1000),
      epistemicStatus: 'invalidated',
      ext: { withdrawn: { by: 'human', ts: NOW, reason: 'user said so' } },
    });
    const fact = getFact(db, id) as Fact;
    expect(fact.attrs.ext['withdrawn']).not.toBeUndefined();
    const judgement = judgeExpiredFact(fact, {
      now: NOW,
      hasActiveSuccessor: () => true,
      hasEvidence: () => true,
    });
    expect(judgement).toEqual({ verdict: 'maintain', reason: 'withdrawn' });
  });
});

describe('moshi lifecycle ttl / withdraw', () => {
  const homeDirs: string[] = [];
  afterEach(() => {
    for (const dir of homeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeHome(): { home: string; dbFile: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-ttl-cli-'));
    homeDirs.push(home);
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

  it('ttl arm → ttl expire → recheck --dry-run 看到复活', async () => {
    const { home, dbFile } = fakeHome();
    let id = '';
    {
      const { db } = openDb({ file: dbFile });
      try {
        migrate(db, { backupsDir: path.join(path.dirname(dbFile), 'backups') });
        id = cacheFact(db);
        cite(db, id);
      } finally {
        closeDb(db);
      }
    }

    const armed = await cli(home, ['lifecycle', 'ttl', 'arm', '--id', id, '--ttl-seconds', '60', '--now', NOW]);
    expect(armed.code).toBe(0);
    expect(armed.out).toContain('设期 1 条事实');
    expect(armed.out).toContain('有效期 60s');

    const due = await cli(home, ['lifecycle', 'ttl', 'expire', '--now', addMs(NOW, 120_000)]);
    expect(due.code).toBe(0);
    expect(due.out).toContain('收口 1 条');

    const recheck = await cli(home, ['lifecycle', 'recheck', '--dry-run', '--now', addMs(NOW, 180_000)]);
    expect(recheck.code).toBe(0);
    expect(recheck.out).toContain('复活 1');
  });

  it('withdraw CLI：命中并收口，重复执行命中 0', async () => {
    const { home, dbFile } = fakeHome();
    {
      const { db } = openDb({ file: dbFile });
      try {
        migrate(db, { backupsDir: path.join(path.dirname(dbFile), 'backups') });
        insertEpisode(db, 'ep_1');
        cacheFact(db, { sourceEpisode: 'ep_1' });
      } finally {
        closeDb(db);
      }
    }

    const first = await cli(home, ['lifecycle', 'withdraw', '--episode', 'ep_1', '--now', LATER]);
    expect(first.code).toBe(0);
    expect(first.out).toContain('命中 1 条活跃事实，收口 1 条');

    const second = await cli(home, ['lifecycle', 'withdraw', '--episode', 'ep_1', '--now', LATER]);
    expect(second.code).toBe(0);
    expect(second.out).toContain('命中 0 条活跃事实');
  });

  it('参数错误 → 2；withdraw 缺选择器 → 2', async () => {
    const { home } = fakeHome();
    expect((await cli(home, ['lifecycle', 'ttl', 'bogus'])).code).toBe(2);
    expect((await cli(home, ['lifecycle', 'ttl', 'arm'])).code).toBe(2);
    expect((await cli(home, ['lifecycle', 'ttl', 'arm', '--id', 'f1', '--days', 'x'])).code).toBe(2);
    expect((await cli(home, ['lifecycle', 'withdraw'])).code).toBe(2);
    expect((await cli(home, ['lifecycle', 'withdraw', '--episode', 'e', '--fact', 'f'])).code).toBe(2);
    expect((await cli(home, ['lifecycle', 'withdraw', '--by', 'robot'])).code).toBe(2);
  });
});
