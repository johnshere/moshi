/**
 * query_log 保留清理（P2；开发方案 §4）。
 *
 * 三件事必须成立：默认保留天数外的行连同 evidence_log 子行一起删；
 * 保留期内的行一条不动；`keep_days = 0` 是「永久保留」的显式开关。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { purgeQueryLogs, startQueryLogRetention } from '../../src/app/jobs/queryLogRetention.js';

const opened: Db[] = [];
const logs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-query-log-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  opened.push(db);
  migrate(db, { backupsDir: path.join(dir, 'backups'), vectorEnabled: false });
  db.prepare(
    "INSERT INTO fact (id, content, ftype, confidence, confidence_source, strength, importance, pool, epistemic_status, attrs, canonical_key, value_hash, scope, valid_at, recorded_at, last_decay_at, created_at, updated_at) " +
      `VALUES ('f1','alpha','semantic',0.9,'tool_obs',0.5,0.5,'utility','active','{"frozen":{"subject":{"entity_id":"en_a","name":"alpha"},"predicate":"state","value":"alpha"},"ext":{}}','ck','vh','global','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`,
  ).run();
  return db;
}

function insertLog(db: Db, id: string, ts: string): void {
  db.prepare(
    'INSERT INTO query_log (id, ts, query_text, query_hash, route, flags_json, latency_ms) VALUES (?,?,?,?,?,?,?)',
  ).run(id, ts, 'q', `h_${id}`, 'local', '{}', 1);
  db.prepare(
    'INSERT INTO evidence_log (query_id, m_id, fact_id, rank, score, pool) VALUES (?,?,?,?,?,?)',
  ).run(id, 1, 'f1', 1, 0.9, 'utility');
}

const logger = {
  info: (obj: Record<string, unknown>): void => {
    logs.push(JSON.stringify(obj));
  },
  error: (obj: Record<string, unknown>): void => {
    logs.push(JSON.stringify(obj));
  },
};

describe('query_log 保留清理（P2）', () => {
  it('删掉保留期外的行，连同 evidence_log 子行；期内的行不动', () => {
    const db = freshDb();
    insertLog(db, 'q_old', '2026-11-05T00:00:00.000Z');
    insertLog(db, 'q_new', '2026-11-10T00:00:00.000Z');
    const removed = purgeQueryLogs({
      db,
      keepDays: 3,
      log: logger,
      now: () => new Date('2026-11-11T00:00:00.000Z'),
    });
    expect(removed).toBe(1);
    const ids = db.prepare('SELECT id FROM query_log ORDER BY id').all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(['q_new']);
    const evidence = db.prepare('SELECT query_id FROM evidence_log').all() as { query_id: string }[];
    expect(evidence.map((r) => r.query_id)).toEqual(['q_new']);
    expect(logs.some((line) => line.includes('query_log.purged'))).toBe(true);
  });

  it('keep_days = 0 表示永久保留，一条都不删', () => {
    const db = freshDb();
    insertLog(db, 'q_old', '2020-01-01T00:00:00.000Z');
    const removed = purgeQueryLogs({
      db,
      keepDays: 0,
      log: logger,
      now: () => new Date('2026-11-11T00:00:00.000Z'),
    });
    expect(removed).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM query_log').get()).toEqual({ n: 1 });
  });

  it('startQueryLogRetention 启动即跑一次，intervalMs=0 不挂定时器', () => {
    const db = freshDb();
    insertLog(db, 'q_old', '2020-01-01T00:00:00.000Z');
    const retention = startQueryLogRetention({
      db,
      keepDays: 3,
      log: logger,
      intervalMs: 0,
      now: () => new Date('2026-11-11T00:00:00.000Z'),
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM query_log').get()).toEqual({ n: 0 });
    expect(retention.runOnce()).toBe(0);
    retention.stop();
  });
});
