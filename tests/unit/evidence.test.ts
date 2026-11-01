/**
 * P1-10 证据包组装与编号单测（详设 §6.9 / §4.4）。
 *
 * 验收：m_id 从 1 连续；numbered_list 格式 +（存疑）；conflicts 只留两端
 * 都在 evidence；dependency_summary 最多 10 条 depends_on；topic_hint 众数
 * community_id（无摘要 → partial）；confidence_summary 取值表；
 * status = degraded 非空 ? degraded : ok；advice 空包 = "无可靠记忆，请勿臆断"。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import type { Epistemic } from '../../src/domain/enums.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { assembleEvidence } from '../../src/core/read/evidence.js';
import { packFacts } from '../../src/core/read/pack.js';
import type { AdjudicatedFact } from '../../src/core/read/adjudicate.js';
import type { Fact } from '../../src/domain/types.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-ev-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function fact(id: string, opts: { conf?: number; community?: number | null; status?: string; content?: string } = {}): Fact {
  return {
    id,
    content: opts.content ?? `content ${id}`,
    ftype: 'semantic',
    confidence: opts.conf ?? 0.9,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: (opts.status ?? 'active') as Epistemic,
    attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id }, ext: {} },
    canonicalKey: `ck_${id}`, valueHash: `vh_${id}`, scope: 'global', supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z', validTo: null, recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: opts.community ?? null, degree: 0, accessCount: 0, lastAccessAt: null,
    lastDecayAt: '2026-10-01T00:00:00.000Z', sourceEpisode: null, span: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function adj(f: Fact, flags: string[] = []): AdjudicatedFact {
  return { fact: f, finalScore: f.confidence, flags: flags as never, disputedBy: null };
}

describe('证据包组装（P1-10）', () => {
  it('m_id 连续 + numbered_list 格式（含 起/至、存疑）', () => {
    const db = freshDb();
    const a = fact('f_a', { conf: 0.9, content: '服务运行正常' });
    const b = fact('f_b', { conf: 0.7, status: 'disputed', content: '旧端口' });
    const packed = packFacts([adj(a), adj(b, ['disputed'])], {});
    const ev = assembleEvidence(db, 'q_test', packed.items, { route: 'local', degraded: [], latencyMs: 12, candidates: 2 });
    expect(ev.evidence.map((e) => e.m_id)).toEqual([1, 2]);
    expect(ev.evidence[0]!.fact_id).toBe('f_a');
    expect(ev.numbered_list[0]).toContain('[M1] (0.9, 2026-10-01 起) 服务运行正常');
    expect(ev.numbered_list[0]).not.toContain('f_a'); // numbered_list 不含 fact_id
    expect(ev.numbered_list[1]).toContain('（存疑）');
  });

  it('conflicts 只留两端都在 evidence；dependency_summary 最多 10 条 depends_on', () => {
    const db = freshDb();
    const a = fact('f_a');
    const b = fact('f_b');
    const packed = packFacts([adj(a), adj(b)], {});
    const ev = assembleEvidence(db, 'q1', packed.items, {
      route: 'local', degraded: [], latencyMs: 1, candidates: 4,
      conflicts: [
        { a: 'f_a', b: 'f_b', type: 'mutex', resolved: null, rule: 'r1' },
        { a: 'f_a', b: 'f_out', type: 'mutex', resolved: null, rule: 'r1' }, // 端不在 evidence
      ],
      edges: Array.from({ length: 12 }, () => ({
        src: `f_a`, dst: `f_b`, etype: 'depends_on' as const, weight: 1, confidence: 0.9,
      })),
    });
    expect(ev.conflicts.length).toBe(1);
    expect(ev.conflicts[0]!.b).toBe('f_b');
    expect(ev.dependency_summary.length).toBe(10); // 上限
    expect(ev.dependency_summary.every((d) => d.edge === 'depends_on')).toBe(true);
  });

  it('topic_hint：众数 community_id；无摘要 → coverage partial', () => {
    const db = freshDb();
    const a = fact('f_a', { community: 3 });
    const b = fact('f_b', { community: 3 });
    const c = fact('f_c', { community: 7 });
    const packed = packFacts([adj(a), adj(b), adj(c)], {});
    db.prepare(
      `INSERT INTO community_summary (community_id, scope, label, summary, fact_count, derived_at, source_rev)
       VALUES (3, 'global', 'node生态', '摘要', 12, '2026-10-01T00:00:00.000Z', 1)`,
    ).run();
    const ev = assembleEvidence(db, 'q2', packed.items, { route: 'local', degraded: [], latencyMs: 1, candidates: 3 });
    expect(ev.topic_hint.community_id).toBe(3);
    expect(ev.topic_hint.label).toBe('node生态');
    expect(ev.topic_hint.uri).toBe('moshi://topic/node生态');
    expect(ev.coverage).toBe('full');

    // 无 community_id → partial
    const d = fact('f_d');
    const ev2 = assembleEvidence(db, 'q3', packFacts([adj(d)], {}).items, { route: 'local', degraded: [], latencyMs: 1, candidates: 1 });
    expect(ev2.topic_hint.community_id).toBeNull();
    expect(ev2.coverage).toBe('partial');
  });

  it('confidence_summary 取值表 + 空包 advice', () => {
    const db = freshDb();
    const hi = packFacts([adj(fact('f_hi', { conf: 0.9 }))], {});
    expect(assembleEvidence(db, 'q4', hi.items, { route: 'local', degraded: [], latencyMs: 1, candidates: 1 }).confidence_summary).toBe('high');

    const med = packFacts([adj(fact('f_med', { conf: 0.7 }))], {});
    expect(assembleEvidence(db, 'q5', med.items, { route: 'local', degraded: [], latencyMs: 1, candidates: 1 }).confidence_summary).toBe('medium');

    const low = packFacts([adj(fact('f_low', { conf: 0.55 }))], {});
    expect(assembleEvidence(db, 'q6', low.items, { route: 'local', degraded: [], latencyMs: 1, candidates: 1 }).confidence_summary).toBe('low');

    const empty = assembleEvidence(db, 'q7', [], { route: 'local', degraded: [], latencyMs: 1, candidates: 0 });
    expect(empty.confidence_summary).toBe('none');
    expect(empty.advice).toBe('无可靠记忆，请勿臆断');
  });

  it('status = degraded 非空 ? degraded : ok；identity 反映 unresolved', () => {
    const db = freshDb();
    const a = fact('f_a', { conf: 0.9 });
    const packed = packFacts([adj(a)], {});
    expect(assembleEvidence(db, 'q8', packed.items, { route: 'local', degraded: [], latencyMs: 1, candidates: 1 }).status).toBe('ok');
    expect(assembleEvidence(db, 'q9', packed.items, { route: 'local', degraded: ['no_ppr'], latencyMs: 1, candidates: 1 }).status).toBe('degraded');

    const u = packFacts([adj(fact('f_u', { conf: 0.9 }), ['identity_unresolved'])], {});
    expect(assembleEvidence(db, 'q10', u.items, { route: 'local', degraded: [], latencyMs: 1, candidates: 1 }).identity).toBe('unresolved');
  });
});
