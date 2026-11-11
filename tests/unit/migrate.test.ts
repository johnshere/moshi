import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isMoshiError } from '../../src/domain/errors.js';
import { capabilities, closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { listMigrations, listTables, migrate, TARGET_VERSION } from '../../src/infra/sqlite/migrate.js';

const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function tempDb(): { db: Db; file: string; dir: string; vectorEnabled: boolean } {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-db-'));
  const file = path.join(dir, 'moshi.db');
  const { db, vectorEnabled } = openDb({ file });
  opened.push(db);
  return { db, file, dir, vectorEnabled };
}

const CORE_TABLES = [
  'meta',
  'entity',
  'alias',
  'episode',
  'session',
  'fact',
  'edge',
  'community_summary',
  'annotation',
  'quarantine',
  'feedback',
  'query_log',
  'evidence_log',
  'adjudication',
  'training_sample',
  'ontology',
  'layout',
  'archive_meta',
  'audit',
  'fact_fts',
];

describe('迁移（详设 §2.7）', () => {
  it('空库一次建成，user_version=TARGET_VERSION', () => {
    const { db, dir } = tempDb();
    const res = migrate(db, { backupsDir: path.join(dir, 'backups') });
    expect(res.from).toBe(0);
    expect(res.to).toBe(TARGET_VERSION);
    expect(res.applied).toEqual([
      '001_init.sql',
      '002_schema_rev.sql',
      '003_protocol.sql',
      '004_edges.sql',
      '005_direct_write.sql',
      '006_fact_semantics.sql',
      '007_query_log_caller.sql',
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(TARGET_VERSION);

    const tables = listTables(db);
    for (const t of CORE_TABLES) expect(tables).toContain(t);
    expect(res.backupPath).toBeNull(); // 空库没什么可备份的
  });

  it('再跑一次是幂等的（不重复建表、不报错）', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups') });
    const second = migrate(db, { backupsDir: path.join(dir, 'backups') });
    expect(second.from).toBe(TARGET_VERSION);
    expect(second.applied).toEqual([]);
    expect(second.backupPath).toBeNull();
  });

  it('降级被拒绝（新库 + 旧程序）', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups') });
    db.pragma('user_version = 99');
    try {
      migrate(db, { backupsDir: path.join(dir, 'backups') });
      throw new Error('should throw');
    } catch (err) {
      expect(isMoshiError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('E_CONFIG');
      expect((err as Error).message).toContain('不允许降级');
    }
  });

  it('有数据时迁移前先 VACUUM INTO 备份', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moshi-db-'));
    const file = path.join(dir, 'moshi.db');
    const { db } = openDb({ file });
    opened.push(db);
    db.exec('CREATE TABLE legacy(x INTEGER); INSERT INTO legacy VALUES (1);');
    const backups = path.join(dir, 'backups');
    const res = migrate(db, { backupsDir: backups });
    expect(res.backupPath).not.toBeNull();
    expect(existsSync(res.backupPath as string)).toBe(true);
  });

  it('迁移文件按版本号排序，且命名不合规的被忽略', () => {
    const files = listMigrations(path.resolve(import.meta.dirname, '../../migrations'));
    expect(files.map((f) => f.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('v6 带数据的库迁到 v7：query_log 加接入层列，历史行留 NULL（P2）', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups'), target: 6 });
    db.exec(
      "INSERT INTO query_log (id, ts, query_text, query_hash, route, flags_json, latency_ms) " +
        "VALUES ('q_old','2026-11-01T00:00:00.000Z','old query','h_old','local','{}',1)",
    );
    const res = migrate(db, { backupsDir: path.join(dir, 'backups') });
    expect(res.from).toBe(6);
    expect(res.to).toBe(TARGET_VERSION);
    expect(res.applied).toEqual(['007_query_log_caller.sql']);
    const row = db
      .prepare(
        'SELECT caller_id, caller_kind, plugin_id, corr_id, status, in_bytes, out_bytes FROM query_log WHERE id = ?',
      )
      .get('q_old') as Record<string, unknown>;
    expect(row).toEqual({
      caller_id: null,
      caller_kind: null,
      plugin_id: null,
      corr_id: null,
      status: null,
      in_bytes: null,
      out_bytes: null,
    });
    // 索引也建了（日志页按接入点分页要用）
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='query_log'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['idx_query_log_caller_ts', 'idx_query_log_kind_ts', 'idx_query_log_corr']),
    );
  });

  it('schema_rev 在事实 UPDATE、边写入时也递增（P1-25）', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups') });
    const revOf = (): number => Number(db.prepare("SELECT value FROM meta WHERE key='schema_rev'").pluck().get());

    db.exec(
      "INSERT INTO fact (id, content, ftype, confidence, confidence_source, strength, importance, pool, epistemic_status, attrs, canonical_key, value_hash, scope, valid_at, recorded_at, last_decay_at, created_at, updated_at) " +
        `VALUES ('f_a','alpha','semantic',0.9,'tool_obs',0.5,0.5,'utility','active','{"frozen":{"subject":{"entity_id":"en_a","name":"a"},"predicate":"state","value":"alpha"},"ext":{}}','ck_a','vh_a','global','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`,
    );
    db.exec(
      "INSERT INTO fact (id, content, ftype, confidence, confidence_source, strength, importance, pool, epistemic_status, attrs, canonical_key, value_hash, scope, valid_at, recorded_at, last_decay_at, created_at, updated_at) " +
        `VALUES ('f_b','beta','semantic',0.9,'tool_obs',0.5,0.5,'utility','active','{"frozen":{"subject":{"entity_id":"en_b","name":"b"},"predicate":"state","value":"beta"},"ext":{}}','ck_b','vh_b','global','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`,
    );
    const afterInsert = revOf();

    // 只改 degree（边触发的回写路径）不该算"内容变了"
    db.exec("UPDATE fact SET degree = 5 WHERE id = 'f_a'");
    expect(revOf()).toBe(afterInsert);

    db.exec("UPDATE fact SET epistemic_status = 'invalidated' WHERE id = 'f_a'");
    expect(revOf()).toBe(afterInsert + 1);

    db.exec(
      "INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, recorded_at) VALUES ('e1','f_a','f_b','logic',1.0,0.9,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')",
    );
    expect(revOf()).toBe(afterInsert + 2);
  });
});

describe('连接 PRAGMA（详设 §2.2 第 0 段）', () => {
  it('外键、busy_timeout、WAL 都设上了', () => {
    const { db } = tempDb();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  });

  it('FTS5 与 JSON1 可用（D11 的前提）', () => {
    const { db } = tempDb();
    migrate(db);
    const caps = capabilities(db);
    expect(caps.fts5).toBe(true);
    expect(caps.json1).toBe(true);
  });
});

describe('向量表降级（详设 §2.2 末段）', () => {
  it('vectorEnabled=false 时跳过 fact_vec 并打标记，其余表照常建', () => {
    const { db, dir } = tempDb();
    const res = migrate(db, { backupsDir: path.join(dir, 'backups'), vectorEnabled: false });
    expect(res.vectorEnabled).toBe(false);

    const tables = listTables(db);
    expect(tables).not.toContain('fact_vec');
    expect(tables).toContain('fact');

    const row = db.prepare("SELECT value FROM meta WHERE key='vector_disabled'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('1');
  });

  it('默认按连接能力探测 vec0：装了扩展就建 fact_vec 且不打降级标记（B-4）', () => {
    const { db, dir } = tempDb();
    // openDb 已经尝试加载 sqlite-vec；没装扩展的机器上这条不成立，跳过
    if (!capabilities(db).vector) return;
    const res = migrate(db, { backupsDir: path.join(dir, 'backups') });
    expect(res.vectorEnabled).toBe(true);
    expect(listTables(db)).toContain('fact_vec');
    const row = db.prepare("SELECT value FROM meta WHERE key='vector_disabled'").get();
    expect(row).toBeUndefined();
  });
});
