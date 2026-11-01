import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import * as edgeRepo from '../../src/infra/sqlite/edgeRepo.js';
import * as adjudicationRepo from '../../src/infra/sqlite/adjudicationRepo.js';
import * as auditRepo from '../../src/infra/sqlite/auditRepo.js';
import { cardinalityOf, DEFAULT_SINGLE_VALUED } from '../../src/core/write/conflict.js';
import { upsertFact, type FactDraft } from '../../src/core/write/harvest.js';
import { mergeOnReobserve, priorFor, rankOf } from '../../src/core/write/confidence.js';

const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-upsert-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function draft(over: Partial<FactDraft> = {}): FactDraft {
  return {
    subject: 'node',
    etype: 'pkg',
    predicate: 'installed_version',
    value: '22.9.0',
    content: 'node 装了 22.9.0',
    confidence: 0.95,
    confidenceSource: 'tool_obs',
    ...over,
  };
}

describe('基数性判定（D9）', () => {
  it('白名单谓词默认单值，其余默认 set', () => {
    expect(cardinalityOf('installed_version')).toBe('single-valued');
    expect(cardinalityOf('occupied_by')).toBe('single-valued');
    expect(cardinalityOf('disk_usage')).toBe('set');
    expect(cardinalityOf('build_count')).toBe('set');
  });

  it('ontology 登记优先于白名单', () => {
    expect(cardinalityOf('disk_usage', { cardinality: 'series' })).toBe('series');
    expect(cardinalityOf('installed_version', { cardinality: 'set' })).toBe('set');
    expect(cardinalityOf('installed_version', { cardinality: null })).toBe('single-valued');
  });

  it('白名单只收真正的单值谓词', () => {
    expect(DEFAULT_SINGLE_VALUED.has('disk_usage')).toBe(false);
    expect(DEFAULT_SINGLE_VALUED.size).toBeLessThanOrEqual(12);
  });
});

describe('置信（详设 §5.8）', () => {
  it('先验：LLM 陈述被压到 0.55，有佐证 0.65', () => {
    expect(priorFor('llm_claim')).toBe(0.55);
    expect(priorFor('llm_claim', { grounded: true })).toBe(0.65);
    expect(priorFor('tool_obs')).toBe(0.95);
    expect(priorFor('tool_obs', { structured: false })).toBe(0.85);
    expect(priorFor('user_confirm')).toBe(0.98);
    expect(priorFor('procedure')).toBe(0.7);
  });

  it('derived 不高于源均值', () => {
    expect(priorFor('derived', { sourceMean: 0.5 })).toBe(0.5);
    expect(priorFor('derived', { sourceMean: 0.99 })).toBe(0.9);
  });

  it('先验表七行全覆盖：human 等同 user_confirm，gat_delta 等同 llm_claim', () => {
    expect(priorFor('human')).toBe(priorFor('user_confirm'));
    expect(priorFor('gat_delta')).toBe(priorFor('llm_claim'));
    expect(priorFor('derived')).toBe(0.9);
    // 所有先验都在 [0,1]，否则 clamp 之后"谁更强"的序会乱
    for (const s of ['llm_claim', 'tool_obs', 'user_confirm', 'gat_delta', 'human', 'derived', 'procedure'] as const) {
      expect(priorFor(s)).toBeGreaterThanOrEqual(0);
      expect(priorFor(s)).toBeLessThanOrEqual(1);
    }
  });

  it('来源强度序', () => {
    expect(rankOf('user_confirm')).toBeGreaterThan(rankOf('tool_obs'));
    expect(rankOf('tool_obs')).toBeGreaterThan(rankOf('derived'));
    expect(rankOf('derived')).toBeGreaterThan(rankOf('llm_claim'));
    expect(rankOf('llm_claim')).toBeGreaterThan(rankOf('gat_delta'));
  });

  it('重复观测：更强抬、同强微加、更弱不动', () => {
    const up = mergeOnReobserve({ value: 0.6, source: 'llm_claim' }, { value: 0.95, source: 'tool_obs' });
    expect(up.changed).toBe(true);
    expect(up.value).toBe(0.95);

    const same = mergeOnReobserve({ value: 0.6, source: 'tool_obs' }, { value: 0.95, source: 'tool_obs' });
    expect(same.value).toBeCloseTo(0.63, 5);

    const weak = mergeOnReobserve({ value: 0.9, source: 'tool_obs' }, { value: 0.55, source: 'llm_claim' });
    expect(weak.changed).toBe(false);
    expect(weak.value).toBe(0.9);
  });

  it('加成有上限', () => {
    const at = mergeOnReobserve({ value: 0.99, source: 'tool_obs' }, { value: 0.99, source: 'tool_obs' });
    expect(at.value).toBe(0.99);
    expect(at.changed).toBe(false);
  });
});

describe('幂等四情形（详设 §2.8）', () => {
  it('A 全新 → created', () => {
    const db = freshDb();
    const r = upsertFact(db, draft());
    expect(r.outcome).toBe('created');
    expect(factRepo.countFacts(db)).toBe(1);
    expect(factRepo.getFact(db, r.factId)?.validTo).toBeNull();
  });

  it('B 完全重复 → refreshed，不新建行，访问计数 +1', () => {
    const db = freshDb();
    const first = upsertFact(db, draft());
    const second = upsertFact(db, draft({ content: '换了个说法' }));
    expect(second.outcome).toBe('refreshed');
    expect(second.factId).toBe(first.factId);
    expect(factRepo.countFacts(db)).toBe(1);
    expect(factRepo.getFact(db, first.factId)?.accessCount).toBe(1);
    // content 不会被改写（append-only）
    expect(factRepo.getFact(db, first.factId)?.content).toBe('node 装了 22.9.0');
  });

  it('B 重复观测抬置信并留审计', () => {
    const db = freshDb();
    const first = upsertFact(db, draft({ confidence: 0.55, confidenceSource: 'llm_claim' }));
    const second = upsertFact(db, draft({ confidence: 0.95, confidenceSource: 'tool_obs' }));
    expect(second.outcome).toBe('refreshed');
    const fact = factRepo.getFact(db, first.factId);
    expect(fact?.confidence).toBe(0.95);
    expect(fact?.confidenceSource).toBe('tool_obs');
    expect(auditRepo.auditByRow(db, 'fact', first.factId).length).toBe(1);
  });

  it('C 复活 → 新行 + supersedes，旧行仍是失效状态', () => {
    const db = freshDb();
    const first = upsertFact(db, draft({ validAt: '2026-01-01T00:00:00.000Z' }));
    // 让第一行失效（模拟单值被新取值取代）
    const second = upsertFact(
      db,
      draft({ value: '24.0.0', validAt: '2026-02-01T00:00:00.000Z' }),
    );
    expect(second.outcome).toBe('superseded');
    expect(factRepo.getFact(db, first.factId)?.validTo).not.toBeNull();

    // 又观测到 22.9.0：旧行不能复活，只能是新行
    const third = upsertFact(db, draft({ validAt: '2026-03-01T00:00:00.000Z' }));
    expect(third.outcome).toBe('recreated');
    expect(third.factId).not.toBe(first.factId);
    expect(factRepo.countFacts(db)).toBe(3);

    const edges = edgeRepo.neighbors(db, first.factId, { includeClosed: true });
    expect(edges.some((e) => e.etype === 'supersedes' && e.src === first.factId)).toBe(true);
  });

  it('D 单值谓词不同取值 → 旧行收口 + supersedes + mutex + 裁决快照', () => {
    const db = freshDb();
    const a = upsertFact(db, draft({ validAt: '2026-01-01T00:00:00.000Z' }));
    const b = upsertFact(db, draft({ value: '24.0.0', validAt: '2026-02-01T00:00:00.000Z' }));

    expect(b.outcome).toBe('superseded');
    expect(b.conflict.invalidated).toEqual([a.factId]);
    expect(b.conflict.supersedesEdges).toHaveLength(1);
    expect(b.conflict.mutexEdges).toHaveLength(1);
    expect(b.conflict.adjudications).toHaveLength(1);

    const old = factRepo.getFact(db, a.factId);
    expect(old?.validTo).toBe('2026-02-01T00:00:00.000Z');
    expect(old?.supersededBy).toBe(b.factId);
    expect(old?.epistemicStatus).toBe('invalidated');

    const adj = adjudicationRepo.getAdjudication(db, b.conflict.adjudications[0] as string);
    expect(adj?.kind).toBe('temporal_invalidate');
    expect(adj?.decidedBy).toBe('single_valued_supersede@1');
    expect(adj?.outcome).toBeNull(); // 写入时只记录，胜者读取时算
  });

  it('D series 谓词 → 并存 + co_occur，不收口', () => {
    const db = freshDb();
    const a = upsertFact(db, draft({ predicate: 'disk_usage', value: '12GB' }));
    const b = upsertFact(db, draft({ predicate: 'disk_usage', value: '13GB' }), {
      ontology: () => ({ cardinality: 'series' }),
    });
    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('coexist');
    expect(b.conflict.invalidated).toEqual([]);
    expect(b.conflict.coOccurEdges).toHaveLength(1);
    expect(factRepo.getFact(db, a.factId)?.validTo).toBeNull();
    expect(factRepo.countFacts(db)).toBe(2);
  });

  it('D set 谓词 → 并存但完全不建边（D9 的误报防线）', () => {
    const db = freshDb();
    upsertFact(db, draft({ predicate: 'build_count', value: 1 }));
    const b = upsertFact(db, draft({ predicate: 'build_count', value: 2 }));
    expect(b.outcome).toBe('coexist');
    expect(b.conflict.mutexEdges).toEqual([]);
    expect(b.conflict.coOccurEdges).toEqual([]);
    expect(edgeRepo.countEdges(db)).toBe(0);
  });

  it('ontology 可以把白名单谓词改成 set（登记覆盖默认）', () => {
    const db = freshDb();
    upsertFact(db, draft({ value: '22.9.0' }));
    const b = upsertFact(db, draft({ value: '24.0.0' }), {
      ontology: () => ({ cardinality: 'set' }),
    });
    expect(b.outcome).toBe('coexist');
    expect(b.conflict.invalidated).toEqual([]);
  });

  it('同一批写入跑两次，行数不变（幂等）', () => {
    const db = freshDb();
    const batch: FactDraft[] = [
      draft(),
      draft({ subject: 'pnpm', predicate: 'installed_version', value: '10.15.1' }),
      draft({ subject: '8080', etype: 'port', predicate: 'occupied_by', value: 'nginx' }),
    ];
    for (const d of batch) upsertFact(db, d);
    const after1 = factRepo.countFacts(db);
    for (const d of batch) upsertFact(db, d);
    expect(factRepo.countFacts(db)).toBe(after1);
    expect(after1).toBe(3);
  });

  it('provisional 主体也能走完幂等（key 非空）', () => {
    const db = freshDb();
    const a = upsertFact(db, draft({ subject: '不知名端口的东西', etype: 'port' }));
    const b = upsertFact(db, draft({ subject: '不知名端口的东西', etype: 'port' }));
    expect(a.identity).toBe('unresolved');
    expect(b.outcome).toBe('refreshed');
    expect(factRepo.countFacts(db)).toBe(1);
  });
});
