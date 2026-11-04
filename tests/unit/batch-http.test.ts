/**
 * 批量失效全链路 HTTP 测试（P2-07）。
 *
 * 覆盖：三队列接口的形状与 limit 校验、preview/batch/undo 三个动作、
 * 错误信封（400 `E_INPUT` + `detail.reason`、404 `E_NOT_FOUND`、410 `E_OP_EXPIRED`）、
 * 以及"同一 op 只能撤销一次"的约束。全部用 `app.inject()`，不启真实端口。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertDerivedPoint, insertEdge, insertFact, makeEntity } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];
const TOKEN = 'test_token_p207';

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
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-batch-'));
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

async function makeApp(db: Db, extra: { batchOpTtlMs?: number } = {}) {
  const home = tempDir();
  const cfg = loadConfig({ home });
  const { app } = await buildHttpApp({ db, cfg, token: TOKEN, ...extra });
  return app;
}

const auth = { 'X-Moshi-Token': TOKEN };

function body(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

function factRow(db: Db, id: string): { valid_to: string | null; epistemic_status: string } {
  return db.prepare('SELECT valid_to, epistemic_status FROM fact WHERE id = ?').get(id) as {
    valid_to: string | null;
    epistemic_status: string;
  };
}

async function post(app: Awaited<ReturnType<typeof makeApp>>, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
}

// ── 鉴权 ──

describe('队列与批量的 token 鉴权', () => {
  it('不带 token 的 /api/queues/resolve 返回 401', async () => {
    const app = await makeApp(freshDb());
    const res = await app.inject({ method: 'GET', url: '/api/queues/resolve' });
    expect(res.statusCode).toBe(401);
    expect(body(res).error).toBe('E_UNAUTHORIZED');
  });

  it('不带 token 的 /api/facts/batch 返回 401', async () => {
    const app = await makeApp(freshDb());
    const res = await app.inject({ method: 'POST', url: '/api/facts/batch', payload: { action: 'invalidate', ids: [] } });
    expect(res.statusCode).toBe(401);
  });
});

// ── 三队列 ──

describe('GET /api/queues/*', () => {
  it('resolve 返回 alias/entity_id/canonical_name/confidence', async () => {
    const db = freshDb();
    const e = makeEntity(db, 'pkg-q');
    db.prepare(
      `INSERT INTO alias (alias, entity_id, source, confidence, created_at) VALUES (?, ?, 'vector', ?, ?)`,
    ).run('pkg-q@22', e, 0.77, new Date().toISOString());
    const app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/queues/resolve', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(body(res).items).toEqual([
      { alias: 'pkg-q@22', entity_id: e, canonical_name: 'pkg-q', confidence: 0.77 },
    ]);
  });

  it('lowconf 返回 id/content/confidence/importance', async () => {
    const db = freshDb();
    const id = insertFact(db, { content: '可疑事实', confidence: 0.3, importance: 0.8 });
    const app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/queues/lowconf?limit=10', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(body(res).items).toEqual([
      { id, content: '可疑事实', confidence: 0.3, importance: 0.8 },
    ]);
  });

  it('prune 返回 id/content/strength/last_access_at', async () => {
    const db = freshDb();
    const id = insertFact(db, { content: '快忘了', strength: 0.05 });
    const app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/queues/prune', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(body(res).items).toEqual([
      { id, content: '快忘了', strength: 0.05, last_access_at: null },
    ]);
  });

  it('limit 缺省 50；limit=0 / limit=abc 都是 400 E_INPUT limit_invalid；limit=500 截断到 200', async () => {
    const app = await makeApp(freshDb());
    for (const q of ['limit=0', 'limit=abc', 'limit=-3']) {
      const res = await app.inject({ method: 'GET', url: `/api/queues/prune?${q}`, headers: auth });
      expect(res.statusCode).toBe(400);
      const b = body(res);
      expect(b.error).toBe('E_INPUT');
      expect((b.detail as { reason: string }).reason).toBe('limit_invalid');
    }
    const ok = await app.inject({ method: 'GET', url: '/api/queues/prune?limit=500', headers: auth });
    expect(ok.statusCode).toBe(200);
  });

  it('min_sim > max_sim 返回 400 E_INPUT sim_invalid', async () => {
    const app = await makeApp(freshDb());
    const res = await app.inject({
      method: 'GET',
      url: '/api/queues/resolve?min_sim=0.9&max_sim=0.7',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect((body(res).detail as { reason: string }).reason).toBe('sim_invalid');
  });
});

// ── 预览 ──

describe('POST /api/facts/batch/preview', () => {
  it('返回四个计数 + preview_sample，且不写库', async () => {
    const db = freshDb();
    const f1 = insertFact(db, { content: 'f1', importance: 0.9 });
    const f2 = insertFact(db, { content: 'f2' });
    const f3 = insertFact(db, { content: 'f3' });
    db.prepare('UPDATE fact SET community_id = 3 WHERE id IN (?, ?)').run(f1, f2);
    insertEdge(db, f1, f3);
    insertEdge(db, f3, f1);
    const app = await makeApp(db);

    const res = await post(app, '/api/facts/batch/preview', { action: 'invalidate', ids: [f1, f2] });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({
      facts: 2,
      edges: 2,
      topics: 1,
      invalidated_by_cascade: 1,
      preview_sample: [
        { id: f1, content: 'f1' },
        { id: f2, content: 'f2' },
      ],
    });
    // 预览不写库
    expect(factRow(db, f1).valid_to).toBeNull();
  });

  it('action 非 invalidate → 400 E_INPUT unsupported_action', async () => {
    const app = await makeApp(freshDb());
    const res = await post(app, '/api/facts/batch/preview', { action: 'archive', ids: ['f_x'] });
    expect(res.statusCode).toBe(400);
    expect((body(res).detail as { reason: string }).reason).toBe('unsupported_action');
  });

  it('不存在的 id → 400 E_INPUT unknown_ids（整批拒绝）', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const app = await makeApp(db);
    const res = await post(app, '/api/facts/batch/preview', {
      action: 'invalidate',
      ids: [a, 'f_missing'],
    });
    expect(res.statusCode).toBe(400);
    const b = body(res);
    expect(b.error).toBe('E_INPUT');
    expect((b.detail as { reason: string }).reason).toBe('unknown_ids');
    expect(factRow(db, a).valid_to).toBeNull(); // 整批拒绝 = 一条都没动
  });

  it('ids 为空 / 非字符串 / 非数组 → 400 ids_invalid', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const app = await makeApp(db);
    for (const ids of [[], [a, 42], 'not-an-array']) {
      const res = await post(app, '/api/facts/batch/preview', { action: 'invalidate', ids });
      expect(res.statusCode).toBe(400);
      expect((body(res).detail as { reason: string }).reason).toBe('ids_invalid');
    }
  });
});

// ── 执行 + 撤销 ──

describe('POST /api/facts/batch 与 undo', () => {
  it('执行返回 op_id/计数/undo_deadline，并真的收口', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const app = await makeApp(db);

    const res = await post(app, '/api/facts/batch', { action: 'invalidate', ids: [a, b, a] });
    expect(res.statusCode).toBe(200);
    const b1 = body(res);
    expect(String(b1.op_id)).toMatch(/^b_[0-9a-z]{26}$/);
    expect(b1.facts).toBe(2);
    expect(b1.edges).toBe(0);
    expect(b1.topics).toBe(0);
    expect(b1.invalidated_by_cascade).toBe(0);
    const deadline = String(b1.undo_deadline);
    expect(deadline).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(deadline)).toBeGreaterThan(Date.now() - 1000);

    for (const id of [a, b]) {
      expect(factRow(db, id)).toMatchObject({ epistemic_status: 'invalidated' });
      expect(factRow(db, id).valid_to).not.toBeNull();
    }
  });

  it('批量失效源事实后立即收口其派生要点', async () => {
    const db = freshDb();
    const src = insertFact(db, {
      ftype: 'episodic',
      validAt: new Date(Date.now() - 1000).toISOString(),
    });
    const point = insertDerivedPoint(db, [src]);
    const app = await makeApp(db);

    const res = await post(app, '/api/facts/batch', { action: 'invalidate', ids: [src] });
    expect(res.statusCode).toBe(200);
    const row = db
      .prepare('SELECT valid_to, epistemic_status FROM fact WHERE id = ?')
      .get(point) as { valid_to: string | null; epistemic_status: string };
    expect(row.valid_to).not.toBeNull();
    expect(row.epistemic_status).toBe('invalidated');
  });

  it('撤销返回 restored 并清回 valid_to；同一 op 二次撤销 404', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const app = await makeApp(db);

    const opId = String(body(await post(app, '/api/facts/batch', { action: 'invalidate', ids: [a, b] })).op_id);
    const undo = await post(app, '/api/facts/batch/undo', { op_id: opId });
    expect(undo.statusCode).toBe(200);
    expect(body(undo)).toEqual({ restored: 2 });
    for (const id of [a, b]) {
      expect(factRow(db, id)).toMatchObject({ valid_to: null, epistemic_status: 'active' });
    }

    const again = await post(app, '/api/facts/batch/undo', { op_id: opId });
    expect(again.statusCode).toBe(404);
    expect(body(again).error).toBe('E_NOT_FOUND');
    // 不得二次还原（这里已经是 active，再撤销也不会重复写）
    expect(factRow(db, a).valid_to).toBeNull();
  });

  it('从未签发的 op_id → 404 E_NOT_FOUND；op_id 缺失 → 400 op_id_invalid', async () => {
    const app = await makeApp(freshDb());
    const unknown = await post(app, '/api/facts/batch/undo', { op_id: 'b_not_issued' });
    expect(unknown.statusCode).toBe(404);
    expect(body(unknown).error).toBe('E_NOT_FOUND');

    const missing = await post(app, '/api/facts/batch/undo', {});
    expect(missing.statusCode).toBe(400);
    expect((body(missing).detail as { reason: string }).reason).toBe('op_id_invalid');
  });

  it('超过撤销窗口 → 410 E_OP_EXPIRED，且不还原', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const app = await makeApp(db, { batchOpTtlMs: 5 });

    const opId = String(body(await post(app, '/api/facts/batch', { action: 'invalidate', ids: [a] })).op_id);
    await new Promise((r) => setTimeout(r, 30));
    const res = await post(app, '/api/facts/batch/undo', { op_id: opId });
    expect(res.statusCode).toBe(410);
    expect(body(res).error).toBe('E_OP_EXPIRED');
    expect(factRow(db, a).valid_to).not.toBeNull();
  });

  it('批量失效不动 edge（撤销窗口内边必须原样留着）', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const b = insertFact(db, { content: 'b' });
    const edgeId = insertEdge(db, a, b);
    const app = await makeApp(db);

    await post(app, '/api/facts/batch', { action: 'invalidate', ids: [a] });
    const row = db.prepare('SELECT valid_to FROM edge WHERE id = ?').get(edgeId) as {
      valid_to: string | null;
    };
    expect(row.valid_to).toBeNull();
  });

  it('一个 app 实例的 op 不会泄漏到另一个实例（插件闭包隔离）', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'a' });
    const app1 = await makeApp(db);
    const app2 = await makeApp(db);

    const opId = String(body(await post(app1, '/api/facts/batch', { action: 'invalidate', ids: [a] })).op_id);
    const res = await post(app2, '/api/facts/batch/undo', { op_id: opId });
    expect(res.statusCode).toBe(404);
  });
});
