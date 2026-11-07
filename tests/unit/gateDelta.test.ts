/**
 * P3-08 δ 门控与重跑裁决（详设 §7.5）。
 *
 * 覆盖五步里的关键分支：
 * - clamp 到 `delta_cap`；`overturn_prob > 0.5` 且 δ<0 → 丢弃；
 * - 用 cand 重跑裁决：同组**胜者换人**就整组回退（mutex_flip）；
 * - 存活者落库 `confidence_source='gat_delta'` + audit（reason `model:<ver>`）；
 * - `persist:false` 只算不写；模型给不在候选里的事实打分 = 忽略。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { getFact, insertFact } from '../../src/infra/sqlite/factRepo.js';
import { applyNeuralDeltas, gateOne, type NeuralScore } from '../../src/core/read/gate-delta.js';
import type { Fact } from '../../src/domain/types.js';
import type { Epistemic } from '../../src/domain/enums.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-gate-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function fact(id: string, opts: { conf?: number; strength?: number; pred?: string; key?: string } = {}): Fact {
  return {
    id,
    content: `content ${id}`,
    ftype: 'semantic',
    confidence: opts.conf ?? 0.9,
    confidenceSource: 'tool_obs',
    strength: opts.strength ?? 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: 'active' as Epistemic,
    attrs: {
      frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: opts.pred ?? 'state', value: id },
      ext: {},
    },
    canonicalKey: opts.key ?? `ck_${id}`,
    valueHash: `vh_${id}`,
    scope: 'global',
    supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: null,
    span: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function registerPredicate(db: Db, name: string, cardinality: 'single-valued' | 'series' | 'set'): void {
  db.prepare(
    `INSERT INTO ontology (kind, name, cardinality, registered_at, promoted)
     VALUES ('predicate', ?, ?, ?, 0)`,
  ).run(name, cardinality, '2026-10-01T00:00:00.000Z');
}

const NOW = '2026-11-01T00:00:00.000Z';

describe('gateOne（§7.5 步骤 1–3）', () => {
  it('δ 超过 delta_cap 时 clamp', () => {
    const r = gateOne(0.5, { delta: 1.0, overturnProb: 0.1 }, 0.15);
    expect(r.applied).toBe(true);
    expect(r.value).toBeCloseTo(0.65);
    expect(r.delta).toBeCloseTo(0.15);
    const neg = gateOne(0.5, { delta: -1.0, overturnProb: 0.1 }, 0.15);
    expect(neg.value).toBeCloseTo(0.35);
  });

  it('overturn_prob > 0.5 且 δ<0 → 丢弃', () => {
    const r = gateOne(0.5, { delta: -0.1, overturnProb: 0.7 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('overturn_guard');
    expect(r.value).toBe(0.5);
  });

  it('cand 夹到 [0,1]；δ=0 视为无变化', () => {
    expect(gateOne(0.98, { delta: 0.15, overturnProb: 0.1 }).value).toBe(1);
    expect(gateOne(0.02, { delta: -0.15, overturnProb: 0.1 }).value).toBe(0);
    const zero = gateOne(0.5, { delta: 0, overturnProb: 0.1 });
    expect(zero.applied).toBe(false);
    expect(zero.reason).toBe('unchanged');
  });
});

describe('applyNeuralDeltas（§7.5 步骤 4–6）', () => {
  it('无互斥组：δ 生效并进入裁决结果', () => {
    const db = freshDb();
    const f = fact('f_a', { conf: 0.5 });
    const scores = new Map<string, NeuralScore>([['f_a', { delta: 0.1, overturnProb: 0.1 }]]);

    const r = applyNeuralDeltas(db, [f], [], { scores, now: NOW, persist: false });

    expect(r.applied).toEqual([{ factId: 'f_a', before: 0.5, after: 0.6, delta: 0.1 }]);
    expect(r.rejected).toEqual([]);
    expect(r.result.kept[0]!.fact.confidence).toBeCloseTo(0.6);
  });

  it('落库：confidence 改 gat_delta 并写 audit（reason=model:<ver>）', () => {
    const db = freshDb();
    insertFact(db, fact('f_a', { conf: 0.5 }));
    const scores = new Map<string, NeuralScore>([['f_a', { delta: 0.1, overturnProb: 0.1 }]]);

    applyNeuralDeltas(db, [fact('f_a', { conf: 0.5 })], [], {
      scores,
      now: NOW,
      modelVersion: 'gat-v1@abc',
    });

    const after = getFact(db, 'f_a')!;
    expect(after.confidence).toBeCloseTo(0.6);
    expect(after.confidenceSource).toBe('gat_delta');
    const audit = db
      .prepare("SELECT field, source, reason, before_json AS beforeJson, after_json AS afterJson FROM audit WHERE row_id = 'f_a' AND field = 'confidence'")
      .get() as { field: string; source: string; reason: string; beforeJson: string; afterJson: string };
    expect(audit.source).toBe('gat_delta');
    expect(audit.reason).toBe('model:gat-v1@abc');
    expect(JSON.parse(audit.afterJson).confidence).toBeCloseTo(0.6);
  });

  it('persist:false 不写库', () => {
    const db = freshDb();
    insertFact(db, fact('f_a', { conf: 0.5 }));
    const scores = new Map<string, NeuralScore>([['f_a', { delta: 0.1, overturnProb: 0.1 }]]);
    applyNeuralDeltas(db, [fact('f_a', { conf: 0.5 })], [], { scores, now: NOW, persist: false });
    expect(getFact(db, 'f_a')!.confidence).toBeCloseTo(0.5);
  });

  it('互斥组胜者换人 → 整组回退（mutex_flip），不落库', () => {
    const db = freshDb();
    registerPredicate(db, 'port_open', 'single-valued');
    const win = fact('f_win', { conf: 0.9, pred: 'port_open', key: 'ck_same' });
    const lose = fact('f_lose', { conf: 0.85, pred: 'port_open', key: 'ck_same' });
    insertFact(db, win);
    insertFact(db, lose);

    // 败者 +0.15 → 1.0，超过胜者 0.9，互斥胜负翻转
    const scores = new Map<string, NeuralScore>([['f_lose', { delta: 0.15, overturnProb: 0.1 }]]);
    const r = applyNeuralDeltas(db, [win, lose], [], { scores, now: NOW, modelVersion: 'v' });

    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([{ factId: 'f_lose', reason: 'mutex_flip' }]);
    expect(getFact(db, 'f_lose')!.confidence).toBeCloseTo(0.85);
  });

  it('互斥组未翻转 → 正常生效', () => {
    const db = freshDb();
    registerPredicate(db, 'port_open', 'single-valued');
    const win = fact('f_win', { conf: 0.9, pred: 'port_open', key: 'ck_same' });
    const lose = fact('f_lose', { conf: 0.6, pred: 'port_open', key: 'ck_same' });

    const scores = new Map<string, NeuralScore>([['f_lose', { delta: 0.05, overturnProb: 0.1 }]]);
    const r = applyNeuralDeltas(db, [win, lose], [], { scores, now: NOW, persist: false });

    expect(r.applied.map((a) => a.factId)).toEqual(['f_lose']);
    expect(r.result.kept.find((k) => k.fact.id === 'f_lose')!.disputedBy).toBe('f_win');
  });

  it('模型给不在候选里的事实打分 → 忽略', () => {
    const db = freshDb();
    const f = fact('f_a', { conf: 0.5 });
    const scores = new Map<string, NeuralScore>([['f_ghost', { delta: 0.1, overturnProb: 0.1 }]]);
    const r = applyNeuralDeltas(db, [f], [], { scores, now: NOW, persist: false });
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([]);
  });
});

describe('落库原子性（P3-08 验收后修复）', () => {
  it('中途失败整批回滚：不留"改了一半"的置信', () => {
    const db = freshDb();
    insertFact(db, fact('f_a', { conf: 0.5 }));
    // f_b 故意不写库：setConfidence 会抛 E_NOT_FOUND，触发事务回滚
    const facts = [fact('f_a', { conf: 0.5 }), fact('f_b', { conf: 0.5 })];
    const scores = new Map<string, NeuralScore>([
      ['f_a', { delta: 0.1, overturnProb: 0.1 }],
      ['f_b', { delta: 0.1, overturnProb: 0.1 }],
    ]);

    expect(() =>
      applyNeuralDeltas(db, facts, [], { scores, now: NOW, modelVersion: 'v' }),
    ).toThrow();

    // f_a 的更新必须被回滚
    expect(getFact(db, 'f_a')!.confidence).toBeCloseTo(0.5);
    expect(getFact(db, 'f_a')!.confidenceSource).toBe('tool_obs');
  });
});
