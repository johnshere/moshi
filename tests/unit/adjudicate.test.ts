/**
 * P1-08 符号兜底五步单测（详设 §6.7，硬顺序）。
 *
 * 验收：时态失效排除；互斥（ontology single-valued + winner=argmax(conf×strength)
 * + 写 adjudication 去重）；低置信不进包；depends_on 前置失效标 stale_dependency；
 * 实体 unknown 标 identity_unresolved；finalScore = 0.55×base+0.30×neural+0.15×strength。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import type { Epistemic } from '../../src/domain/enums.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEntity } from '../../src/infra/sqlite/entityRepo.js';
import { adjudicate } from '../../src/core/read/adjudicate.js';
import type { Fact } from '../../src/domain/types.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-adju-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function fact(
  id: string,
  opts: { conf?: number; strength?: number; validTo?: string | null; status?: string; pred?: string; subj?: string; key?: string } = {},
): Fact {
  return {
    id,
    content: `content ${id}`,
    ftype: 'semantic',
    confidence: opts.conf ?? 0.9,
    confidenceSource: 'tool_obs',
    strength: opts.strength ?? 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: (opts.status ?? 'active') as Epistemic,
    attrs: {
      frozen: { subject: { entity_id: opts.subj ?? `en_${id}`, name: id }, predicate: opts.pred ?? 'state', value: id },
      ext: {},
    },
    canonicalKey: opts.key ?? `ck_${id}`,
    valueHash: `vh_${id}`,
    scope: 'global',
    supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z',
    validTo: opts.validTo ?? null,
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

describe('符号兜底五步（P1-08）', () => {
  it('① 时态失效：valid_to <= now 被排除', () => {
    const db = freshDb();
    const f = fact('f_old', { validTo: '2026-09-01T00:00:00.000Z' });
    const res = adjudicate(db, [f], [], { now: '2026-11-01T00:00:00.000Z' });
    expect(res.kept).toEqual([]);
    expect(res.stats.historical_excluded).toBe(1);
  });

  it('② 互斥：同 key + single-valued → 败者 disputed，写 adjudication 且去重', () => {
    const db = freshDb();
    registerPredicate(db, 'port_open', 'single-valued');
    const win = fact('f_win', { conf: 0.95, strength: 0.8, pred: 'port_open', key: 'ck_same' });
    const lose = fact('f_lose', { conf: 0.6, strength: 0.7, pred: 'port_open', key: 'ck_same' });
    const r1 = adjudicate(db, [win, lose], [], { now: '2026-11-01T00:00:00.000Z' });
    expect(r1.stats.disputed).toBe(1);
    expect(r1.adjudicationWrites).toBe(1);
    const loseOut = r1.kept.find((k) => k.fact.id === 'f_lose')!;
    expect(loseOut.flags).toContain('disputed');
    expect(loseOut.disputedBy).toBe('f_win');
    // 第二次运行：裁决已存在 → 去重不写
    const r2 = adjudicate(db, [win, lose], [], { now: '2026-11-01T00:00:00.000Z' });
    expect(r2.adjudicationWrites).toBe(0);
  });

  it('② 非 single-valued（series）不判互斥', () => {
    const db = freshDb();
    registerPredicate(db, 'episode', 'series');
    const a = fact('f_a', { conf: 0.95, pred: 'episode', key: 'ck_same' });
    const b = fact('f_b', { conf: 0.6, pred: 'episode', key: 'ck_same' });
    const res = adjudicate(db, [a, b], [], { now: '2026-11-01T00:00:00.000Z' });
    expect(res.stats.disputed).toBe(0);
  });

  it('③ confidence < 0.5 不进包', () => {
    const db = freshDb();
    const low = fact('f_low', { conf: 0.4 });
    const ok = fact('f_ok', { conf: 0.9 });
    const res = adjudicate(db, [low, ok], [], { now: '2026-11-01T00:00:00.000Z' });
    expect(res.kept.map((k) => k.fact.id)).toEqual(['f_ok']);
    expect(res.stats.low_confidence_dropped).toBe(1);
  });

  it('④ depends_on 前置 invalidated → 后置 stale_dependency', () => {
    const db = freshDb();
    const dep = fact('f_dep', { status: 'invalidated' });
    const consumer = fact('f_consumer');
    const edges = [{ src: 'f_dep', dst: 'f_consumer', etype: 'depends_on' as const, weight: 1, confidence: 0.9 }];
    const res = adjudicate(db, [dep, consumer], edges, { now: '2026-11-01T00:00:00.000Z' });
    const c = res.kept.find((k) => k.fact.id === 'f_consumer')!;
    expect(c.flags).toContain('stale_dependency');
    expect(res.stats.stale_dependency).toBe(1);
  });

  it('⑤ subject 实体 unknown → identity_unresolved', () => {
    const db = freshDb();
    const ent = insertEntity(db, { canonicalName: 'mystery', etype: 'unknown' });
    const f = fact('f_u', { subj: ent.id });
    const res = adjudicate(db, [f], [], { now: '2026-11-01T00:00:00.000Z' });
    expect(res.kept[0]!.flags).toContain('identity_unresolved');
    expect(res.stats.identity_unresolved).toBe(1);
  });

  it('finalScore = 0.55×base + 0.30×(conf+δ) + 0.15×strength', () => {
    const db = freshDb();
    const f = fact('f_s', { conf: 0.8, strength: 0.4 });
    const base = new Map([['f_s', 0.6]]);
    const res = adjudicate(db, [f], [], { now: '2026-11-01T00:00:00.000Z', base });
    expect(res.kept[0]!.finalScore).toBeCloseTo(0.55 * 0.6 + 0.3 * 0.8 + 0.15 * 0.4);

    // GAT δ 只落在 neural 项里（P3 才用），base 缺省时退化为 0.30×conf + 0.15×strength
    const withDelta = adjudicate(db, [f], [], {
      now: '2026-11-01T00:00:00.000Z',
      base,
      neural: new Map([['f_s', 0.1]]),
    });
    expect(withDelta.kept[0]!.finalScore).toBeCloseTo(0.55 * 0.6 + 0.3 * 0.9 + 0.15 * 0.4);
  });
});
