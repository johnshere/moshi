/**
 * 淘汰候选（prune）队列与批量剪枝测试（P2-13，详设 §8.3.4 / §10.6）。
 *
 * 覆盖四层：
 * 1. `listPruneQueue` 的 60 天未访问口径（含 last_access_at IS NULL、边界当日排除）；
 * 2. `previewPrune` 的影响面：只数可剪枝的活跃行；剪枝不连锁（cascade 恒 0）；
 * 3. `pruneMany` 是软删：只改 epistemic_status / updated_at，valid_to 与 strength 原样保留；
 * 4. `restorePruned` 用 CAS 还原原状态，二次撤销不生效。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nowIso } from '../../src/domain/time.js';
import { auditByRow } from '../../src/infra/sqlite/auditRepo.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as inboxRepo from '../../src/infra/sqlite/inboxRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

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
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-prune-'));
  dirs.push(d);
  const { db } = openDb({ file: path.join(d, 'moshi.db') });
  migrate(db, { backupsDir: path.join(d, 'backups') });
  opened.push(db);
  return db;
}

/** 与仓储 SQL 同源的「N 天前」日期串（UTC，YYYY-MM-DD） */
function sqlDate(db: Db, modifier: string): string {
  return (db.prepare(`SELECT date('now', ?) AS d`).get(modifier) as { d: string }).d;
}

function setLastAccess(db: Db, id: string, at: string | null): void {
  db.prepare('UPDATE fact SET last_access_at = ? WHERE id = ?').run(at, id);
}

function setCommunity(db: Db, id: string, communityId: number | null): void {
  db.prepare('UPDATE fact SET community_id = ? WHERE id = ?').run(communityId, id);
}

interface FactState {
  valid_to: string | null;
  epistemic_status: string;
  strength: number;
  last_access_at: string | null;
}

function factRow(db: Db, id: string): FactState {
  return db
    .prepare('SELECT valid_to, epistemic_status, strength, last_access_at FROM fact WHERE id = ?')
    .get(id) as FactState;
}

function edgeActive(db: Db, id: string): boolean {
  const row = db.prepare('SELECT valid_to FROM edge WHERE id = ?').get(id) as {
    valid_to: string | null;
  };
  return row.valid_to === null;
}

/** 未来时刻：作 valid_to 用，避开 CHECK(valid_to > valid_at) */
const laterIso = (): string => new Date(Date.now() + 1000).toISOString();

// ── 1. 队列口径：strength + 60 天未访问 ──

describe('listPruneQueue（淘汰候选，60 天口径）', () => {
  it('strength < 0.15 且 60 天未访问（含从未访问），按 strength 升序', () => {
    const db = freshDb();
    const old = insertFact(db, { content: 'old', strength: 0.05 });
    setLastAccess(db, old, sqlDate(db, '-90 day'));
    const never = insertFact(db, { content: 'never', strength: 0.12 }); // last_access_at = NULL
    const recent = insertFact(db, { content: 'recent', strength: 0.01 });
    setLastAccess(db, recent, nowIso());
    const boundary = insertFact(db, { content: 'boundary', strength: 0.02 });
    setLastAccess(db, boundary, sqlDate(db, '-60 day')); // 正好 60 天：不早于阈值 → 不收

    const rows = inboxRepo.listPruneQueue(db, { limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([old, never]); // 0.05 < 0.12
    expect(rows[0]?.strength).toBe(0.05);
    expect(rows[1]?.lastAccessAt).toBeNull();
  });

  it('61 天前访问的边界另一侧会入队', () => {
    const db = freshDb();
    const at61 = insertFact(db, { content: 'at61', strength: 0.1 });
    setLastAccess(db, at61, sqlDate(db, '-61 day'));
    expect(inboxRepo.listPruneQueue(db, { limit: 50 }).map((r) => r.id)).toEqual([at61]);
  });

  it('strength 边界 0.15 与 archived/invalidated/已失效行都不收', () => {
    const db = freshDb();
    const ok = insertFact(db, { content: 'ok', strength: 0.15 });
    const archived = insertFact(db, { content: 'arch', strength: 0.01, epistemicStatus: 'archived' });
    const invalidated = insertFact(db, {
      content: 'inv',
      strength: 0.01,
      epistemicStatus: 'invalidated',
    });
    const closed = insertFact(db, { content: 'closed', strength: 0.01, validTo: laterIso() });
    expect([ok, archived, invalidated, closed]).toHaveLength(4);
    expect(inboxRepo.listPruneQueue(db, { limit: 50 })).toEqual([]);
  });

  it('limit 生效', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) insertFact(db, { content: `p${i}`, strength: 0.01 * (i + 1) });
    expect(inboxRepo.listPruneQueue(db, { limit: 2 })).toHaveLength(2);
  });
});

// ── 2. 影响面预览 ──

describe('previewPrune（剪枝影响面）', () => {
  it('facts/edges/topics 只数可剪枝的活跃行；cascade 恒 0（剪枝不连锁）', () => {
    const db = freshDb();
    const f1 = insertFact(db, { content: 'f1', importance: 0.9 });
    const f2 = insertFact(db, { content: 'f2', importance: 0.5 });
    const f3 = insertFact(db, { content: 'f3' });
    const f4 = insertFact(db, { content: 'f4' });
    setCommunity(db, f1, 7);
    setCommunity(db, f2, 7);
    setCommunity(db, f3, 9);

    const e1 = insertEdge(db, f1, f3); // 任一端在选中集 → 计（与 invalidate 同口径）
    const e2 = insertEdge(db, f2, f1); // 同上
    insertEdge(db, f4, f1); // dst ∈ 选中集 → 也计
    insertEdge(db, f1, f3, 'depends_on', laterIso()); // 已失效边不数

    const preview = inboxRepo.previewPrune(db, [f1, f2]);
    expect(preview.facts).toBe(2);
    expect(preview.edges).toBe(3);
    expect(preview.topics).toBe(1); // f1/f2 同属 community 7
    expect(preview.invalidatedByCascade).toBe(0);
    expect(preview.previewSample.map((s) => s.id)).toEqual([f1, f2]);
    expect(edgeActive(db, e1)).toBe(true);
    expect(edgeActive(db, e2)).toBe(true);
  });

  it('已失效/非活跃行不计入 facts，也不贡献边与主题', () => {
    const db = freshDb();
    const active = insertFact(db, { content: 'a' });
    const closed = insertFact(db, { content: 'b', validTo: laterIso() });
    const archived = insertFact(db, { content: 'c', epistemicStatus: 'archived' });
    setCommunity(db, closed, 3);
    const preview = inboxRepo.previewPrune(db, [active, closed, archived]);
    expect(preview.facts).toBe(1);
    expect(preview.topics).toBe(0);
    expect(preview.previewSample.map((s) => s.id)).toEqual([active]);
  });

  it('preview_sample 最多 5 条且按 importance 降序', () => {
    const db = freshDb();
    const ids = Array.from({ length: 8 }, (_, i) =>
      insertFact(db, { content: `s${i}`, importance: i / 10 }),
    );
    const preview = inboxRepo.previewPrune(db, ids);
    expect(preview.previewSample).toHaveLength(5);
    expect(preview.previewSample.map((s) => s.id)).toEqual([...ids].reverse().slice(0, 5));
  });

  it('空 ids / 超 200 直接拒（E_INPUT）', () => {
    const db = freshDb();
    expect(() => inboxRepo.previewPrune(db, [])).toThrowError(/ids 不能为空/);
    const tooMany = Array.from({ length: inboxRepo.MAX_BATCH_IDS + 1 }, (_, i) => `f_${i}`);
    expect(() => inboxRepo.previewPrune(db, tooMany)).toThrowError(/最多 200 条/);
  });
});

// ── 3. 批量剪枝（软删） ──

describe('pruneMany（批量剪枝 = 软删）', () => {
  it('只改 epistemic_status / updated_at：valid_to 仍为 NULL、strength 不动、行保留', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a', strength: 0.07 });
    const b = insertFact(db, { content: 'b', strength: 0.09, epistemicStatus: 'disputed' });
    const before = factRow(db, a);

    const snaps = inboxRepo.pruneMany(db, [a, b], { opId: 'b_prune' });
    expect(snaps).toHaveLength(2);
    for (const id of [a, b]) {
      const row = factRow(db, id);
      expect(row.epistemic_status).toBe('pruned');
      expect(row.valid_to).toBeNull(); // 软删：不写有效区间，语义不变
      expect(db.prepare('SELECT COUNT(*) AS n FROM fact WHERE id = ?').get(id)).toEqual({ n: 1 });
    }
    expect(factRow(db, a).strength).toBe(before.strength);
    // 快照记原状态与本次写入的 updated_at（撤销 CAS 的钥匙）
    expect(snaps.map((s) => s.epistemicStatus)).toEqual(['active', 'disputed']);
    expect(snaps.every((s) => typeof s.prunedAt === 'string' && s.prunedAt.length > 0)).toBe(true);
  });

  it('逐条 audit（source=ui_batch_prune, reason=op_id, before=原状态）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    inboxRepo.pruneMany(db, [a], { opId: 'b_prune' });
    const mine = auditByRow(db, 'fact', a).filter((x) => x.source === 'ui_batch_prune');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.reason).toBe('b_prune');
    expect(mine[0]?.field).toBe('epistemic_status');
    expect(JSON.parse(mine[0]?.afterJson ?? '{}')).toMatchObject({ epistemic_status: 'pruned' });
  });

  it('跳过非活跃 / 已失效 / 已 pruned 的行，不抛 E_IMMUTABLE', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const closed = insertFact(db, { content: 'closed', validTo: laterIso() });
    const archived = insertFact(db, { content: 'archived', epistemicStatus: 'archived' });
    const snaps = inboxRepo.pruneMany(db, [a, closed, archived], { opId: 'b1' });
    expect(snaps.map((s) => s.id)).toEqual([a]);
    expect(factRow(db, closed).epistemic_status).toBe('active');
    expect(factRow(db, archived).epistemic_status).toBe('archived');
  });

  it('不碰任何 edge（撤销窗口内边必须原样留着）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const e1 = insertEdge(db, a, b);
    const e2 = insertEdge(db, b, a);
    inboxRepo.pruneMany(db, [a], { opId: 'b1' });
    expect(edgeActive(db, e1)).toBe(true);
    expect(edgeActive(db, e2)).toBe(true);
  });

  it('剪枝后从淘汰候选与低置信队列消失（读侧按 active/disputed 收口）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a', strength: 0.05, confidence: 0.2, importance: 0.9 });
    const b = insertFact(db, { content: 'b', strength: 0.06 });
    expect(inboxRepo.listPruneQueue(db, { limit: 50 })).toHaveLength(2);
    inboxRepo.pruneMany(db, [a], { opId: 'b1' });
    expect(inboxRepo.listPruneQueue(db, { limit: 50 }).map((r) => r.id)).toEqual([b]);
    expect(inboxRepo.listLowConfQueue(db, { limit: 50 })).toEqual([]);
  });
});

// ── 4. 撤销剪枝 ──

describe('restorePruned（撤销剪枝）', () => {
  it('还原原 epistemic_status（含 disputed），并留一条 undo 审计', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b', epistemicStatus: 'disputed' });
    const snaps = inboxRepo.pruneMany(db, [a, b], { opId: 'b1' });

    expect(inboxRepo.restorePruned(db, snaps, { opId: 'b1' })).toBe(2);
    expect(factRow(db, a)).toMatchObject({ epistemic_status: 'active', valid_to: null });
    expect(factRow(db, b)).toMatchObject({ epistemic_status: 'disputed', valid_to: null });
    const undo = auditByRow(db, 'fact', a).filter((x) => x.source === 'ui_batch_undo');
    expect(undo).toHaveLength(1);
    expect(undo[0]?.reason).toBe('b1');
  });

  it('二次撤销不生效（CAS：updated_at 已不是本批写进去的值）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const snaps = inboxRepo.pruneMany(db, [a], { opId: 'b1' });
    expect(inboxRepo.restorePruned(db, snaps, { opId: 'b1' })).toBe(1);
    expect(inboxRepo.restorePruned(db, snaps, { opId: 'b1' })).toBe(0);
  });

  it('撤销后重新出现在淘汰候选队列', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a', strength: 0.02 });
    const snaps = inboxRepo.pruneMany(db, [a], { opId: 'b1' });
    expect(inboxRepo.listPruneQueue(db, { limit: 50 })).toEqual([]);
    inboxRepo.restorePruned(db, snaps, { opId: 'b1' });
    expect(inboxRepo.listPruneQueue(db, { limit: 50 }).map((r) => r.id)).toEqual([a]);
  });

  it('空快照返回 0（不写审计、不开事务）', () => {
    const db = freshDb();
    expect(inboxRepo.restorePruned(db, [], { opId: 'b1' })).toBe(0);
  });
});
