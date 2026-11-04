/**
 * 归档只读 REST（P2-19-A；详设 §4.3 / §9.3-§9.4）。
 *
 * 覆盖 `GET /api/archive/topics/:slug` 的四条关键分支：
 *   1. 命中：返回台账字段 + 磁盘正文（markdown）；
 *   2. slug 不存在 → 404 E_NOT_FOUND；
 *   3. 台账存在但文件缺失 → 200 + markdown:null + missing:true（页面降级）；
 *   4. `archive_meta.path` 越出 archive_dir → 按缺失处理，绝不读库外文件。
 * 另断言列表接口包含 status / path / last_exported_at（只增字段，P2-19-A 项 1）。
 *
 * 只读：本文件不写 fact/edge，不触发任何 reconcile。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { upsertArchiveMeta } from '../../src/infra/sqlite/archiveRepo.js';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';

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

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-archive-route-'));
  dirs.push(d);
  return d;
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

async function makeApp(db: Db, home: string) {
  const cfg = loadConfig({ home });
  const token = 'test_token_12345';
  const { app } = await buildHttpApp({ db, cfg, token });
  return { app, cfg, token, headers: { 'X-Moshi-Token': token } };
}

/** 在 archive_dir 下落一篇 markdown */
function writeArchiveFile(archiveDir: string, rel: string, text: string): void {
  const file = path.join(archiveDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

const SLUG = '本机开发环境';
const REL = `topics/${SLUG}/${SLUG}.md`;

describe('GET /api/archive/topics/:slug（只读正文）', () => {
  it('命中：返回台账字段与磁盘正文', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, cfg, headers } = await makeApp(db, home);
    upsertArchiveMeta(db, {
      topicId: '7',
      slug: SLUG,
      title: '本机开发环境',
      contentHash: 'sha256:abc',
      revision: 2,
      exportedAt: '2026-11-04T04:00:00.000Z',
      path: REL,
    });
    writeArchiveFile(cfg.storage.archive_dir, REL, '---\ntitle: 本机开发环境\n---\n\n正文内容');

    const res = await app.inject({
      method: 'GET',
      url: `/api/archive/topics/${encodeURIComponent(SLUG)}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      slug: SLUG,
      topic_id: 7,
      title: '本机开发环境',
      revision: 2,
      status: 'active',
      content_hash: 'sha256:abc',
      path: REL,
      derived_at: '2026-11-04T04:00:00.000Z',
    });
    expect(String(body.markdown)).toContain('正文内容');
    expect(body.missing).toBeUndefined();
  });

  it('slug 不存在 → 404 E_NOT_FOUND', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, headers } = await makeApp(db, home);
    const res = await app.inject({
      method: 'GET',
      url: `/api/archive/topics/${encodeURIComponent('不存在的主题')}`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; detail?: { reason?: string } };
    expect(body.error).toBe('E_NOT_FOUND');
    expect(body.detail?.reason).toBe('archive_slug_not_found');
  });

  it('台账有记录但文件缺失 → 200 + markdown:null + missing:true', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, headers } = await makeApp(db, home);
    upsertArchiveMeta(db, {
      topicId: '7',
      slug: SLUG,
      title: '本机开发环境',
      contentHash: 'sha256:abc',
      revision: 2,
      exportedAt: '2026-11-04T04:00:00.000Z',
      path: REL,
    });
    // 不落盘
    const res = await app.inject({
      method: 'GET',
      url: `/api/archive/topics/${encodeURIComponent(SLUG)}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.markdown).toBeNull();
    expect(body.missing).toBe(true);
    expect(body.slug).toBe(SLUG);
  });

  it('archive_meta.path 越出 archive_dir → 不读库外文件（按缺失处理）', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, cfg, headers } = await makeApp(db, home);
    upsertArchiveMeta(db, {
      topicId: '8',
      slug: '逃逸主题',
      title: '逃逸主题',
      contentHash: 'sha256:def',
      revision: 1,
      exportedAt: '2026-11-04T04:00:00.000Z',
      path: '../escape.md',
    });
    // 在 archive_dir 的父目录放一个「库外文件」，若实现不做 containment 就会被读到
    const outside = path.join(cfg.storage.archive_dir, '..', 'escape.md');
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, 'LEAK-原文', 'utf8');

    const res = await app.inject({
      method: 'GET',
      url: `/api/archive/topics/${encodeURIComponent('逃逸主题')}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.markdown).toBeNull();
    expect(body.missing).toBe(true);
  });

  it('列表包含 status / path / last_exported_at（只增字段）', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, headers } = await makeApp(db, home);
    upsertArchiveMeta(db, {
      topicId: '7',
      slug: SLUG,
      title: '本机开发环境',
      contentHash: 'sha256:abc',
      revision: 2,
      exportedAt: '2026-11-04T04:00:00.000Z',
      path: REL,
    });
    const res = await app.inject({ method: 'GET', url: '/api/archive/topics', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      slug: SLUG,
      path: REL,
      last_exported_at: '2026-11-04T04:00:00.000Z',
      status: 'active',
    });
  });
});

describe('POST /api/archive/export（P2-19-A 项 5）', () => {
  it('空 body → 全量导出（无主题时 exported 0，返回 dir/elapsed_ms）', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, cfg, headers } = await makeApp(db, home);
    const res = await app.inject({ method: 'POST', url: '/api/archive/export', payload: {}, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ exported: 0, written: 0, unchanged: 0, proposed: 0, dir: cfg.storage.archive_dir });
    expect(typeof body.elapsed_ms).toBe('number');
  });

  it('slug 命中 → 导出该主题并写盘；随后只读接口能读到正文', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, cfg, headers } = await makeApp(db, home);
    upsertArchiveMeta(db, {
      topicId: '7',
      slug: SLUG,
      title: '本机开发环境',
      contentHash: 'sha256:abc',
      revision: 1,
      exportedAt: '2026-11-04T04:00:00.000Z',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/archive/export',
      payload: { slug: SLUG },
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ exported: 1, written: 1, unchanged: 0, proposed: 0 });
    const meta = db.prepare('SELECT path FROM archive_meta WHERE topic_id = ?').get('7') as { path: string };
    expect(existsSync(path.join(cfg.storage.archive_dir, meta.path))).toBe(true);

    const got = await app.inject({
      method: 'GET',
      url: `/api/archive/topics/${encodeURIComponent(SLUG)}`,
      headers,
    });
    expect(got.statusCode).toBe(200);
    expect(String((got.json() as Record<string, unknown>).markdown)).toContain('本机开发环境');
  });

  it('slug 不存在 → 404 archive_slug_not_found', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, headers } = await makeApp(db, home);
    const res = await app.inject({
      method: 'POST',
      url: '/api/archive/export',
      payload: { slug: '不存在的主题' },
      headers,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; detail?: { reason?: string } };
    expect(body.error).toBe('E_NOT_FOUND');
    expect(body.detail?.reason).toBe('archive_slug_not_found');
  });

  it('slug 与 all 互斥 / 类型非法 → 400 E_INPUT', async () => {
    const home = tempDir();
    const db = freshDb();
    const { app, headers } = await makeApp(db, home);
    const cases: Array<{ payload: unknown; reason: string }> = [
      { payload: { slug: SLUG, all: true }, reason: 'export_target_conflict' },
      { payload: { slug: 123 }, reason: 'slug_invalid' },
      { payload: { all: 'yes' }, reason: 'all_invalid' },
      { payload: [1, 2], reason: 'export_body_invalid' },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/archive/export', payload: c.payload as object, headers });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; detail?: { reason?: string } };
      expect(body.error).toBe('E_INPUT');
      expect(body.detail?.reason).toBe(c.reason);
    }
  });
});
