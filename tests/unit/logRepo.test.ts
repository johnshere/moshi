/**
 * P1-12 query_log / evidence_log 埋点单测（详设 §6.12；台账 P1-12）。
 *
 * 验收：一次查询写齐两表；查 10 次 → query_log 10 行、evidence_log 与入包数
 * 一致；flags_json 有开关快照；写失败不影响调用方（不抛）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../../src/infra/sqlite/factRepo.js';
import * as logRepo from '../../src/infra/sqlite/logRepo.js';
import type { QueryLogInput } from '../../src/infra/sqlite/logRepo.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-log-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  for (const [id, content] of [
    ['f1', 'fact one'],
    ['f2', 'fact two'],
  ] as const) {
    insertFact(db, {
      id, content, ftype: 'semantic', confidence: 0.5, confidenceSource: 'tool_obs',
      strength: 0.5, importance: 0.5, pool: 'utility', epistemicStatus: 'active',
      attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: content }, ext: {} },
      canonicalKey: `ck_${id}`, valueHash: `vh_${id}`, scope: 'global', supersededBy: null,
      validAt: '2026-10-01T00:00:00.000Z', validTo: null, recordedAt: '2026-10-01T00:00:00.000Z',
      communityId: null, degree: 0, accessCount: 0, lastAccessAt: null, lastDecayAt: '2026-10-01T00:00:00.000Z',
      sourceEpisode: null, span: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
  }
  opened.push(db);
  return db;
}

function logInput(id: string): QueryLogInput {
  return {
    id,
    ts: '2026-11-01T10:00:00.000Z',
    queryText: `query ${id}`,
    queryHash: `h_${id}`,
    route: 'local',
    flags: { gat: 'off', self_attn: 'off', cross_attn: 'off', vector: 'on', bm25: 'on', ppr: 'on' },
    candidates: { vector: ['f1'], bm25: ['f1'] },
    fused: [{ fact_id: 'f1', rrf: 0.5 }],
    packed: ['f1', 'f2'],
    degraded: [],
    truncated: false,
    coverage: 'full',
    latencyMs: 12.5,
    stageMs: { route: 0.2, recognize: 1.1 },
    cached: false,
  };
}

describe('埋点（P1-12）', () => {
  it('一次查询写齐两表；flags_json 有开关快照', () => {
    const db = freshDb();
    logRepo.logQuery(
      db,
      logInput('q1'),
      [
        { queryId: 'q1', mId: 1, factId: 'f1', rank: 1, score: 0.9, pool: 'utility' },
        { queryId: 'q1', mId: 2, factId: 'f2', rank: 2, score: 0.7, pool: 'value_floor' },
      ],
    );
    const q = db.prepare('SELECT flags_json, packed_json, degraded_json, cached FROM query_log WHERE id = ?').get('q1') as {
      flags_json: string; packed_json: string; degraded_json: string | null; cached: number;
    };
    expect(q.flags_json).toContain('"bm25":"on"');
    expect(q.flags_json).toContain('"ppr":"on"');
    expect(JSON.parse(q.packed_json)).toEqual(['f1', 'f2']);
    expect(q.cached).toBe(0);
    const ev = db.prepare('SELECT m_id, fact_id, score FROM evidence_log WHERE query_id = ? ORDER BY m_id').all('q1') as unknown[];
    expect(ev).toHaveLength(2);
  });

  it('查 10 次 → query_log 10 行；evidence_log 与入包数一致', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) {
      const id = `q${i}`;
      logRepo.logQuery(db, logInput(id), [{ queryId: id, mId: 1, factId: 'f1', rank: 1, score: 0.5, pool: 'utility' }]);
    }
    const qn = db.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number };
    const en = db.prepare('SELECT COUNT(*) AS n FROM evidence_log').get() as { n: number };
    expect(qn.n).toBe(10);
    expect(en.n).toBe(10); // 与入包数一致（10 次 × 1 条）
  });

  it('写失败不影响调用方（db 已关闭 → 不抛）', () => {
    const db = freshDb();
    const log = logInput('q_fail');
    closeDb(db);
    expect(() => logRepo.logQuery(db, log, [{ queryId: 'q_fail', mId: 1, factId: 'f1', rank: 1, score: 0.5, pool: 'utility' }])).not.toThrow();
  });
});
