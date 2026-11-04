/**
 * 归档主题分裂/合并与台账单测（详设 §9.5 / §9.6；台账 P2-16）。
 *
 * 验收：模拟社区合并 → 旧 slug 文件保留且内容是「已并入 X」；台账 JSON 与 archive_meta 一致；
 * 分裂标注正确；合并/分裂不改动其它主题文件；被标记的旧主题再次导出不会被自动覆盖。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../../src/infra/sqlite/factRepo.js';
import { getArchiveMeta, listArchiveMeta } from '../../src/infra/sqlite/archiveRepo.js';
import { archiveTopic } from '../../src/core/archive/index.js';
import {
  ARCHIVE_LEDGER_FILE,
  ARCHIVE_LEDGER_SCHEMA,
  diffArchiveLedger,
  mergeTopics,
  readArchiveLedger,
  splitTopics,
  writeArchiveLedger,
} from '../../src/core/archive/topic.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

interface Env {
  db: Db;
  archiveDir: string;
  roots: string[];
}

function freshEnv(): Env {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-arch-topic-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  const archiveDir = path.join(dir, 'archive');
  return { db, archiveDir, roots: [archiveDir] };
}

function addFact(db: Db, id: string, communityId: number): void {
  insertFact(db, {
    id,
    content: `主题 ${communityId} 的第 ${id} 条事实：moshi 使用 pnpm`,
    ftype: 'semantic',
    confidence: 0.8,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.6,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id }, ext: {} },
    canonicalKey: `ck_${id}`,
    valueHash: `vh_${id}`,
    scope: 'global',
    supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-10-01T00:00:00.000Z',
    communityId,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: null,
    span: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

/** 造一个达标社区：10 条事实 + depends_on 链 + 互斥边（同 archive.test.ts 口径） */
function setupCommunity(db: Db, id: number, n = 10): void {
  db.prepare(
    `INSERT INTO community_summary (community_id, scope, label, summary, fact_count, derived_at, source_rev)
     VALUES (?, 'global', ?, ?, ?, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(id, `主题${id}`, `摘要${id}`, n);
  for (let i = 0; i < n; i += 1) addFact(db, `c${id}_f${i}`, id);
  db.prepare(
    `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
     VALUES (?, ?, ?, 'depends_on', 1.0, 0.9, '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:00:00.000Z')`,
  ).run(`c${id}_f0->c${id}_f1`, `c${id}_f0`, `c${id}_f1`);
  db.prepare(
    `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
     VALUES (?, ?, ?, 'mutually_exclusive', 1.0, 0.9, '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:00:00.000Z')`,
  ).run(`c${id}_f0-_-c${id}_f1`, `c${id}_f0`, `c${id}_f1`);
}

function exportTopic(
  env: Env,
  topicId: number,
  now: string,
  title: string,
): { slug: string; file: string; relPath: string } {
  const res = archiveTopic(env.db, topicId, { archiveDir: env.archiveDir, roots: env.roots, now, title });
  expect(res.written).toBe(true);
  return { slug: res.doc.slug, file: res.path!, relPath: getArchiveMeta(env.db, String(topicId))!.path };
}

describe('归档合并（P2-16 §9.5）', () => {
  it('旧 slug 保留且内容为「已并入 X」；存活 slug 迁到新 topic_id；其它主题文件不动', () => {
    const env = freshEnv();
    setupCommunity(env.db, 1);
    setupCommunity(env.db, 2);
    setupCommunity(env.db, 3);

    const older = exportTopic(env, 1, '2026-10-01T00:00:00.000Z', '开发环境');
    const newer = exportTopic(env, 2, '2026-10-10T00:00:00.000Z', '网络配置');
    const other = exportTopic(env, 3, '2026-10-05T00:00:00.000Z', '磁盘清理');

    const olderFile = older.file;
    const newerFile = newer.file;
    const otherFile = other.file;
    const olderBefore = readFileSync(olderFile, 'utf8');
    const otherBefore = readFileSync(otherFile, 'utf8');

    const res = mergeTopics(env.db, {
      oldTopicIds: [1, 2],
      newTopicId: 5,
      archiveDir: env.archiveDir,
      roots: env.roots,
      now: '2026-11-01T00:00:00.000Z',
    });

    // 存活 = last_exported_at 更早的 topic 1（开发环境）
    expect(res.survivor).toMatchObject({ topicId: '5', slug: older.slug, path: older.relPath });
    expect(res.merged).toEqual([{ topicId: '2', slug: newer.slug, path: newer.relPath }]);

    // 记账迁移：'1' 消失，'5' 继承 slug；'2' 标记 merged 但行保留
    expect(getArchiveMeta(env.db, '1')).toBeNull();
    const survivors = getArchiveMeta(env.db, '5')!;
    expect(survivors.slug).toBe(older.slug);
    expect(survivors.status).toBe('active');
    const mergedMeta = getArchiveMeta(env.db, '2')!;
    expect(mergedMeta.status).toBe('merged');
    expect(mergedMeta.slug).toBe(newer.slug);

    // 存活文件字节不变；被合并文件仍在且改为跳转文档（不删文件、不复制正文）
    expect(readFileSync(olderFile, 'utf8')).toBe(olderBefore);
    const redirect = readFileSync(newerFile, 'utf8');
    expect(redirect).toContain(`# 已并入 开发环境`);
    expect(redirect).toContain(`merged_into: ${older.slug}`);
    expect(redirect).toContain(older.relPath);
    expect(redirect).not.toContain('第 c2_f0 条事实');
    expect(existsSync(newerFile)).toBe(true);

    // 其它主题文件与状态不受影响
    expect(readFileSync(otherFile, 'utf8')).toBe(otherBefore);
    expect(getArchiveMeta(env.db, '3')!.status).toBe('active');
  });

  it('新 topic_id 已有归档记账 → E_INPUT（避免撞主键/丢 slug）', () => {
    const env = freshEnv();
    setupCommunity(env.db, 1);
    setupCommunity(env.db, 2);
    exportTopic(env, 1, '2026-10-01T00:00:00.000Z', '开发环境');
    exportTopic(env, 2, '2026-10-02T00:00:00.000Z', '网络配置');
    expect(() =>
      mergeTopics(env.db, {
        oldTopicIds: [1],
        newTopicId: 2,
        archiveDir: env.archiveDir,
        roots: env.roots,
      }),
    ).toThrow(/新 topic_id 已有归档记账/);
  });
});

describe('归档分裂（P2-16 §9.5）', () => {
  it('原文档保留并加「已拆分为 A / B」；新主题建 slug；幂等；旧主题再导出不覆盖标记', () => {
    const env = freshEnv();
    setupCommunity(env.db, 1, 12);
    const old = exportTopic(env, 1, '2026-10-01T00:00:00.000Z', '开发环境');
    const oldFile = old.file;

    const res = splitTopics(env.db, {
      oldTopicId: 1,
      newTopicIds: [8, 9],
      titles: { 8: '前端', 9: '后端' },
      archiveDir: env.archiveDir,
      roots: env.roots,
      now: '2026-11-01T00:00:00.000Z',
    });
    expect(res.old).toMatchObject({ topicId: '1', slug: old.slug, status: 'split', annotated: true });
    expect(res.newTopics).toEqual([
      { topicId: '8', slug: '前端', title: '前端', path: 'topics/前端/前端.md', created: true },
      { topicId: '9', slug: '后端', title: '后端', path: 'topics/后端/后端.md', created: true },
    ]);
    expect(getArchiveMeta(env.db, '1')!.status).toBe('split');
    expect(getArchiveMeta(env.db, '8')!.status).toBe('active');
    expect(getArchiveMeta(env.db, '8')!.lastExportedAt).toBeNull();

    const text = readFileSync(oldFile, 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('> **已拆分为 前端 / 后端**');
    // banner 在正文最顶部（frontmatter 之后、一句话结论之前）
    expect(text.indexOf('> **已拆分为')).toBeLessThan(text.indexOf('## 一句话结论'));

    // 幂等：再跑一次不重复 banner、不改文件
    const before = readFileSync(oldFile, 'utf8');
    const res2 = splitTopics(env.db, {
      oldTopicId: 1,
      newTopicIds: [8, 9],
      titles: { 8: '前端', 9: '后端' },
      archiveDir: env.archiveDir,
      roots: env.roots,
    });
    expect(res2.old.annotated).toBe(false);
    expect(readFileSync(oldFile, 'utf8')).toBe(before);

    // status != active 的主题不再自动导出（否则会抹掉拆分标记）
    const again = archiveTopic(env.db, 1, {
      archiveDir: env.archiveDir,
      roots: env.roots,
      now: '2026-12-01T00:00:00.000Z',
      title: '开发环境',
    });
    expect(again.action).toBe('skip');
    expect(readFileSync(oldFile, 'utf8')).toBe(before);
  });
});

describe('台账 .moshi-archive.json（P2-16 §9.6）', () => {
  it('以 DB 为准生成；schema/字段正确；与 archive_meta 一致；差异可检测并重建', () => {
    const env = freshEnv();
    setupCommunity(env.db, 1);
    setupCommunity(env.db, 2);
    exportTopic(env, 1, '2026-10-01T00:00:00.000Z', '开发环境');
    exportTopic(env, 2, '2026-10-02T00:00:00.000Z', '网络配置');
    mergeTopics(env.db, {
      oldTopicIds: [1, 2],
      newTopicId: 5,
      archiveDir: env.archiveDir,
      roots: env.roots,
      now: '2026-11-01T00:00:00.000Z',
    });

    const written = writeArchiveLedger(env.db, {
      archiveDir: env.archiveDir,
      roots: env.roots,
      now: '2026-11-02T00:00:00.000Z',
    });
    expect(written.path).toBe(path.join(env.archiveDir, ARCHIVE_LEDGER_FILE));
    expect(written.differences).toEqual([]);

    const raw = JSON.parse(readFileSync(written.path, 'utf8')) as {
      schema: string;
      generated_at: string;
      topics: { topic_id: string; slug: string; path: string; revision: number; content_hash: string; status: string }[];
    };
    expect(raw.schema).toBe(ARCHIVE_LEDGER_SCHEMA);
    expect(raw.generated_at).toBe('2026-11-02T00:00:00.000Z');

    // 台账 topics 与 archive_meta 逐字段一致
    const metas = listArchiveMeta(env.db, 1_000_000);
    expect(raw.topics).toHaveLength(metas.length);
    for (const meta of metas) {
      const t = raw.topics.find((x) => x.topic_id === meta.topicId)!;
      expect(t).toBeDefined();
      expect(t.slug).toBe(meta.slug);
      expect(t.path).toBe(meta.path);
      expect(t.revision).toBe(meta.revision);
      expect(t.content_hash).toBe(meta.contentHash);
      expect(t.status).toBe(meta.status);
    }
    const ledger = readArchiveLedger(env.archiveDir)!;
    expect(diffArchiveLedger(env.db, ledger)).toEqual([]);

    // 手工篡改台账 revision → 检测出差异；重建后归零
    const tampered = raw.topics.map((t) => ({ ...t }));
    tampered[0]!.revision += 9;
    writeFileSync(written.path, JSON.stringify({ ...raw, topics: tampered }, null, 2));
    const stale = readArchiveLedger(env.archiveDir)!;
    const diffs = diffArchiveLedger(env.db, stale);
    expect(diffs.some((d) => d.kind === 'field_mismatch' && d.field === 'revision')).toBe(true);

    const rebuilt = writeArchiveLedger(env.db, { archiveDir: env.archiveDir, roots: env.roots });
    expect(rebuilt.consistent).toBe(false);
    expect(rebuilt.differences.length).toBeGreaterThan(0);
    expect(diffArchiveLedger(env.db, readArchiveLedger(env.archiveDir)!)).toEqual([]);
  });
});
