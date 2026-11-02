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

  it('列表带 importance 字段（表格「重要」列与 importance 游标都要读它）', async () => {
    const db = freshDb();
    insertFact(db, { content: 'aaa', importance: 0.7 });
    const { app, token } = await makeApp(db);
    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/facts', headers: { 'X-Moshi-Token': token } })).body,
    );
    expect(typeof body.items[0].importance).toBe('number');
    expect(body.items[0].importance).toBeCloseTo(0.7, 5);
  });

  it('sort=importance：importance DESC、同分按 id ASC（稳定键，翻页不会来回跳）', async () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_t1', importance: 0.9 });
    insertFact(db, { id: 'fact_t2', importance: 0.9 });
    insertFact(db, { id: 'fact_t3', importance: 0.3 });
    insertFact(db, { id: 'fact_t4', importance: 0.1 });
    const { app, token } = await makeApp(db);
    const body = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/facts?sort=importance',
          headers: { 'X-Moshi-Token': token },
        })
      ).body,
    );
    expect(body.items.map((f: { id: string }) => f.id)).toEqual(['fact_t1', 'fact_t2', 'fact_t3', 'fact_t4']);
  });

  it('sort=importance 的游标翻页：页间不重叠、能翻完、total 不受游标影响', async () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_t1', importance: 0.9 });
    insertFact(db, { id: 'fact_t2', importance: 0.9 });
    insertFact(db, { id: 'fact_t3', importance: 0.3 });
    insertFact(db, { id: 'fact_t4', importance: 0.1 });
    const { app, token } = await makeApp(db);
    const h = { 'X-Moshi-Token': token };
    const get = async (url: string): Promise<{
      items: { id: string }[];
      next_cursor: string | null;
      total: number;
    }> => JSON.parse((await app.inject({ method: 'GET', url, headers: h })).body);

    const p1 = await get('/api/facts?sort=importance&limit=2');
    expect(p1.items.map((f) => f.id)).toEqual(['fact_t1', 'fact_t2']);
    expect(p1.next_cursor).not.toBeNull();
    expect(p1.total).toBe(4);

    const p2 = await get(`/api/facts?sort=importance&limit=2&cursor=${String(p1.next_cursor)}`);
    // 同分跨页：0.9 的两条之后必须是 0.3，不能把 0.9 又捞回来
    expect(p2.items.map((f) => f.id)).toEqual(['fact_t3', 'fact_t4']);
    expect(p2.next_cursor).toBeNull();
    expect(p2.total).toBe(4);

    const ids = new Set([...p1.items, ...p2.items].map((f) => f.id));
    expect(ids.size).toBe(4);
  });

  it('sort 拼错回落 time（深链不该因为一个参数白屏）', async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) insertFact(db, { content: `f${i}` });
    const { app, token } = await makeApp(db);
    const h = { 'X-Moshi-Token': token };

    const bogus = await app.inject({ method: 'GET', url: '/api/facts?sort=bogus&limit=2', headers: h });
    expect(bogus.statusCode).toBe(200);
    expect(JSON.parse(bogus.body).items).toHaveLength(2);
  });

  it('limit：缺省 50、1 与 200 原样生效、超上限夹到 200 而不报错', async () => {
    const db = freshDb();
    for (let i = 0; i < 205; i++) insertFact(db, { content: `f${i}` });
    const { app, token } = await makeApp(db);
    const h = { 'X-Moshi-Token': token };
    const items = async (qs: string): Promise<unknown[]> =>
      JSON.parse((await app.inject({ method: 'GET', url: `/api/facts${qs}`, headers: h })).body).items;

    expect(await items('')).toHaveLength(50); // 缺省
    expect(await items('?limit=1')).toHaveLength(1);
    expect(await items('?limit=200')).toHaveLength(200);
    // 手搓 URL 超过上限只夹住（详设口径就是 limit≤200），不当参数错误
    expect(await items('?limit=201')).toHaveLength(200);
  });

  it('limit 非正整数一律 400 limit_invalid（不再 500、不再一次拉走全库、空库也不许伪装到底）', async () => {
    // 空库很关键：limit=0 以前在空库上返回 items:[] + next_cursor:null，看起来"翻完了"
    const { app, token } = await makeApp(freshDb());
    const h = { 'X-Moshi-Token': token };
    for (const raw of ['abc', '1.9', '', '0', '-5']) {
      const res = await app.inject({ method: 'GET', url: `/api/facts?limit=${raw}`, headers: h });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('E_INPUT');
      expect(body.detail.reason).toBe('limit_invalid');
    }
  });

  it('跨 sort 复用游标 → 400 cursor_sort_mismatch（两个方向都不许静默回第 1 页）', async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) insertFact(db, { content: `f${i}` });
    const { app, token } = await makeApp(db);
    const h = { 'X-Moshi-Token': token };
    const first = async (sort: string): Promise<string> =>
      String(
        JSON.parse(
          (await app.inject({ method: 'GET', url: `/api/facts?sort=${sort}&limit=2`, headers: h })).body,
        ).next_cursor,
      );
    const timeCursor = await first('time');
    const importanceCursor = await first('importance');

    for (const [sort, cursor] of [
      ['importance', timeCursor], // time 游标拿去排 importance
      ['time', importanceCursor], // 反向
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/facts?sort=${sort}&limit=2&cursor=${cursor}`,
        headers: h,
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('E_INPUT');
      expect(body.detail.reason).toBe('cursor_sort_mismatch');
      expect(body.detail.sort).toBe(sort);
    }
  });

  it('坏游标一律 400 cursor_invalid（坏 base64 / 坏 JSON / 缺字段 / 无 sort 旧格式）', async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) insertFact(db, { content: `f${i}` });
    const { app, token } = await makeApp(db);
    const h = { 'X-Moshi-Token': token };
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const cursors = [
      '***', // 非 base64url 字符集
      b64('{oops'), // 字符集合法但 JSON 坏
      b64({ sort: 'time' }), // 缺 id / valid_at
      b64({ valid_at: '2026-01-01T00:00:00.000Z', id: 'fact_x' }), // 无 sort 的旧格式，不兼容
    ];
    for (const cursor of cursors) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/facts?limit=2&cursor=${cursor}`,
        headers: h,
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('E_INPUT');
      expect(body.detail.reason).toBe('cursor_invalid');
    }
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
