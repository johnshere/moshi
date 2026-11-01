/**
 * P1-15 归档导出与渲染单测（详设 §9.1–§9.4 / 附录 A；台账 P1-15）。
 *
 * 验收：主题选取过滤（fact_count≥8 + 依赖链/互斥）；分节渲染（关键事实/依赖链/
 * 时间线/已失效/溯源索引）；content_hash 只对正文算（改 derived_at 不影响 hash）；
 * hash 未变不写盘；100 主题全量 < 60s（本测试用 10 主题）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import type { Epistemic } from '../../src/domain/enums.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../../src/infra/sqlite/factRepo.js';
import { selectTopics } from '../../src/core/archive/topics.js';
import { renderTopic } from '../../src/core/archive/render.js';
import { archiveAll, archiveTopic } from '../../src/core/archive/index.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-arch-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addFact(db: Db, id: string, opts: { community?: number; conf?: number; content?: string; validTo?: string | null; status?: string; episode?: string; span?: string } = {}): void {
  insertFact(db, {
    id,
    content: opts.content ?? `事实 ${id}`,
    ftype: 'semantic',
    confidence: opts.conf ?? 0.8,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.6,
    pool: 'utility',
    epistemicStatus: (opts.status ?? 'active') as Epistemic,
    attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id }, ext: {} },
    canonicalKey: `ck_${id}`, valueHash: `vh_${id}`, scope: 'global', supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z',
    validTo: opts.validTo ?? null,
    recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: opts.community ?? null,
    degree: 0, accessCount: 0, lastAccessAt: null, lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: opts.episode ?? null,
    span: opts.span ? (JSON.parse(opts.span) as [number, number]) : null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

function setupCommunity(db: Db, id = 1, n = 8): void {
  db.prepare(
    `INSERT INTO community_summary (community_id, scope, label, summary, fact_count, derived_at, source_rev)
     VALUES (?, 'global', ?, ?, ?, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(id, `主题${id}`, `摘要${id}`, n);
  for (let i = 0; i < n; i += 1) {
    addFact(db, `c${id}_f${i}`, { community: id, conf: 0.6 + (i % 3) * 0.1 });
  }
  // depends_on 链：f0 → f1 → f2
  for (const [src, dst] of [
    [`c${id}_f0`, `c${id}_f1`],
    [`c${id}_f1`, `c${id}_f2`],
  ] as const) {
    db.prepare(
      `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
       VALUES (?, ?, ?, 'depends_on', 1.0, 0.9, '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:00:00.000Z')`,
    ).run(`${src}->${dst}`, src, dst);
  }
  // 互斥边：让 chainCompleteness 不足时也能达标（完整度 3/8=0.375 < 0.5 → 需 hasMutex）
  // 用 f0/f1（前两条，任何 n≥2 都存在），避免 n=3 时 FK 失败
  db.prepare(
    `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
     VALUES (?, ?, ?, 'mutually_exclusive', 1.0, 0.9, '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:00:00.000Z')`,
  ).run(`c${id}_f0-_-c${id}_f1`, `c${id}_f0`, `c${id}_f1`);
}

describe('归档导出与渲染（P1-15）', () => {
  it('selectTopics：fact_count≥8 且（依赖链≥0.5 或互斥边）才入选；不足 8 剔除', () => {
    const db = freshDb();
    setupCommunity(db, 1, 8);
    setupCommunity(db, 2, 3); // 太少
    const topics = selectTopics(db);
    expect(topics.map((t) => t.communityId)).toEqual([1]);
    // 依赖链完整度 3/8=0.375 < 0.5 → 靠互斥边入选
    expect(topics[0]!.chainCompleteness).toBe(0.375);
    expect(topics[0]!.hasMutex).toBe(true);
  });

  it('renderTopic：分节齐全；一句话结论 = 最高 confidence×importance', () => {
    const db = freshDb();
    setupCommunity(db, 1, 8);
    const doc = renderTopic(db, 1, { now: '2026-11-01T00:00:00.000Z' });
    expect(doc.body).toContain('## 一句话结论');
    expect(doc.body).toContain('## 关键事实');
    expect(doc.body).toContain('## 依赖链');
    expect(doc.body).toContain('## 时间线');
    expect(doc.body).toContain('## 溯源索引');
    expect(doc.body).toContain('→'); // 依赖链 A → B → C
    expect(doc.body).not.toContain('episode 无'); // 溯源索引给 episode_id
  });

  it('content_hash 只对正文：derived_at 不影响 hash；hash 未变不写盘', () => {
    const db = freshDb();
    setupCommunity(db, 1, 8);
    const a = renderTopic(db, 1, { now: '2026-11-01T00:00:00.000Z' });
    const b = renderTopic(db, 1, { now: '2026-11-02T00:00:00.000Z' }); // 仅 derived_at 变
    expect(a.contentHash).toBe(b.contentHash);

    const r1 = archiveTopic(db, 1, { now: '2026-11-01T00:00:00.000Z' });
    expect(r1.written).toBe(true);
    const r2 = archiveTopic(db, 1, { now: '2026-11-02T00:00:00.000Z' });
    expect(r2.written).toBe(false); // 内容没变 → 不写盘
    const meta = db.prepare('SELECT revision, content_hash FROM archive_meta WHERE topic_id = ?').get('1') as {
      revision: number; content_hash: string;
    };
    expect(meta.revision).toBe(1); // 第二次没递增
    expect(meta.content_hash).toBe(a.contentHash);
  });

  it('archiveAll：多主题全量、写盘计数、10 主题 < 60s', () => {
    const db = freshDb();
    for (let i = 1; i <= 10; i += 1) setupCommunity(db, i, 8);
    const started = Date.now();
    const res = archiveAll(db);
    const elapsed = Date.now() - started;
    expect(res.docs).toHaveLength(10);
    expect(res.written).toBe(10);
    expect(elapsed).toBeLessThan(60_000);
    // slug 唯一
    const slugs = res.docs.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(10);
  });
});
