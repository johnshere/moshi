/**
 * 待办队列 + 批量失效仓储测试（P2-07）。
 *
 * 覆盖三层：
 * 1. 三个队列的筛选口径与排序（详设 §10.6 的 SQL 是逐字抄的，这里断言"哪些行该进队列"）；
 * 2. 影响面预览的四个数字（facts / edges / topics / invalidated_by_cascade）；
 * 3. 批量失效 ↔ 撤销的写入语义：单事务、逐条 audit、不碰 edge、CAS 防二次还原。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nowIso } from '../../src/domain/time.js';
import { appendAudit, auditByRow } from '../../src/infra/sqlite/auditRepo.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as inboxRepo from '../../src/infra/sqlite/inboxRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEdge, insertFact, makeEntity } from '../fixtures/factories.js';

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
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-inbox-'));
  dirs.push(d);
  const { db } = openDb({ file: path.join(d, 'moshi.db') });
  migrate(db, { backupsDir: path.join(d, 'backups') });
  opened.push(db);
  return db;
}

function insertAlias(db: Db, alias: string, entityId: string, confidence: number, source = 'vector'): void {
  db.prepare(
    `INSERT INTO alias (alias, entity_id, source, confidence, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(alias, entityId, source, confidence, nowIso());
}

function setCommunity(db: Db, factId: string, communityId: number | null): void {
  db.prepare('UPDATE fact SET community_id = ? WHERE id = ?').run(communityId, factId);
}

function factRow(db: Db, id: string): { valid_to: string | null; epistemic_status: string; superseded_by: string | null } {
  return db
    .prepare('SELECT valid_to, epistemic_status, superseded_by FROM fact WHERE id = ?')
    .get(id) as { valid_to: string | null; epistemic_status: string; superseded_by: string | null };
}

function edgeActive(db: Db, id: string): boolean {
  const row = db.prepare('SELECT valid_to FROM edge WHERE id = ?').get(id) as { valid_to: string | null };
  return row.valid_to === null;
}

const laterIso = (): string => new Date(Date.now() + 1000).toISOString();

// ── 1. 三队列 ──

describe('listResolveQueue（消解确认）', () => {
  it('只收 vector 来源且置信度落在 [0.60, 0.92] 的 alias，按置信度降序', () => {
    const db = freshDb();
    const e = makeEntity(db, 'pkg-a');
    insertAlias(db, 'pkg-a', e, 0.59); // 太低，不进
    insertAlias(db, 'pkg-a@22', e, 0.6); // 边界，闭区间要进
    insertAlias(db, 'pkg-a@23', e, 0.75);
    insertAlias(db, 'pkg-a@24', e, 0.92); // 边界，闭区间要进
    insertAlias(db, 'pkg-a@25', e, 0.93); // 太高，不进
    insertAlias(db, 'pkg-a@26', e, 0.7, 'human'); // 非 vector，不进

    const rows = inboxRepo.listResolveQueue(db, { limit: 50 });
    expect(rows.map((r) => r.alias)).toEqual(['pkg-a@24', 'pkg-a@23', 'pkg-a@22']);
    // P2-19-A：行 id 是 alias+entity 的不透明编码，供 decide 回传
    expect(typeof rows[0]?.id).toBe('string');
    expect(rows[0]).toMatchObject({
      alias: 'pkg-a@24',
      entityId: e,
      canonicalName: 'pkg-a',
      confidence: 0.92,
    });
  });

  it('min_sim / max_sim 可收紧区间', () => {
    const db = freshDb();
    const e = makeEntity(db, 'pkg-b');
    insertAlias(db, 'b1', e, 0.7);
    insertAlias(db, 'b2', e, 0.8);
    insertAlias(db, 'b3', e, 0.9);
    const rows = inboxRepo.listResolveQueue(db, { limit: 50, minSim: 0.75, maxSim: 0.85 });
    expect(rows.map((r) => r.alias)).toEqual(['b2']);
  });

  it('limit 生效', () => {
    const db = freshDb();
    const e = makeEntity(db, 'pkg-c');
    for (let i = 0; i < 5; i++) insertAlias(db, `c${i}`, e, 0.6 + i * 0.01);
    expect(inboxRepo.listResolveQueue(db, { limit: 2 })).toHaveLength(2);
  });
});

describe('listLowConfQueue（低置信裁决）', () => {
  it('只收 active/disputed 且 confidence < 0.45，按 importance 降序', () => {
    const db = freshDb();
    const low = insertFact(db, { content: 'low', confidence: 0.3, importance: 0.9 });
    const lower = insertFact(db, { content: 'lower', confidence: 0.44, importance: 0.1 });
    insertFact(db, { content: 'ok', confidence: 0.5, importance: 0.99 }); // 不够低
    insertFact(db, { content: 'archived', confidence: 0.1, epistemicStatus: 'archived' });
    insertFact(db, { content: 'invalidated', confidence: 0.1, epistemicStatus: 'invalidated' });
    const disputed = insertFact(db, {
      content: 'disputed',
      confidence: 0.2,
      importance: 0.5,
      epistemicStatus: 'disputed',
    });

    const rows = inboxRepo.listLowConfQueue(db, { limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([low, disputed, lower]);
    expect(rows[0]).toEqual({ id: low, content: 'low', confidence: 0.3, importance: 0.9 });
  });
});

describe('listPruneQueue（淘汰候选）', () => {
  it('只收 active/disputed 且 strength < 0.15，按 strength 升序', () => {
    const db = freshDb();
    const weakest = insertFact(db, { content: 'w', strength: 0.05 });
    const weak = insertFact(db, { content: 'v', strength: 0.14 });
    insertFact(db, { content: 'ok', strength: 0.15 }); // 边界不含
    insertFact(db, { content: 'archived', strength: 0.01, epistemicStatus: 'archived' });

    const rows = inboxRepo.listPruneQueue(db, { limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([weakest, weak]);
    expect(rows[0]?.strength).toBe(0.05);
    expect(rows[0]?.lastAccessAt).toBeNull();
  });

  it('P2-13：60 天未访问口径——最近访问过的不进，61 天前/从未访问的进', () => {
    const db = freshDb();
    const sqlDate = (modifier: string): string =>
      (db.prepare(`SELECT date('now', ?) AS d`).get(modifier) as { d: string }).d;

    const recent = insertFact(db, { content: 'recent', strength: 0.01 });
    db.prepare('UPDATE fact SET last_access_at = ? WHERE id = ?').run(nowIso(), recent);
    const boundary = insertFact(db, { content: 'boundary', strength: 0.02 });
    db.prepare('UPDATE fact SET last_access_at = ? WHERE id = ?').run(sqlDate('-60 day'), boundary);
    const old = insertFact(db, { content: 'old', strength: 0.03 });
    db.prepare('UPDATE fact SET last_access_at = ? WHERE id = ?').run(sqlDate('-61 day'), old);
    const never = insertFact(db, { content: 'never', strength: 0.04 });

    const rows = inboxRepo.listPruneQueue(db, { limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([old, never]); // strength 升序
  });
});

// ── 2. 影响面预览 ──

describe('previewInvalidate（影响面）', () => {
  it('四个数字各自独立计算：facts / edges / topics / invalidated_by_cascade', () => {
    const db = freshDb();
    const f1 = insertFact(db, { content: 'f1', importance: 0.9 });
    const f2 = insertFact(db, { content: 'f2', importance: 0.5 });
    const f3 = insertFact(db, { content: 'f3' });
    const f4 = insertFact(db, { content: 'f4' });
    setCommunity(db, f1, 7);
    setCommunity(db, f2, 7);
    setCommunity(db, f3, 9);

    insertEdge(db, f1, f3); // src ∈ ids → 计边；src ∈ ids → 不算连带
    insertEdge(db, f4, f1); // dst ∈ ids → 计边；src ∉ ids → 连带 1 条
    insertEdge(db, f3, f4); // 两端都不在 ids → 不计
    insertEdge(db, f4, f2, 'depends_on', laterIso()); // 已失效的边不参与任何计数

    const preview = inboxRepo.previewInvalidate(db, [f1, f2]);
    expect(preview.facts).toBe(2);
    expect(preview.edges).toBe(2);
    expect(preview.topics).toBe(1); // f1/f2 同属 community 7
    expect(preview.invalidatedByCascade).toBe(1); // 仅 f4 依赖 f1
    expect(preview.previewSample.map((s) => s.id).sort()).toEqual([f1, f2].sort());
  });

  it('preview_sample 最多 5 条且按 importance 降序', () => {
    const db = freshDb();
    const ids = Array.from({ length: 8 }, (_, i) =>
      insertFact(db, { content: `s${i}`, importance: i / 10 }),
    );
    const preview = inboxRepo.previewInvalidate(db, ids);
    expect(preview.facts).toBe(8);
    expect(preview.previewSample).toHaveLength(5);
    expect(preview.previewSample.map((s) => s.id)).toEqual([...ids].reverse().slice(0, 5));
  });

  it('已失效的 id 只计入总行数之外——facts 只数活跃行', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    db.prepare('UPDATE fact SET valid_to = ? WHERE id = ?').run(laterIso(), b);
    expect(inboxRepo.previewInvalidate(db, [a, b]).facts).toBe(1);
  });
});

// ── 3. 批量失效 / 撤销 ──

describe('invalidateMany / restoreMany（批量失效与撤销）', () => {
  it('失效写 valid_to + invalidated，逐条 audit（source=ui_batch_invalidate, reason=op_id）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const before = factRow(db, a);

    const snaps = inboxRepo.invalidateMany(db, [a, b], { opId: 'b_test_op' });
    expect(snaps).toHaveLength(2);
    for (const id of [a, b]) {
      const row = factRow(db, id);
      expect(row.epistemic_status).toBe('invalidated');
      expect(row.valid_to).not.toBeNull();
      const audits = auditByRow(db, 'fact', id);
      const mine = audits.filter((x) => x.source === 'ui_batch_invalidate');
      expect(mine).toHaveLength(1);
      expect(mine[0]?.reason).toBe('b_test_op');
      expect(mine[0]?.field).toBe('epistemic_status');
      expect(JSON.parse(mine[0]?.beforeJson ?? '{}')).toMatchObject({
        valid_to: before.valid_to,
        epistemic_status: 'active',
      });
    }
  });

  it('已失效的行跳过（不抛 E_IMMUTABLE），快照只含本次收口的行', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    inboxRepo.invalidateMany(db, [a], { opId: 'b1' });
    const snaps = inboxRepo.invalidateMany(db, [a, b], { opId: 'b2' });
    expect(snaps.map((s) => s.id)).toEqual([b]);
  });

  it('不碰任何 edge（撤销窗口内边必须原样留着）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const e1 = insertEdge(db, a, b);
    const e2 = insertEdge(db, b, a);
    inboxRepo.invalidateMany(db, [a], { opId: 'b1' });
    expect(edgeActive(db, e1)).toBe(true);
    expect(edgeActive(db, e2)).toBe(true);
  });

  it('插入后立刻失效不会撞 valid_to > valid_at（同毫秒顺延 1ms）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a', validAt: nowIso() });
    const snaps = inboxRepo.invalidateMany(db, [a], { opId: 'b1' });
    expect(snaps).toHaveLength(1);
    const row = db.prepare('SELECT valid_at, valid_to FROM fact WHERE id = ?').get(a) as {
      valid_at: string;
      valid_to: string;
    };
    expect(row.valid_to > row.valid_at).toBe(true);
  });

  it('撤销清回 valid_to 并还原 epistemic_status，逐条 audit（source=ui_batch_undo）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b', epistemicStatus: 'disputed' });
    const snaps = inboxRepo.invalidateMany(db, [a, b], { opId: 'b1' });

    const restored = inboxRepo.restoreMany(db, snaps, { opId: 'b1' });
    expect(restored).toBe(2);
    expect(factRow(db, a)).toEqual({
      valid_to: null,
      epistemic_status: 'active',
      superseded_by: null,
    });
    expect(factRow(db, b).epistemic_status).toBe('disputed');
    const undoAudits = auditByRow(db, 'fact', a).filter((x) => x.source === 'ui_batch_undo');
    expect(undoAudits).toHaveLength(1);
    expect(undoAudits[0]?.reason).toBe('b1');
  });

  it('二次撤销不生效（CAS：valid_to 已不是本批写进去的值）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const snaps = inboxRepo.invalidateMany(db, [a], { opId: 'b1' });
    expect(inboxRepo.restoreMany(db, snaps, { opId: 'b1' })).toBe(1);
    expect(inboxRepo.restoreMany(db, snaps, { opId: 'b1' })).toBe(0);
  });

  it('撤销不动被别的路径重新收口的行（CAS 跳过并计数）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const snaps = inboxRepo.invalidateMany(db, [a, b], { opId: 'b1' });
    // 模拟别的路径（例如另一次 batch）把 b 重新收口成另一个时刻
    db.prepare('UPDATE fact SET valid_to = ? WHERE id = ?').run(laterIso(), b);
    expect(inboxRepo.restoreMany(db, snaps, { opId: 'b1' })).toBe(1);
    expect(factRow(db, a).valid_to).toBeNull();
    expect(factRow(db, b).valid_to).not.toBeNull();
  });

  it('missingIds 返回库里不存在的 id（整批拒绝的判据）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    expect(inboxRepo.missingIds(db, [a, 'f_does_not_exist'])).toEqual(['f_does_not_exist']);
    expect(inboxRepo.missingIds(db, [a])).toEqual([]);
  });

  it('ids 超过 200 / 为空直接拒（E_INPUT）', () => {
    const db = freshDb();
    expect(() => inboxRepo.previewInvalidate(db, [])).toThrowError(/ids 不能为空/);
    const tooMany = Array.from({ length: inboxRepo.MAX_BATCH_IDS + 1 }, (_, i) => `f_${i}`);
    expect(() => inboxRepo.previewInvalidate(db, tooMany)).toThrowError(/最多 200 条/);
  });
});

describe('审计可追溯性（I10）', () => {
  it('失效 + 撤销各留一条审计，且时间有序', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    appendAudit(db, { tbl: 'fact', rowId: a, field: 'epistemic_status', source: 'seed' });
    const snaps = inboxRepo.invalidateMany(db, [a], { opId: 'b1' });
    inboxRepo.restoreMany(db, snaps, { opId: 'b1' });
    const sources = auditByRow(db, 'fact', a).map((x) => x.source);
    expect(sources).toEqual(['seed', 'ui_batch_invalidate', 'ui_batch_undo']);
  });
});
