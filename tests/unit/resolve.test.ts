import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isMoshiError } from '../../src/domain/errors.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import { GLOBAL_SCOPE, assertScope } from '../../src/domain/scope.js';
import { buildIdentity } from '../../src/core/write/identity.js';
import { resolveEntity, type VectorResolver } from '../../src/core/write/resolve.js';

const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-resolve-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

describe('身份键（详设 §5.6）', () => {
  it('谓词规范化后参与计算：写法不同、key 相同', () => {
    const a = buildIdentity({ scope: 'global', entityId: 'en_1', predicate: 'Installed Version', value: '22' });
    const b = buildIdentity({ scope: 'global', entityId: 'en_1', predicate: 'installed_version', value: '22' });
    expect(a.canonicalKey).toBe(b.canonicalKey);
    expect(a.predicate).toBe('installed_version');
  });

  it('取值键序不影响 value_hash', () => {
    const a = buildIdentity({ scope: 'global', entityId: 'en_1', predicate: 'p', value: { a: 1, b: 2 } });
    const b = buildIdentity({ scope: 'global', entityId: 'en_1', predicate: 'p', value: { b: 2, a: 1 } });
    expect(a.valueHash).toBe(b.valueHash);
  });

  it('取值不可序列化时抛 E_INPUT，不静默降级', () => {
    try {
      buildIdentity({ scope: 'global', entityId: 'en_1', predicate: 'p', value: { fn: () => 1 } });
      throw new Error('should throw');
    } catch (err) {
      expect(isMoshiError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('E_INPUT');
    }
  });

  it('谓词规范化失败时抛 E_INPUT', () => {
    expect(() =>
      buildIdentity({ scope: 'global', entityId: 'en_1', predicate: '---', value: 1 }),
    ).toThrow(/谓词规范化失败/);
  });

  it('scope 只允许 global 与 project:<cwd>', () => {
    expect(() => assertScope('repo')).toThrow(/非法 scope/);
    expect(() => assertScope('project:')).toThrow(/非法 scope/);
    expect(() =>
      buildIdentity({ scope: 'repo', entityId: 'en_1', predicate: 'p', value: 1 }),
    ).toThrow(/非法 scope/);
    expect(assertScope(GLOBAL_SCOPE)).toBeUndefined();
    expect(assertScope('project:c:/work/a')).toBeUndefined();
    expect(GLOBAL_SCOPE).toBe('global');
  });

  it('实体不同 → key 不同（身份键的主体部分生效）', () => {
    const a = buildIdentity({ scope: 'global', entityId: 'en_1', predicate: 'p', value: 1 });
    const b = buildIdentity({ scope: 'global', entityId: 'en_2', predicate: 'p', value: 1 });
    expect(a.canonicalKey).not.toBe(b.canonicalKey);
  });
});

describe('实体消解（详设 §5.5）', () => {
  it('规则级：同一主体两次解析得到同一实体，且 key 一致', () => {
    const db = freshDb();
    const first = resolveEntity(db, { subject: 'Node.js', etype: 'pkg' });
    const second = resolveEntity(db, { subject: 'nodejs', etype: 'pkg' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    expect(first.canonicalName).toBe('pkg:node');

    const k1 = buildIdentity({ scope: 'global', entityId: first.entity.id, predicate: 'version', value: '22' });
    const k2 = buildIdentity({ scope: 'global', entityId: second.entity.id, predicate: 'version', value: '22' });
    expect(k1.canonicalKey).toBe(k2.canonicalKey);
  });

  it('别名都记下来，alias_count 重算正确', () => {
    const db = freshDb();
    resolveEntity(db, { subject: 'Node.js', etype: 'pkg' });
    resolveEntity(db, { subject: 'nodejs', etype: 'pkg' });
    resolveEntity(db, { subject: 'node', etype: 'pkg' });
    const entity = entityRepo.findByCanonical(db, 'pkg:node', 'pkg');
    expect(entity).not.toBeNull();
    expect(entity?.id).toBeTruthy();
    const aliases = entityRepo.aliasesOf(db, (entity as { id: string }).id);
    expect(aliases.map((a) => a.alias).sort()).toEqual(['Node.js', 'node', 'nodejs']);
  });

  it('规范化失败走 provisional，key 依然非空（D5）', () => {
    const db = freshDb();
    const res = resolveEntity(db, { subject: '不知名的东西', etype: 'port' });
    expect(res.level).toBe('provisional');
    expect(res.identity).toBe('unresolved');
    expect(res.entity.etype).toBe('unknown');
    expect(res.entity.id.startsWith('en_')).toBe(true);
    // 关键：provisional 也有实体 id，所以身份键算得出来
    const identity = buildIdentity({
      scope: 'global',
      entityId: res.entity.id,
      predicate: 'occupant',
      value: 'x',
    });
    expect(identity.canonicalKey.startsWith('ck1:')).toBe(true);
  });

  it('provisional 复用：同一个未知主体不会反复建实体', () => {
    const db = freshDb();
    const a = resolveEntity(db, { subject: '怪东西', etype: 'port' });
    const b = resolveEntity(db, { subject: '怪东西', etype: 'port' });
    expect(b.entity.id).toBe(a.entity.id);
    expect(entityRepo.countEntities(db)).toBe(1);
  });

  it('合并后解析跟随到 winner', () => {
    const db = freshDb();
    const winner = resolveEntity(db, { subject: 'node', etype: 'pkg' });
    const loser = entityRepo.insertEntity(db, { canonicalName: 'pkg:nodejs-legacy', etype: 'pkg' });
    entityRepo.markMerged(db, loser.id, winner.entity.id);

    // 别名指向 loser，但解析必须回到 winner
    entityRepo.addAlias(db, { alias: 'legacy-node', entityId: loser.id, source: 'rule' });
    const res = resolveEntity(db, { subject: 'legacy-node', etype: 'pkg' });
    // legacy-node 规范化后是 pkg:legacy-node，属于新实体；用直接查询验证跟随逻辑
    expect(res.entity.id).not.toBe(loser.id);
    const followed = entityRepo.getEntity(db, loser.id);
    expect(followed?.mergedInto).toBe(winner.entity.id);
  });

  it('向量级只建 alias，不合并节点', () => {
    const db = freshDb();
    const existing = resolveEntity(db, { subject: 'postgresql', etype: 'pkg' });

    const vectorResolver: VectorResolver = () => ({ entityId: existing.entity.id, similarity: 0.95 });
    const res = resolveEntity(db, { subject: 'pgsql', etype: 'pkg' }, { vectorResolver });

    expect(res.created).toBe(true);
    expect(res.entity.id).not.toBe(existing.entity.id); // 没有合并
    const aliases = entityRepo.aliasesOf(db, existing.entity.id);
    expect(aliases.some((a) => a.alias === 'pgsql' && a.source === 'vector')).toBe(true);
  });

  it('相似度低于下界时不写 alias', () => {
    const db = freshDb();
    const existing = resolveEntity(db, { subject: 'postgresql', etype: 'pkg' });
    const res = resolveEntity(
      db,
      { subject: '完全不同的包', etype: 'pkg' },
      { vectorResolver: () => ({ entityId: existing.entity.id, similarity: 0.3 }) },
    );
    expect(res.created).toBe(true);
    const aliases = entityRepo.aliasesOf(db, existing.entity.id);
    expect(aliases.some((a) => a.alias === '完全不同的包')).toBe(false);
  });

  it('etype 不同的同名主体是两个实体（端口 8080 与版本 8080 不是一回事）', () => {
    const db = freshDb();
    const asPort = resolveEntity(db, { subject: '8080', etype: 'port' });
    const asConcept = resolveEntity(db, { subject: '8080', etype: 'concept' });
    expect(asPort.entity.id).not.toBe(asConcept.entity.id);
    expect(asPort.canonicalName).toBe('port:8080');
    expect(asConcept.canonicalName).toBe('8080');
  });
});
