/**
 * P1-07 子图构建与预算裁剪单测（详设 §6.6）。
 *
 * 验收：seeds=前 8；BFS 2 跳上限 64；边上限 192（两端在内优先）；
 * 邻居优先级 mutually_exclusive > depends_on > supersedes > logic > co_occur > derived_from；
 * 节点排序全序稳定。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/domain/ids.js';
import { nowIso } from '../../src/domain/time.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import * as edgeRepo from '../../src/infra/sqlite/edgeRepo.js';
import type { Etype } from '../../src/domain/enums.js';
import { buildSubgraph } from '../../src/core/read/subgraph.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-subg-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addFact(db: Db, id: string): void {
  const ts = nowIso();
  factRepo.insertFact(db, {
    id, content: `fact ${id}`, ftype: 'semantic', confidence: 0.9, confidenceSource: 'tool_obs',
    strength: 0.5, importance: 0.5, pool: 'utility', epistemicStatus: 'active',
    attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id }, ext: {} },
    canonicalKey: `ck_${id}`, valueHash: `vh_${id}`, scope: 'global', supersededBy: null,
    validAt: ts, validTo: null, recordedAt: ts, communityId: null, degree: 0, accessCount: 0,
    lastAccessAt: null, lastDecayAt: ts, sourceEpisode: null, span: null, createdAt: ts, updatedAt: ts,
  });
}

function addEdge(db: Db, src: string, dst: string, etype: Etype, conf = 0.9): void {
  edgeRepo.insertEdge(db, {
    id: newId('edge'), src, dst, etype, weight: 1.0, confidence: conf, validAt: nowIso(),
  });
}

describe('子图构建（P1-07）', () => {
  it('seeds = 融合前 8；BFS 2 跳纳入邻居', () => {
    const db = freshDb();
    addFact(db, 'f_s');
    addFact(db, 'f_a');
    addFact(db, 'f_b');
    addEdge(db, 'f_s', 'f_a', 'depends_on');
    addEdge(db, 'f_a', 'f_b', 'depends_on'); // 2 跳
    const g = buildSubgraph(db, ['f_s', 'f_other'], { seedLimit: 8 });
    const ids = g.nodes.map((n) => n.fact_id);
    expect(ids.slice(0, 2)).toEqual(['f_s', 'f_other']);
    expect(ids).toContain('f_a');
    expect(ids).toContain('f_b');
    expect(g.nodes.filter((n) => n.isSeed).length).toBe(2);
  });

  it('节点上限 64：超额时截断且种子都在', () => {
    const db = freshDb();
    const seed = 'f_s0';
    addFact(db, seed);
    for (let i = 1; i <= 100; i += 1) {
      addFact(db, `f_n${i}`);
      addEdge(db, seed, `f_n${i}`, 'co_occur');
    }
    const g = buildSubgraph(db, [seed]);
    expect(g.nodes.length).toBeLessThanOrEqual(64);
    expect(g.nodes[0]!.isSeed).toBe(true);
  });

  it('邻居优先级：mutually_exclusive 先于 depends_on 扩展（同级 confidence 降序）', () => {
    const db = freshDb();
    addFact(db, 'f_s');
    addFact(db, 'f_mx_low');
    addFact(db, 'f_dep_high');
    addEdge(db, 'f_s', 'f_mx_low', 'mutually_exclusive', 0.5);
    addEdge(db, 'f_s', 'f_dep_high', 'depends_on', 0.99);
    const g = buildSubgraph(db, ['f_s']);
    // 扩展优先级体现在边收集顺序：mx 边先于 depends_on 边
    expect(g.edges[0]!.etype).toBe('mutually_exclusive');
    expect(g.edges[1]!.etype).toBe('depends_on');
    // 两个邻居都进子图；节点排序仍按全序（同 degree → id asc）
    expect(g.nodes.map((n) => n.fact_id).slice(1).sort()).toEqual(['f_dep_high', 'f_mx_low']);
  });

  it('边上限 192 且两端在内优先', () => {
    const db = freshDb();
    const seed = 'f_s';
    addFact(db, seed);
    // 100 条内部边（seed 连 100 个节点）不超上限；再挂 100 条外部边
    for (let i = 1; i <= 100; i += 1) {
      addFact(db, `f_i${i}`);
      addEdge(db, seed, `f_i${i}`, 'depends_on');
    }
    for (let i = 1; i <= 100; i += 1) {
      addFact(db, `f_o${i}`);
      addEdge(db, seed, `f_o${i}`, 'logic');
    }
    const g = buildSubgraph(db, [seed]);
    expect(g.edges.length).toBeLessThanOrEqual(192);
    // 内部边优先：前 100 条全是 depends_on（两端在内）
    expect(g.edges.slice(0, 100).every((e) => e.etype === 'depends_on')).toBe(true);
  });

  it('节点排序全序稳定：(isSeed desc, fusedRank asc, degree desc, id asc)', () => {
    const db = freshDb();
    addFact(db, 'f_s1');
    addFact(db, 'f_s2');
    addFact(db, 'f_n1');
    addFact(db, 'f_n2');
    addEdge(db, 'f_s1', 'f_n1', 'co_occur');
    addEdge(db, 'f_s2', 'f_n2', 'co_occur');
    const a = buildSubgraph(db, ['f_s2', 'f_s1']);
    const b = buildSubgraph(db, ['f_s2', 'f_s1']);
    expect(a.nodes.map((n) => n.fact_id)).toEqual(b.nodes.map((n) => n.fact_id));
    // seeds 前、按 fusedRank
    expect(a.nodes[0]!.fact_id).toBe('f_s2');
    expect(a.nodes[1]!.fact_id).toBe('f_s1');
  });
});
