import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import {
  activeFactCount,
  degreeMismatches,
  orphanRatio,
  rebuildDegree,
} from '../../src/infra/sqlite/views.js';
import { addDays } from '../../src/domain/time.js';
import { nowIso } from '../../src/domain/time.js';
import { degreeOf, insertEdge, insertFact, schemaRev } from '../fixtures/factories.js';

const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-trg-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

describe('I1：content 不可变（详设 §2.5）', () => {
  it('改 content 直接 ABORT，错误码是 E_IMMUTABLE', () => {
    const db = freshDb();
    const id = insertFact(db, { content: '8080 被 nginx 占用' });
    expect(() => db.prepare('UPDATE fact SET content = ? WHERE id = ?').run('改了', id)).toThrow(
      /E_IMMUTABLE/,
    );
  });

  it('写相同值不算变更（幂等更新不误报）', () => {
    const db = freshDb();
    const id = insertFact(db, { content: '8080 被 nginx 占用' });
    expect(() =>
      db.prepare('UPDATE fact SET content = content WHERE id = ?').run(id),
    ).not.toThrow();
  });
});

describe('I2：attrs.frozen 不可变（D3）', () => {
  it('改 frozen 抛错', () => {
    const db = freshDb();
    const id = insertFact(db, { value: '22.0.0' });
    const attrs = JSON.stringify({
      frozen: { subject: { entity_id: 'en_x', name: 'node' }, predicate: 'version', value: '23.0.0' },
      ext: {},
    });
    expect(() => db.prepare('UPDATE fact SET attrs = ? WHERE id = ?').run(attrs, id)).toThrow(
      /E_IMMUTABLE/,
    );
  });

  it('只改 ext 不抛（这是 attrs 两区的意义）', () => {
    const db = freshDb();
    const id = insertFact(db, { value: '22.0.0' });
    const before = JSON.parse(
      (db.prepare('SELECT attrs FROM fact WHERE id = ?').get(id) as { attrs: string }).attrs,
    ) as { frozen: unknown; ext: Record<string, unknown> };
    const after = JSON.stringify({ frozen: before.frozen, ext: { note: '人工补充' } });
    expect(() => db.prepare('UPDATE fact SET attrs = ? WHERE id = ?').run(after, id)).not.toThrow();
  });

  it('ext 内容换序不误判（依赖 canonicalJson 的稳定序列化）', () => {
    const db = freshDb();
    const id = insertFact(db, { ext: { a: 1, b: 2 } });
    const attrs = JSON.parse(
      (db.prepare('SELECT attrs FROM fact WHERE id = ?').get(id) as { attrs: string }).attrs,
    ) as { frozen: unknown; ext: unknown };
    const reordered = JSON.stringify({ frozen: attrs.frozen, ext: { b: 2, a: 1 } });
    expect(() => db.prepare('UPDATE fact SET attrs = ? WHERE id = ?').run(reordered, id)).not.toThrow();
  });
});

describe('degree 维护（D4）', () => {
  it('插边两端 +1，关边两端 -1', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    expect(degreeOf(db, a)).toBe(0);

    const edgeId = insertEdge(db, a, b);
    expect(degreeOf(db, a)).toBe(1);
    expect(degreeOf(db, b)).toBe(1);

    db.prepare('UPDATE edge SET valid_to = ? WHERE id = ?').run(addDays(nowIso(), 1), edgeId);
    expect(degreeOf(db, a)).toBe(0);
    expect(degreeOf(db, b)).toBe(0);
  });

  it('删活跃边会减；删已关闭的边不会再减', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const e1 = insertEdge(db, a, b);
    db.prepare('DELETE FROM edge WHERE id = ?').run(e1);
    expect(degreeOf(db, a)).toBe(0);

    const e2 = insertEdge(db, a, b);
    db.prepare('UPDATE edge SET valid_to = ? WHERE id = ?').run(addDays(nowIso(), 1), e2);
    db.prepare('DELETE FROM edge WHERE id = ?').run(e2);
    expect(degreeOf(db, a)).toBe(0);
  });

  it('补历史边（valid_to 非空插入）不计入当前度数——故意的', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    insertEdge(db, a, b, 'depends_on', addDays(nowIso(), -1));
    expect(degreeOf(db, a)).toBe(0);
  });

  it('I7：存储列与 v_fact_degree 对账一致', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const c = insertFact(db, { content: 'c' });
    insertEdge(db, a, b);
    insertEdge(db, b, c);
    insertEdge(db, a, c, 'co_occur');
    expect(degreeMismatches(db)).toEqual([]);
    expect(degreeOf(db, b)).toBe(2);
  });

  it('rebuildDegree 能修掉被手改坏的 degree', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    insertEdge(db, a, b);
    db.prepare('UPDATE fact SET degree = 99 WHERE id = ?').run(a);
    expect(degreeMismatches(db)).toHaveLength(1);
    expect(rebuildDegree(db)).toBe(1);
    expect(degreeMismatches(db)).toEqual([]);
  });
});

describe('边的唯一性与不复活（I4）', () => {
  it('同一 (src,dst,etype) 只能有一条活跃边', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    insertEdge(db, a, b);
    expect(() => insertEdge(db, a, b)).toThrow(/UNIQUE/);
  });

  it('关闭后的边不能复活（要复活只能新建行）', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const id = insertEdge(db, a, b);
    db.prepare('UPDATE edge SET valid_to = ? WHERE id = ?').run(addDays(nowIso(), 1), id);
    expect(() => db.prepare('UPDATE edge SET valid_to = NULL WHERE id = ?').run(id)).toThrow(
      /E_IMMUTABLE/,
    );
  });

  it('自环边被 CHECK 拒绝', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    expect(() => insertEdge(db, a, a)).toThrow(/CHECK/);
  });
});

describe('视图（详设 §2.6）', () => {
  it('v_active_fact 只含 active/disputed 且未过期', () => {
    const db = freshDb();
    insertFact(db, { content: 'active', epistemicStatus: 'active' });
    insertFact(db, { content: 'disputed', epistemicStatus: 'disputed' });
    insertFact(db, {
      content: 'invalidated',
      epistemicStatus: 'invalidated',
      validAt: addDays(nowIso(), -2),
      validTo: addDays(nowIso(), -1),
    });
    insertFact(db, { content: 'archived', epistemicStatus: 'archived' });
    expect(activeFactCount(db)).toBe(2);
  });

  it('v_orphan_ratio 统计孤立节点', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    insertFact(db, { content: 'c' });
    insertEdge(db, a, b);
    const { ratio, total } = orphanRatio(db);
    expect(total).toBe(3);
    expect(ratio).toBeCloseTo(1 / 3, 5);
  });
});

describe('schema_rev（派生投影新鲜度）', () => {
  it('每次插入 fact 都 +1', () => {
    const db = freshDb();
    expect(schemaRev(db)).toBe(0);
    insertFact(db, { content: 'a' });
    insertFact(db, { content: 'b' });
    expect(schemaRev(db)).toBe(2);
  });
});
