/**
 * 实体识别单测（详设 §6.3；台账 P1-19 的 Phase 1 验收缺口）。
 *
 * 覆盖四类候选形态（端口/路径/标识符/错误码）、最长匹配优先、
 * 同片段多实体取前 2（不同 etype）、limit 截断与超时返回部分。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { addAlias, insertEntity } from '../../src/infra/sqlite/entityRepo.js';
import { recognizeEntities } from '../../src/core/read/recognize.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-recognize-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function seedEntity(
  db: Db,
  name: string,
  etype: 'pkg' | 'port' | 'path' | 'concept' | 'unknown' = 'pkg',
): string {
  return insertEntity(db, { canonicalName: name, etype }).id;
}

function alias(db: Db, entityId: string, value: string, confidence = 1.0): void {
  addAlias(db, { alias: value, entityId, source: 'rule', confidence });
}

describe('recognizeEntities', () => {
  it('端口：命中 alias 表里的端口实体', () => {
    const db = freshDb();
    const id = seedEntity(db, '53000', 'port');
    alias(db, id, '53000');

    const got = recognizeEntities(db, 'daemon 监听端口 53000 是谁占的');
    expect(got).toHaveLength(1);
    expect(got[0]!.entity_id).toBe(id);
    expect(got[0]!.etype).toBe('port');
    expect(got[0]!.matched_text).toBe('53000');
  });

  it('路径：整段路径命中，不做子串误配', () => {
    const db = freshDb();
    const id = seedEntity(db, 'C:/temp/moshi', 'path');
    alias(db, id, 'C:/temp/moshi');

    const got = recognizeEntities(db, '数据目录 C:/temp/moshi 被删了吗');
    expect(got.map((e) => e.entity_id)).toContain(id);
  });

  it('标识符：最长匹配优先，被长片段覆盖的子串不再单独识别', () => {
    const db = freshDb();
    const lockId = seedEntity(db, 'pnpm-lock.yaml');
    const pnpmId = seedEntity(db, 'pnpm');
    alias(db, lockId, 'pnpm-lock.yaml');
    alias(db, pnpmId, 'pnpm');

    const got = recognizeEntities(db, 'pnpm-lock.yaml 是什么格式');
    expect(got.map((e) => e.matched_text)).toEqual(['pnpm-lock.yaml']);
    expect(got[0]!.entity_id).toBe(lockId);
  });

  it('错误码：大小写不敏感命中', () => {
    const db = freshDb();
    const id = seedEntity(db, 'EADDRINUSE', 'concept');
    alias(db, id, 'eaddrinuse');

    const got = recognizeEntities(db, '启动时报 EADDRINUSE 怎么处理');
    expect(got).toHaveLength(1);
    expect(got[0]!.entity_id).toBe(id);
    expect(got[0]!.matched_text).toBe('EADDRINUSE');
  });

  it('无 alias 命中 → 空数组（不猜实体）', () => {
    const db = freshDb();
    seedEntity(db, 'unrelated');
    expect(recognizeEntities(db, '完全没见过的词 qwerty')).toEqual([]);
  });

  it('同片段多实体：不同 etype 取前 2，同 etype 只取 1', () => {
    const db = freshDb();
    const portId = seedEntity(db, '53000', 'port');
    const unknownId = seedEntity(db, '53000 dup', 'unknown');
    const secondPkg = seedEntity(db, '53000 pkg2', 'pkg');
    alias(db, portId, '53000', 0.9);
    alias(db, unknownId, '53000', 0.8);
    alias(db, secondPkg, '53000', 0.7);

    const got = recognizeEntities(db, '端口 53000');
    expect(got).toHaveLength(2);
    expect(new Set(got.map((e) => e.etype)).size).toBe(2);
    expect(got[0]!.entity_id).toBe(portId);
  });

  it('limit：结果被截断，但每个片段仍是最长匹配优先', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i += 1) {
      const id = seedEntity(db, `pkgname${String(i)}x`);
      alias(db, id, `pkgname${String(i)}x`);
    }

    const got = recognizeEntities(db, 'pkgname0x pkgname1x pkgname2x pkgname3x pkgname4x', { limit: 3 });
    expect(got).toHaveLength(3);
  });

  it('超时：预算内返回已识别部分，不抛错', () => {
    const db = freshDb();
    const id = seedEntity(db, '53000', 'port');
    alias(db, id, '53000');

    let calls = 0;
    const got = recognizeEntities(db, '端口 53000', { timeoutMs: 5, now: () => (calls++ === 0 ? 0 : 10_000) });
    expect(got).toEqual([]);
  });
});
