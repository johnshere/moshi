/**
 * 隐私 purge 的回放链扇出（P2②）。
 *
 * 缺口：`scope='facts'` 删了 `evidence_log` 却保留 `query_log`，而 query_log 的
 * `fused_json/packed_json` 引用的正是被删掉的 fact_id——历史查询还在、`m_id`
 * 却再也回放不出来（详设 §6.12）。
 *
 * 锁定：facts 范围删掉"引用过事实的查询"、保留无证据的查询；all 范围全删；
 * sessions 范围不动 query_log；引用查询超过 400 条时按块删除（SQLite 变量上限）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deletePrivacyData } from '../../src/infra/sqlite/auditRepo.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEvidence, insertQueryLog } from '../../src/infra/sqlite/queryLogRepo.js';
import { insertFact } from '../fixtures/factories.js';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-purge-fanout-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  dbs.push(db);
  return db;
}

function count(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function queryIds(db: Db): string[] {
  return (db.prepare('SELECT id FROM query_log ORDER BY id').all() as { id: string }[]).map(
    (r) => r.id,
  );
}

/** 一次查询 + 它引用的证据行（`packed` 与 evidence 同步，模拟真实埋点） */
function seedQuery(db: Db, id: string, factIds: readonly string[]): void {
  insertQueryLog(db, {
    id,
    ts: NOW,
    queryText: `query ${id}`,
    queryHash: `h-${id}`,
    route: 'local',
    flags: {},
    packed: factIds,
    latencyMs: 1,
  });
  if (factIds.length === 0) return;
  insertEvidence(
    db,
    factIds.map((factId, index) => ({
      queryId: id,
      mId: index + 1,
      factId,
      rank: index + 1,
      score: 1,
      pool: 'utility' as const,
      cited: false,
    })),
  );
}

describe('deletePrivacyData 回放链扇出', () => {
  it('scope=facts：引用过事实的 query_log 一起删，无证据的查询保留', () => {
    const db = makeDb();
    const f1 = insertFact(db, {});
    const f2 = insertFact(db, {});
    seedQuery(db, 'q1', [f1]);
    seedQuery(db, 'q2', [f2]);
    seedQuery(db, 'q3', []);

    const deleted = deletePrivacyData(db, 'facts');
    expect(deleted.facts).toBe(2);
    expect(count(db, 'evidence_log')).toBe(0);
    expect(count(db, 'fact')).toBe(0);
    expect(queryIds(db)).toEqual(['q3']);
  });

  it('scope=all：query_log 全删（含无证据的查询）', () => {
    const db = makeDb();
    const f1 = insertFact(db, {});
    seedQuery(db, 'q1', [f1]);
    seedQuery(db, 'q2', []);

    deletePrivacyData(db, 'all');
    expect(count(db, 'query_log')).toBe(0);
    expect(count(db, 'evidence_log')).toBe(0);
  });

  it('scope=sessions：不动 query_log 与证据行', () => {
    const db = makeDb();
    const f1 = insertFact(db, {});
    seedQuery(db, 'q1', [f1]);

    deletePrivacyData(db, 'sessions');
    expect(queryIds(db)).toEqual(['q1']);
    expect(count(db, 'evidence_log')).toBe(1);
    expect(count(db, 'fact')).toBe(1);
  });

  it('引用查询超过 400 条时按块删除（避开 SQLite 变量上限）', () => {
    const db = makeDb();
    const f1 = insertFact(db, {});
    for (let i = 0; i < 401; i += 1) seedQuery(db, `q${String(i).padStart(3, '0')}`, [f1]);
    expect(count(db, 'query_log')).toBe(401);

    deletePrivacyData(db, 'facts');
    expect(count(db, 'query_log')).toBe(0);
    expect(count(db, 'evidence_log')).toBe(0);
  });
});
