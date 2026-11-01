/**
 * HTTP REST + Token 鉴权测试（P0-18）。
 *
 * 用 Fastify 的 `inject()` 测，不需要启真实端口。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { insertFact } from '../fixtures/factories.js';

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

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-http-'));
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

async function makeApp(db: Db) {
  const home = tempDir();
  const cfg = loadConfig({ home });
  const token = 'test_token_12345';
  const { app } = await buildHttpApp({ db, cfg, token });
  return { app, token };
}

describe('token auth', () => {
  it('不带 token 的 GET /api/facts 返回 401', async () => {
    const { app } = await makeApp(freshDb());
    const res = await app.inject({ method: 'GET', url: '/api/facts' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('E_UNAUTHORIZED');
  });

  it('带错 token 返回 401', async () => {
    const { app } = await makeApp(freshDb());
    const res = await app.inject({
      method: 'GET',
      url: '/api/facts',
      headers: { 'X-Moshi-Token': 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('/ui 首屏包含 token', async () => {
    const { app, token } = await makeApp(freshDb());
    const res = await app.inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(token);
    // 占位符必须被替换掉，而不是原样留在页面里
    expect(res.body).not.toContain('window.__MOSHI_TOKEN__');
  });
});

describe('GET /api/facts', () => {
  it('空库返回空列表', async () => {
    const { app, token } = await makeApp(freshDb());
    const res = await app.inject({
      method: 'GET',
      url: '/api/facts',
      headers: { 'X-Moshi-Token': token },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(0);
    expect(body.next_cursor).toBeNull();
  });

  it('能列出事实', async () => {
    const db = freshDb();
    insertFact(db, { content: 'aaa' });
    insertFact(db, { content: 'bbb' });
    const { app, token } = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/facts',
      headers: { 'X-Moshi-Token': token },
    });
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].content).toBeDefined();
  });

  it('分页 limit 生效', async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) insertFact(db, { content: `f${i}` });
    const { app, token } = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/facts?limit=2',
      headers: { 'X-Moshi-Token': token },
    });
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
  });

  it('游标分页：页间不重叠、能翻完所有页、total 不受游标影响', async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) insertFact(db, { content: `f${i}` });
    const { app, token } = await makeApp(db);
    const h = { 'X-Moshi-Token': token };

    const p1 = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/facts?limit=2', headers: h })).body,
    );
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(5);

    const p2 = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/facts?limit=2&cursor=${p1.next_cursor}`,
          headers: h,
        })
      ).body,
    );
    expect(p2.items).toHaveLength(2);
    // 第二页不得与第一页重复
    const p1Ids = new Set(p1.items.map((f: { id: string }) => f.id));
    for (const f of p2.items) expect(p1Ids.has(f.id)).toBe(false);
    expect(p2.total).toBe(5);

    const p3 = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/facts?limit=2&cursor=${p2.next_cursor}`,
          headers: h,
        })
      ).body,
    );
    expect(p3.items).toHaveLength(1);
    expect(p3.next_cursor).toBeNull();
    expect(p3.total).toBe(5);
  });
});

describe('GET /api/facts/:id', () => {
  it('能读到详情', async () => {
    const db = freshDb();
    const fid = insertFact(db, { content: 'aaa' });
    const { app, token } = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/facts/${fid}`,
      headers: { 'X-Moshi-Token': token },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(fid);
    expect(body.content).toBe('aaa');
    // 详情接口字段必须与列表接口一致（snake_case），前端共用一套渲染
    expect(body.epistemic_status).toBe('active');
    expect(typeof body.valid_at).toBe('string');
    expect(Array.isArray(body.audits)).toBe(true);
  });

  it('不存在的 id 返回 404', async () => {
    const { app, token } = await makeApp(freshDb());
    const res = await app.inject({
      method: 'GET',
      url: '/api/facts/f_noexist',
      headers: { 'X-Moshi-Token': token },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/facts/:id', () => {
  it('改 confidence 成功', async () => {
    const db = freshDb();
    const fid = insertFact(db, { content: 'aaa', confidence: 0.5 });
    const { app, token } = await makeApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/facts/${fid}`,
      headers: {
        'X-Moshi-Token': token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confidence: 0.3 }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.changed).toContain('confidence');
  });

  it('改 content 返回 400 E_IMMUTABLE', async () => {
    const db = freshDb();
    const fid = insertFact(db, { content: 'aaa' });
    const { app, token } = await makeApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/facts/${fid}`,
      headers: {
        'X-Moshi-Token': token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'bbb' }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('E_IMMUTABLE');
  });
});
