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
  it('空库一次建成，user_version=1', () => {
    const { db, dir } = tempDb();
    const res = migrate(db, { backupsDir: path.join(dir, 'backups') });
    expect(res.from).toBe(0);
    expect(res.to).toBe(TARGET_VERSION);
    expect(res.applied).toEqual(['001_init.sql']);
    expect(db.pragma('user_version', { simple: true })).toBe(1);

    const tables = listTables(db);
    for (const t of CORE_TABLES) expect(tables).toContain(t);
    expect(res.backupPath).toBeNull(); // 空库没什么可备份的
  });

  it('再跑一次是幂等的（不重复建表、不报错）', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups') });
    const second = migrate(db, { backupsDir: path.join(dir, 'backups') });
    expect(second.from).toBe(1);
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
    expect(files.map((f) => f.version)).toEqual([1]);
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
});
