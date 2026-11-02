/**
 * 检查器溯源档数据查询单测（P2-06，详设 §10.5）。
 *
 * 依赖链 / 冲突对 / 反向 supersedes 链是检查器溯源档的数据来源，SQL 直接在此验证
 * （用 fixtures 直写库，绕过仓储层——仓库层函数正是被测对象）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-inspector-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

describe('traceDepends（依赖链上下游各 3 跳）', () => {
  it('src → dst = src 依赖 dst：上游是被依赖方', () => {
    const db = freshDb();
    const upId = insertFact(db, { content: '前提' });
    const fid = insertFact(db, { content: '主体' });
    insertEdge(db, fid, upId, 'depends_on'); // self 依赖 up
    const { upstream, downstream } = factRepo.traceDepends(db, fid);
    expect(upstream.map((d) => d.id)).toEqual([upId]);
    expect(downstream).toEqual([]);
  });

  it('下游 = 依赖我的（dst = 我）', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: '主体' });
    const downId = insertFact(db, { content: '依赖者' });
    insertEdge(db, downId, fid, 'depends_on'); // down 依赖 self
    const { upstream, downstream } = factRepo.traceDepends(db, fid);
    expect(upstream).toEqual([]);
    expect(downstream.map((d) => d.id)).toEqual([downId]);
  });

  it('多跳展开且去重、不含自己', () => {
    const db = freshDb();
    const root = insertFact(db, { content: '根' });
    const a = insertFact(db, { content: 'A' });
    const b = insertFact(db, { content: 'B' });
    const c = insertFact(db, { content: 'C' });
    // 链：root → a → b（b 依赖 a，a 依赖 root）；root 依赖 c（同层）
    insertEdge(db, a, root, 'depends_on');
    insertEdge(db, b, a, 'depends_on');
    insertEdge(db, root, c, 'depends_on');
    const { upstream } = factRepo.traceDepends(db, b);
    // b 的上游：a（1 跳）、root（2 跳）、c（root 的上游，3 跳）
    expect(new Set(upstream.map((d) => d.id))).toEqual(new Set([a, root, c]));
    expect(upstream.some((d) => d.id === b)).toBe(false);
  });

  it('hops 限制跳数（默认 3，可指定更小）', () => {
    const db = freshDb();
    const root = insertFact(db, { content: '根' });
    const a = insertFact(db, { content: 'A' });
    const b = insertFact(db, { content: 'B' });
    insertEdge(db, a, root, 'depends_on');
    insertEdge(db, b, a, 'depends_on');
    const hops1 = factRepo.traceDepends(db, b, { hops: 1 });
    expect(hops1.upstream.map((d) => d.id)).toEqual([a]);
  });

  it('只统计活跃边（valid_to 非空的不算）', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: '主体' });
    const closed = insertFact(db, { content: '已收口的前提' });
    const active = insertFact(db, { content: '活跃前提' });
    insertEdge(db, fid, closed, 'depends_on', '2026-01-01T00:00:00Z');
    insertEdge(db, fid, active, 'depends_on');
    const { upstream } = factRepo.traceDepends(db, fid);
    expect(upstream.map((d) => d.id)).toEqual([active]);
  });
});

describe('listConflicts（冲突对，互斥活跃边）', () => {
  it('返回与我有活跃 mutually_exclusive 边的事实', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: '主体' });
    const clash = insertFact(db, { content: '冲突' });
    const other = insertFact(db, { content: '无关' });
    insertEdge(db, fid, clash, 'mutually_exclusive');
    insertEdge(db, fid, other, 'co_occur'); // 非互斥边不算冲突
    const conflicts = factRepo.listConflicts(db, fid);
    expect(conflicts.map((d) => d.id)).toEqual([clash]);
  });

  it('src/dst 谁是 id 都能找到（CASE 归一）', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: '主体' });
    const clash = insertFact(db, { content: '冲突' });
    insertEdge(db, clash, fid, 'mutually_exclusive'); // id 在 dst 侧
    const conflicts = factRepo.listConflicts(db, fid);
    expect(conflicts.map((d) => d.id)).toEqual([clash]);
  });
});

describe('listSuperseding（反向 supersedes 链：我取代了谁）', () => {
  it('返回 superseded_by = id 的事实', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: '新' });
    const old1 = insertFact(db, { content: '旧1', supersededBy: fid });
    const old2 = insertFact(db, { content: '旧2', supersededBy: fid });
    const unrelated = insertFact(db, { content: '无关' });
    const superseding = factRepo.listSuperseding(db, fid);
    expect(new Set(superseding.map((d) => d.id))).toEqual(new Set([old1, old2]));
    expect(superseding.some((d) => d.id === unrelated)).toBe(false);
  });

  it('无人被我取代时返回空', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: '新' });
    expect(factRepo.listSuperseding(db, fid)).toEqual([]);
  });
});
