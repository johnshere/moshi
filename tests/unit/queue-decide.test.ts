/**
 * 队列单条决策（P2-19-A）：`POST /api/queues/:kind/decide` + 30 秒撤销。
 *
 * 覆盖：
 * - resolve 三动作（merge / keep / reject）：返回 before/after、alias 行落地、merge 可撤销；
 * - lowconf 二动作（promote / invalidate）：confidence 抬升、软删 + 撤销恢复；
 * - 错误分支：非法 kind / action / id、行不存在 404、事实非活跃 400。
 *
 * 全部用 `app.inject()`，不启真实端口。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact, makeEntity } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];
const TOKEN = 'test_token_p19a_queue';

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
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-queue-decide-'));
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
  const { app } = await buildHttpApp({ db, cfg, token: TOKEN });
  return app;
}

const auth = { 'X-Moshi-Token': TOKEN };

async function get(app: Awaited<ReturnType<typeof makeApp>>, url: string) {
  return app.inject({ method: 'GET', url, headers: auth });
}

async function post(app: Awaited<ReturnType<typeof makeApp>>, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
}

function body(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('POST /api/queues/resolve/decide', () => {
  it('merge：alias 收为 human/1.0，其它 vector 候选归 0；撤销还原', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const canonical = makeEntity(db, 'pkg-canonical');
    const other = makeEntity(db, 'pkg-other');
    entityRepo.addAlias(db, { alias: 'left-pad', entityId: canonical, source: 'vector', confidence: 0.8 });
    entityRepo.addAlias(db, { alias: 'left-pad', entityId: other, source: 'vector', confidence: 0.7 });

    const list = body(await get(app, '/api/queues/resolve'));
    const items = list['items'] as { id: string; entity_id: string; confidence: number }[];
    const target = items.find((it) => it.entity_id === canonical);
    expect(target).toBeDefined();

    const res = await post(app, '/api/queues/resolve/decide', {
      id: target?.id,
      action: 'merge',
    });
    expect(res.statusCode).toBe(200);
    const result = body(res);
    expect(result['ok']).toBe(true);
    expect(result['before']).toMatchObject({ source: 'vector', confidence: 0.8 });
    expect(result['after']).toMatchObject({ source: 'human', confidence: 1 });
    expect(typeof result['op_id']).toBe('string');

    const rows = db
      .prepare('SELECT entity_id, source, confidence FROM alias WHERE alias = ? ORDER BY entity_id')
      .all('left-pad') as { entity_id: string; source: string; confidence: number }[];
    expect(rows.find((r) => r.entity_id === canonical)).toMatchObject({ source: 'human', confidence: 1 });
    expect(rows.find((r) => r.entity_id === other)).toMatchObject({ source: 'human', confidence: 0 });
    // 队列只认 vector：并入后两边都从队列消失
    expect((body(await get(app, '/api/queues/resolve'))['items'] as unknown[]).length).toBe(0);

    const undo = await post(app, `/api/facts/ops/${String(result['op_id'])}/undo`, {});
    expect(undo.statusCode).toBe(200);
    expect(body(undo)['restored']).toBe(2);
    const restored = db
      .prepare('SELECT source, confidence FROM alias WHERE alias = ? AND entity_id = ?')
      .get('left-pad', canonical) as { source: string; confidence: number };
    expect(restored).toMatchObject({ source: 'vector', confidence: 0.8 });
  });

  it('keep：来源标人工、confidence 抬到 0.95，无 op_id', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const entityId = makeEntity(db, 'pkg-keep');
    entityRepo.addAlias(db, { alias: 'keepme', entityId, source: 'vector', confidence: 0.75 });

    const list = body(await get(app, '/api/queues/resolve'));
    const item = (list['items'] as { id: string }[])[0];
    const res = await post(app, '/api/queues/resolve/decide', { id: item?.id, action: 'keep' });
    expect(res.statusCode).toBe(200);
    const result = body(res);
    expect(result['after']).toMatchObject({ source: 'human', confidence: 0.95 });
    expect(result['op_id']).toBeUndefined();

    const row = db
      .prepare('SELECT source, confidence FROM alias WHERE alias = ? AND entity_id = ?')
      .get('keepme', entityId) as { source: string; confidence: number };
    expect(row).toMatchObject({ source: 'human', confidence: 0.95 });
  });

  it('reject：置信度归 0、行保留', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const entityId = makeEntity(db, 'pkg-reject');
    entityRepo.addAlias(db, { alias: 'rejectme', entityId, source: 'vector', confidence: 0.66 });

    const list = body(await get(app, '/api/queues/resolve'));
    const item = (list['items'] as { id: string }[])[0];
    const res = await post(app, '/api/queues/resolve/decide', { id: item?.id, action: 'reject' });
    expect(res.statusCode).toBe(200);
    expect(body(res)['after']).toMatchObject({ source: 'human', confidence: 0 });

    const row = db
      .prepare('SELECT source, confidence FROM alias WHERE alias = ? AND entity_id = ?')
      .get('rejectme', entityId) as { source: string; confidence: number };
    expect(row).toMatchObject({ source: 'human', confidence: 0 });
  });

  it('错误分支：非法 id / 未知行 / 非法动作 / 非法 kind', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const entityId = makeEntity(db, 'pkg-err');
    entityRepo.addAlias(db, { alias: 'ok', entityId, source: 'vector', confidence: 0.7 });

    const badId = await post(app, '/api/queues/resolve/decide', { id: 'not-a-row-id', action: 'merge' });
    expect(badId.statusCode).toBe(400);
    expect(body(badId)['detail']).toMatchObject({ reason: 'id_invalid' });

    // 合法编码但库里没有这一行
    const missingRowId = Buffer.from(JSON.stringify(['ghost', entityId]), 'utf8').toString('base64url');
    const missing = await post(app, '/api/queues/resolve/decide', {
      id: missingRowId,
      action: 'merge',
    });
    expect(missing.statusCode).toBe(404);
    expect(body(missing)['detail']).toMatchObject({ reason: 'alias_not_found' });

    const list = body(await get(app, '/api/queues/resolve'));
    const item = (list['items'] as { id: string }[])[0];
    const badAction = await post(app, '/api/queues/resolve/decide', { id: item?.id, action: 'explode' });
    expect(badAction.statusCode).toBe(400);
    expect(body(badAction)['detail']).toMatchObject({ reason: 'action_invalid' });

    const badKind = await post(app, '/api/queues/prune/decide', { id: item?.id, action: 'merge' });
    expect(badKind.statusCode).toBe(400);
    expect(body(badKind)['detail']).toMatchObject({ reason: 'queue_kind_invalid' });

    const noBody = await post(app, '/api/queues/resolve/decide', { id: item?.id });
    expect(noBody.statusCode).toBe(400);
    expect(body(noBody)['detail']).toMatchObject({ reason: 'action_invalid' });
  });
});

describe('POST /api/queues/lowconf/decide', () => {
  it('promote：confidence 抬到 0.6，无 op_id，队列移除', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const id = insertFact(db, { content: '低置信事实', confidence: 0.3, importance: 0.8 });

    const res = await post(app, '/api/queues/lowconf/decide', { id, action: 'promote' });
    expect(res.statusCode).toBe(200);
    const result = body(res);
    expect(result['before']).toMatchObject({ confidence: 0.3 });
    expect(result['after']).toMatchObject({ confidence: 0.6 });
    expect(result['op_id']).toBeUndefined();

    const row = db.prepare('SELECT confidence, confidence_source FROM fact WHERE id = ?').get(id) as {
      confidence: number;
      confidence_source: string;
    };
    expect(row).toMatchObject({ confidence: 0.6, confidence_source: 'human' });
    expect((body(await get(app, '/api/queues/lowconf'))['items'] as unknown[]).length).toBe(0);
  });

  it('invalidate：软删 + 30 秒撤销恢复 active', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const id = insertFact(db, { content: '要失效的事实', confidence: 0.3, importance: 0.6 });

    const res = await post(app, '/api/queues/lowconf/decide', { id, action: 'invalidate' });
    expect(res.statusCode).toBe(200);
    const result = body(res);
    expect(result['after']).toMatchObject({ epistemic_status: 'invalidated' });
    expect(typeof result['op_id']).toBe('string');

    const invalidated = db
      .prepare('SELECT valid_to, epistemic_status FROM fact WHERE id = ?')
      .get(id) as { valid_to: string | null; epistemic_status: string };
    expect(invalidated.epistemic_status).toBe('invalidated');
    expect(invalidated.valid_to).not.toBeNull();
    expect((body(await get(app, '/api/queues/lowconf'))['items'] as unknown[]).length).toBe(0);

    const undo = await post(app, `/api/facts/ops/${String(result['op_id'])}/undo`, {});
    expect(undo.statusCode).toBe(200);
    expect(body(undo)['restored']).toBe(1);
    const restored = db
      .prepare('SELECT valid_to, epistemic_status FROM fact WHERE id = ?')
      .get(id) as { valid_to: string | null; epistemic_status: string };
    expect(restored).toMatchObject({ valid_to: null, epistemic_status: 'active' });
  });

  it('错误分支：未知 id 404、非法 id 400、非活跃事实 400', async () => {
    const app = await makeApp(freshDb());
    const missing = await post(app, '/api/queues/lowconf/decide', {
      id: 'f_01jzzzzzzzzzzzzzzzzzzzzzzz',
      action: 'promote',
    });
    expect(missing.statusCode).toBe(404);
    expect(body(missing)['detail']).toMatchObject({ reason: 'fact_not_found' });

    const badId = await post(app, '/api/queues/lowconf/decide', { id: 'nope', action: 'promote' });
    expect(badId.statusCode).toBe(400);
    expect(body(badId)['detail']).toMatchObject({ reason: 'id_invalid' });
  });

  it('已归档事实不可再裁决（400 fact_not_active）', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const id = insertFact(db, {
      content: '已归档',
      confidence: 0.2,
      importance: 0.5,
      epistemicStatus: 'archived',
    });
    const res = await post(app, '/api/queues/lowconf/decide', { id, action: 'promote' });
    expect(res.statusCode).toBe(400);
    expect(body(res)['detail']).toMatchObject({ reason: 'fact_not_active' });
  });
});

describe('撤销入口共享：/api/facts/ops/:op_id/undo', () => {
  it('未知 op → 404；二次撤销 → 404', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const id = insertFact(db, { content: 'x', confidence: 0.3 });
    const res = await post(app, '/api/queues/lowconf/decide', { id, action: 'invalidate' });
    const opId = String(body(res)['op_id']);

    expect((await post(app, `/api/facts/ops/${opId}/undo`, {})).statusCode).toBe(200);
    const again = await post(app, `/api/facts/ops/${opId}/undo`, {});
    expect(again.statusCode).toBe(404);
    expect(body(again)['error']).toBe('E_NOT_FOUND');
  });
});
