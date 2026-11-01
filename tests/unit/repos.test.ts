import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalKey, valueHash } from '../../src/domain/hash.js';
import { newId } from '../../src/domain/ids.js';
import { isMoshiError } from '../../src/domain/errors.js';
import { addDays, nowIso } from '../../src/domain/time.js';
import type { Fact } from '../../src/domain/types.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import * as edgeRepo from '../../src/infra/sqlite/edgeRepo.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import * as auditRepo from '../../src/infra/sqlite/auditRepo.js';
import { buildRepos } from '../../src/infra/sqlite/index.js';

const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-repo-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function makeFact(over: Partial<Fact> = {}): Fact {
  const ts = nowIso();
  const entityId = over.attrs?.frozen.subject.entity_id ?? newId('entity');
  const predicate = over.attrs?.frozen.predicate ?? 'version';
  const value = over.attrs?.frozen.value ?? '22.0.0';
  const scope = over.scope ?? 'global';
  return {
    id: over.id ?? newId('fact'),
    content: over.content ?? `node ${String(value)}`,
    ftype: over.ftype ?? 'semantic',
    confidence: over.confidence ?? 0.9,
    confidenceSource: over.confidenceSource ?? 'tool_obs',
    strength: over.strength ?? 0.5,
    importance: over.importance ?? 0.5,
    pool: over.pool ?? 'utility',
    epistemicStatus: over.epistemicStatus ?? 'active',
    attrs: {
      frozen: { subject: { entity_id: entityId, name: 'node' }, predicate, value },
      ext: over.attrs?.ext ?? {},
    },
    canonicalKey: over.canonicalKey ?? canonicalKey(scope, entityId, predicate),
    valueHash: over.valueHash ?? valueHash(value),
    scope,
    supersededBy: over.supersededBy ?? null,
    validAt: over.validAt ?? ts,
    validTo: over.validTo ?? null,
    recordedAt: over.recordedAt ?? ts,
    communityId: over.communityId ?? null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: ts,
    sourceEpisode: null,
    span: over.span ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
}

describe('factRepo', () => {
  it('插入后可原样读回（含 attrs 两区与 span）', () => {
    const db = freshDb();
    const fact = makeFact({ span: [3, 42], importance: 0.7 });
    factRepo.insertFact(db, fact);
    const got = factRepo.getFact(db, fact.id);
    expect(got).not.toBeNull();
    expect(got?.content).toBe(fact.content);
    expect(got?.attrs.frozen).toEqual(fact.attrs.frozen);
    expect(got?.span).toEqual([3, 42]);
    expect(got?.importance).toBe(0.7);
    expect(got?.degree).toBe(0);
  });

  it('身份键定位唯一', () => {
    const db = freshDb();
    const fact = makeFact();
    factRepo.insertFact(db, fact);
    expect(factRepo.findByIdentity(db, fact.canonicalKey, fact.scope, fact.valueHash)?.id).toBe(
      fact.id,
    );
    expect(factRepo.findByIdentity(db, fact.canonicalKey, 'repo', fact.valueHash)).toBeNull();
  });

  it('同身份不同取值能列出（D 情形的判据）', () => {
    const db = freshDb();
    const a = makeFact({ attrs: { frozen: { subject: { entity_id: 'en_x', name: 'node' }, predicate: 'version', value: '22' }, ext: {} } });
    const b = makeFact({ attrs: { frozen: { subject: { entity_id: 'en_x', name: 'node' }, predicate: 'version', value: '24' }, ext: {} } });
    factRepo.insertFact(db, a);
    factRepo.insertFact(db, b);
    expect(factRepo.listByIdentityKey(db, a.canonicalKey, 'global')).toHaveLength(2);
  });

  it('setConfidence 必然写 audit（I10）', () => {
    const db = freshDb();
    const fact = makeFact({ confidence: 0.6 });
    factRepo.insertFact(db, fact);
    factRepo.setConfidence(db, fact.id, { value: 0.95, source: 'user_confirm', reason: '人工确认' });

    const got = factRepo.getFact(db, fact.id);
    expect(got?.confidence).toBe(0.95);
    expect(got?.confidenceSource).toBe('user_confirm');

    const audits = auditRepo.auditByRow(db, 'fact', fact.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.field).toBe('confidence');
    expect(JSON.parse(audits[0]?.beforeJson ?? '{}')).toEqual({
      confidence: 0.6,
      confidence_source: 'tool_obs',
    });
  });

  it('setConfidence 对不存在的 id 抛 E_NOT_FOUND', () => {
    const db = freshDb();
    try {
      factRepo.setConfidence(db, 'f_nope', { value: 1, source: 'human', reason: 'x' });
      throw new Error('should throw');
    } catch (err) {
      expect(isMoshiError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('E_NOT_FOUND');
    }
  });

  it('touchAccess 累加访问计数并记时间', () => {
    const db = freshDb();
    const fact = makeFact();
    factRepo.insertFact(db, fact);
    factRepo.touchAccess(db, [fact.id, fact.id]);
    const got = factRepo.getFact(db, fact.id);
    expect(got?.accessCount).toBe(2);
    expect(got?.lastAccessAt).not.toBeNull();
  });

  it('invalidate 只收口一次，且 valid_to 必须晚于 valid_at', () => {
    const db = freshDb();
    const fact = makeFact({ validAt: addDays(nowIso(), -1) });
    factRepo.insertFact(db, fact);

    expect(() => factRepo.invalidate(db, fact.id, { validTo: addDays(nowIso(), -2) })).toThrow(
      /valid_to/,
    );

    factRepo.invalidate(db, fact.id, { validTo: nowIso() });
    const got = factRepo.getFact(db, fact.id);
    expect(got?.validTo).not.toBeNull();
    expect(got?.epistemicStatus).toBe('invalidated');

    try {
      factRepo.invalidate(db, fact.id, { validTo: addDays(nowIso(), 1) });
      throw new Error('should throw');
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_IMMUTABLE');
    }
  });

  it('setStrength / setPool 是生命周期专用入口', () => {
    const db = freshDb();
    const fact = makeFact();
    factRepo.insertFact(db, fact);
    factRepo.setStrength(db, fact.id, 0.12);
    factRepo.setPool(db, fact.id, 'value_floor');
    const got = factRepo.getFact(db, fact.id);
    expect(got?.strength).toBe(0.12);
    expect(got?.pool).toBe('value_floor');
  });
});

describe('edgeRepo', () => {
  it('插边后 degree 由触发器维护', () => {
    const db = freshDb();
    const a = makeFact();
    const b = makeFact();
    factRepo.insertFact(db, a);
    factRepo.insertFact(db, b);

    const edgeId = newId('edge');
    edgeRepo.insertEdge(db, { id: edgeId, src: a.id, dst: b.id, etype: 'depends_on', validAt: nowIso() });
    expect(factRepo.getFact(db, a.id)?.degree).toBe(1);

    edgeRepo.closeEdge(db, edgeId, addDays(nowIso(), 1));
    expect(factRepo.getFact(db, a.id)?.degree).toBe(0);
  });

  it('重复插同一条活跃边被唯一索引拒绝', () => {
    const db = freshDb();
    const a = makeFact();
    const b = makeFact();
    factRepo.insertFact(db, a);
    factRepo.insertFact(db, b);
    const ts = nowIso();
    edgeRepo.insertEdge(db, { id: newId('edge'), src: a.id, dst: b.id, etype: 'co_occur', validAt: ts });
    expect(() =>
      edgeRepo.insertEdge(db, { id: newId('edge'), src: a.id, dst: b.id, etype: 'co_occur', validAt: ts }),
    ).toThrow(/UNIQUE/);
  });

  it('neighbors 双向返回，可按 etype 过滤', () => {
    const db = freshDb();
    const a = makeFact();
    const b = makeFact();
    const c = makeFact();
    for (const f of [a, b, c]) factRepo.insertFact(db, f);
    const ts = nowIso();
    edgeRepo.insertEdge(db, { id: newId('edge'), src: a.id, dst: b.id, etype: 'depends_on', validAt: ts });
    edgeRepo.insertEdge(db, { id: newId('edge'), src: c.id, dst: a.id, etype: 'co_occur', validAt: ts });

    expect(edgeRepo.neighbors(db, a.id)).toHaveLength(2);
    expect(edgeRepo.neighbors(db, a.id, { etypes: ['depends_on'] })).toHaveLength(1);
    expect(edgeRepo.neighbors(db, a.id, { etypes: ['depends_on'] })[0]?.src).toBe(a.id);
  });

  it('自环边在仓储层就被拦下', () => {
    const db = freshDb();
    const a = makeFact();
    factRepo.insertFact(db, a);
    expect(() =>
      edgeRepo.insertEdge(db, { id: newId('edge'), src: a.id, dst: a.id, etype: 'logic', validAt: nowIso() }),
    ).toThrow(/自环/);
  });
});

describe('entityRepo', () => {
  it('ensureProvisional 保证 canonical_key 非空（D5）', () => {
    const db = freshDb();
    const e = entityRepo.ensureProvisional(db, '未知的东西-abc');
    expect(e.etype).toBe('unknown');
    expect(e.id.startsWith('en_')).toBe(true);
    // 第二次调用复用同一个实体，不重复创建
    expect(entityRepo.ensureProvisional(db, '未知的东西-abc').id).toBe(e.id);
    expect(entityRepo.countEntities(db)).toBe(1);
  });

  it('别名幂等，且 alias_count 同步', () => {
    const db = freshDb();
    const e = entityRepo.insertEntity(db, { canonicalName: 'node', etype: 'pkg' });
    expect(entityRepo.addAlias(db, { alias: 'nodejs', entityId: e.id, source: 'rule' })).toBe(true);
    expect(entityRepo.addAlias(db, { alias: 'nodejs', entityId: e.id, source: 'rule' })).toBe(false);
    expect(entityRepo.getEntity(db, e.id)?.name).toBe('node');
    expect(entityRepo.aliasesOf(db, e.id)).toHaveLength(1);
  });

  it('resolveAlias 能反查到实体', () => {
    const db = freshDb();
    const e = entityRepo.insertEntity(db, { canonicalName: 'node', etype: 'pkg' });
    entityRepo.addAlias(db, { alias: 'nodejs', entityId: e.id, source: 'rule' });
    expect(entityRepo.resolveAlias(db, 'nodejs')[0]?.id).toBe(e.id);
    expect(entityRepo.resolveAlias(db, 'nope')).toEqual([]);
  });

  it('合并：etype 不同禁止、重复合并禁止', () => {
    const db = freshDb();
    const a = entityRepo.insertEntity(db, { canonicalName: 'node', etype: 'pkg' });
    const b = entityRepo.insertEntity(db, { canonicalName: 'nodejs', etype: 'pkg' });
    const c = entityRepo.insertEntity(db, { canonicalName: '8080', etype: 'port' });

    expect(() => entityRepo.markMerged(db, c.id, a.id)).toThrow(/etype 不同/);
    entityRepo.markMerged(db, b.id, a.id);
    expect(entityRepo.getEntity(db, b.id)?.mergedInto).toBe(a.id);
    expect(() => entityRepo.markMerged(db, b.id, a.id)).toThrow(/已合并/);
  });
});

describe('buildRepos', () => {
  it('聚合对象暴露六组仓储，且不暴露 Db', () => {
    const db = freshDb();
    const repos = buildRepos(db);
    expect(Object.keys(repos).sort()).toEqual([
      'audit',
      'edge',
      'entity',
      'fact',
      'quarantine',
      'view',
    ]);
    expect((repos as unknown as Record<string, unknown>)['db']).toBeUndefined();
  });
});
