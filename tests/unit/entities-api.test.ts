/**
 * `/api/entities` 路由契约测试（P2-19A-09）。
 *
 * 覆盖：列表（含归并后计数）→ 预览 → 合并的完整链路，以及同 id / etype 不符 /
 * 不存在 / 已合并 / 非法 body 的错误口径。lead 在 server.ts 以
 * `prefix:'/api/entities'` 注册本路由，这里用同样的前缀做 inject。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import { entitiesRoutes } from '../../src/app/http/routes/entities.js';
import { insertFact, makeEntity } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of opened.splice(0)) closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-entities-api-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

async function makeApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(entitiesRoutes, { prefix: '/api/entities', db });
  apps.push(app);
  return app;
}

function seed(db: Db): { fromId: string; toId: string } {
  const fromId = makeEntity(db, 'node', 'pkg');
  const toId = makeEntity(db, 'nodejs', 'pkg');
  for (const [entityId, name, value] of [
    [fromId, 'node', '22.0.0'],
    [toId, 'nodejs', '22.0.0'],
  ] as const) {
    insertFact(db, {
      subject: { entity_id: entityId, name },
      predicate: 'version',
      value,
      content: `${name} version = ${String(value)}`,
    });
  }
  insertFact(db, {
    subject: { entity_id: fromId, name: 'node' },
    predicate: 'port',
    value: 8080,
    content: 'node port = 8080',
  });
  insertFact(db, {
    subject: { entity_id: toId, name: 'nodejs' },
    predicate: 'runtime',
    value: 'v8',
    content: 'nodejs runtime = v8',
  });
  entityRepo.addAlias(db, { alias: 'node-bin', entityId: fromId, source: 'rule' });
  return { fromId, toId };
}

describe('GET /api/entities', () => {
  it('返回实体列表，q 过滤并满足 limit 校验', async () => {
    const db = freshDb();
    seed(db);
    const app = await makeApp(db);

    const res = await app.inject({ method: 'GET', url: '/api/entities?q=node&limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { entity_id: string; fact_count: number }[] };
    expect(body.items.length).toBe(2);
    expect(body.items[0]?.fact_count).toBe(2);

    const none = await app.inject({ method: 'GET', url: '/api/entities?q=zzz' });
    expect((none.json() as { items: unknown[] }).items).toEqual([]);

    const bad = await app.inject({ method: 'GET', url: '/api/entities?limit=0' });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { detail: { reason: string } }).detail.reason).toBe('limit_invalid');

    const dbl = await app.inject({ method: 'GET', url: '/api/entities?q=a&q=b' });
    expect(dbl.statusCode).toBe(400);
    expect((dbl.json() as { detail: { reason: string } }).detail.reason).toBe('q_invalid');
  });
});

describe('POST /api/entities/merge/preview', () => {
  it('返回冲突、移动计数与可合并结论', async () => {
    const db = freshDb();
    const { fromId, toId } = seed(db);
    const app = await makeApp(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/entities/merge/preview',
      payload: { from: fromId, to: toId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      can_merge: boolean;
      will_move: { facts: number; aliases: number };
      conflicts: unknown[];
      from: { fact_count: number };
    };
    expect(body.can_merge).toBe(true);
    expect(body.will_move).toEqual({ facts: 2, edges: 0, aliases: 1 });
    expect(body.from.fact_count).toBe(2);
    expect(body.conflicts).toEqual([]);
  });

  it('同 id / etype 不符 / 不存在分别 400/400/404', async () => {
    const db = freshDb();
    const { fromId, toId } = seed(db);
    const app = await makeApp(db);

    const same = await app.inject({
      method: 'POST',
      url: '/api/entities/merge/preview',
      payload: { from: fromId, to: fromId },
    });
    expect(same.statusCode).toBe(400);
    expect((same.json() as { detail: { reason: string } }).detail.reason).toBe('same_entity');

    const otherType = makeEntity(db, 'python', 'service');
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/entities/merge/preview',
      payload: { from: fromId, to: otherType },
    });
    expect(mismatch.statusCode).toBe(400);
    expect((mismatch.json() as { detail: { reason: string } }).detail.reason).toBe(
      'etype_mismatch',
    );

    const missing = await app.inject({
      method: 'POST',
      url: '/api/entities/merge/preview',
      payload: { from: fromId, to: 'entity-nope' },
    });
    expect(missing.statusCode).toBe(404);
    const detail = (missing.json() as { detail: { reason: string; which: string } }).detail;
    expect(detail.reason).toBe('entity_not_found');
    expect(detail.which).toBe('to');

    const badBody = await app.inject({
      method: 'POST',
      url: '/api/entities/merge/preview',
      payload: { from: fromId },
    });
    expect(badBody.statusCode).toBe(400);
    expect((badBody.json() as { detail: { reason: string } }).detail.reason).toBe('to_invalid');
    expect(toId).toBeTruthy();
  });
});

describe('POST /api/entities/merge', () => {
  it('执行合并，列表按根实体汇总事实数', async () => {
    const db = freshDb();
    const { fromId, toId } = seed(db);
    const app = await makeApp(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/entities/merge',
      payload: { from: fromId, to: toId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      moved_facts: number;
      deduped_facts: number;
      undoable: boolean;
      undo_reason: string;
    };
    expect(body.ok).toBe(true);
    expect(body.moved_facts).toBe(1);
    expect(body.deduped_facts).toBe(1);
    expect(body.undoable).toBe(false);
    expect(body.undo_reason).toBe('entity_merge_not_snapshotted');

    const list = await app.inject({ method: 'GET', url: '/api/entities?q=node' });
    const items = (list.json() as { items: { entity_id: string; fact_count: number }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.entity_id).toBe(toId);
    // version（winner 1 条）+ runtime → 重复的 loser 行已 valid_to 收口
    expect(items[0]?.fact_count).toBe(3);
  });

  it('重复合并幂等；已合并到别处 409', async () => {
    const db = freshDb();
    const { fromId, toId } = seed(db);
    const app = await makeApp(db);

    const first = await app.inject({
      method: 'POST',
      url: '/api/entities/merge',
      payload: { from: fromId, to: toId },
    });
    expect(first.statusCode).toBe(200);

    const again = await app.inject({
      method: 'POST',
      url: '/api/entities/merge',
      payload: { from: fromId, to: toId },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { moved_facts: number }).moved_facts).toBe(0);

    const third = makeEntity(db, 'node-other', 'pkg');
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/entities/merge',
      payload: { from: fromId, to: third },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { detail: { reason: string } }).detail.reason).toBe(
      'already_merged',
    );
  });
});
