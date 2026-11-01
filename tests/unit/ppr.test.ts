/**
 * P1-04 PPR 图扩散单测（详设 §6.4.3）。
 *
 * 验收：3 跳链 A→B→C→D，问 A 时 C 出现、D 不出现（BFS 只收 2 跳）；
 * 超时返回当前结果 + timedOut（上层标 no_ppr）；种子排除；权重差异。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/domain/ids.js';
import { nowIso } from '../../src/domain/time.js';
import type { Etype } from '../../src/domain/enums.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import * as edgeRepo from '../../src/infra/sqlite/edgeRepo.js';
import { recallPpr } from '../../src/core/read/recall/ppr.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-ppr-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addFact(db: Db, id: string): void {
  const ts = nowIso();
  factRepo.insertFact(db, {
    id,
    content: `fact ${id}`,
    ftype: 'semantic',
    confidence: 0.9,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs: {
      frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id },
      ext: {},
    },
    canonicalKey: `ck_${id}`,
    valueHash: `vh_${id}`,
    scope: 'global',
    supersededBy: null,
    validAt: ts,
    validTo: null,
    recordedAt: ts,
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: ts,
    sourceEpisode: null,
    span: null,
    createdAt: ts,
    updatedAt: ts,
  });
}

function addEdge(db: Db, src: string, dst: string, etype: Etype, weight = 1.0): void {
  edgeRepo.insertEdge(db, {
    id: newId('edge'),
    src,
    dst,
    etype,
    weight,
    validAt: nowIso(),
  });
}

describe('PPR 图扩散（P1-04）', () => {
  it('验收：3 跳链 A→B→C→D，问 A 时 C 出现、D 不出现', () => {
    const db = freshDb();
    for (const id of ['f_a', 'f_b', 'f_c', 'f_d']) addFact(db, id);
    addEdge(db, 'f_a', 'f_b', 'depends_on');
    addEdge(db, 'f_b', 'f_c', 'depends_on');
    addEdge(db, 'f_c', 'f_d', 'depends_on');

    const res = recallPpr(db, ['f_a']);
    expect(res.ids).toContain('f_c'); // 2 跳内可达
    expect(res.ids).not.toContain('f_d'); // 3 跳外不收集
    expect(res.ids).not.toContain('f_a'); // 种子排除
    expect(res.nodes).toBe(3); // A,B,C（BFS 2 跳，D 在外）
    expect(res.timedOut).toBe(false);
  });

  it('种子不出现；分数降序且非负', () => {
    const db = freshDb();
    for (const id of ['f_a', 'f_b', 'f_c']) addFact(db, id);
    addEdge(db, 'f_a', 'f_b', 'logic');
    addEdge(db, 'f_b', 'f_c', 'logic');

    const res = recallPpr(db, ['f_a']);
    expect(res.ids).toEqual(['f_b', 'f_c']); // 一跳 B 的 p 高于两跳 C
    expect(res.scores.every((s) => s > 0)).toBe(true);
    for (let i = 1; i < res.scores.length; i += 1) {
      expect(res.scores[i - 1]!).toBeGreaterThanOrEqual(res.scores[i]!);
    }
  });

  it('权重差异：depends_on(1.0) 扩散比 co_occur(0.4) 更强', () => {
    const db = freshDb();
    for (const id of ['f_s', 'f_dep', 'f_co']) addFact(db, id);
    addEdge(db, 'f_s', 'f_dep', 'depends_on');
    addEdge(db, 'f_s', 'f_co', 'co_occur', 0.4);

    const res = recallPpr(db, ['f_s']);
    const dep = res.scores[res.ids.indexOf('f_dep')] ?? 0;
    const co = res.scores[res.ids.indexOf('f_co')] ?? 0;
    expect(dep).toBeGreaterThan(co);
  });

  it('无邻居：只返回空结果（nodes == seeds 数）', () => {
    const db = freshDb();
    addFact(db, 'f_alone');
    const res = recallPpr(db, ['f_alone']);
    expect(res.ids).toEqual([]);
    expect(res.timedOut).toBe(false);
  });

  it('超时返回当前结果 + timedOut=true（上层标 no_ppr）', () => {
    const db = freshDb();
    for (const id of ['f_a', 'f_b', 'f_c']) addFact(db, id);
    addEdge(db, 'f_a', 'f_b', 'depends_on');
    addEdge(db, 'f_b', 'f_c', 'depends_on');

    // 注入 now：每次调用推进 100ms，首次超时检查即超预算
    let t = 0;
    const fakeNow = () => (t += 100);
    const res = recallPpr(db, ['f_a'], { timeoutMs: 5, now: fakeNow });
    expect(res.timedOut).toBe(true);
  });
});
