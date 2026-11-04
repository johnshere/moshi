/**
 * `GET /api/search` 契约单测（P2-19A-02，moshi-search/1）。
 *
 * 覆盖：实体（canonical_name / alias 子串、活跃事实数排序、合并 loser 排除）、
 * 事实（FTS5 bm25、200 码点截断）、参数校验（空 q / 非法 limit / 数组入参）、
 * LIKE 转义（% 与 _ 按字面量）、稳定排序、空结果、默认/上限 limit。
 * 路由用独立 Fastify 实例注册，不走 buildHttpApp（server.ts 归 Lead 接线）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { searchRoutes, SEARCH_SCHEMA } from '../../src/app/http/routes/search.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import { insertFact, makeEntity } from '../fixtures/factories.js';

const opened: Db[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-search-api-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

interface SearchPayload {
  schema: string;
  q: string;
  limit: number;
  entities: {
    entity_id: string;
    canonical_name: string;
    etype: string;
    fact_count: number;
    score: number;
  }[];
  facts: {
    fact_id: string;
    content: string;
    canonical_key: string;
    importance: number;
    confidence: number;
    score: number;
  }[];
  took_ms: number;
}

async function freshApp(): Promise<{ db: Db; app: FastifyInstance }> {
  const db = freshDb();
  const app = Fastify({ logger: false });
  await app.register(searchRoutes, { prefix: '/api/search', db });
  await app.ready();
  apps.push(app);
  return { db, app };
}

function bodyOf(res: { payload: string }): SearchPayload {
  return JSON.parse(res.payload) as SearchPayload;
}

function makeSubject(entityId: string, name = 'subject'): { entity_id: string; name: string } {
  return { entity_id: entityId, name };
}

describe('GET /api/search 实体命中', () => {
  it('canonical_name 子串命中，按活跃事实数降序（归档不计入）', async () => {
    const { db, app } = await freshApp();
    const alpha = makeEntity(db, 'alpha-service', 'service');
    const beta = makeEntity(db, 'beta-service', 'service');
    insertFact(db, { subject: makeSubject(alpha, 'alpha-service') });
    insertFact(db, { subject: makeSubject(alpha, 'alpha-service'), predicate: 'owner' });
    // 归档事实不算活跃，fact_count 不涨
    insertFact(db, {
      subject: makeSubject(alpha, 'alpha-service'),
      predicate: 'old',
      epistemicStatus: 'archived',
    });
    insertFact(db, { subject: makeSubject(beta, 'beta-service') });
    syncMissingFts(db);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=alpha-service' });
    expect(res.statusCode).toBe(200);
    const payload = bodyOf(res);
    expect(payload.schema).toBe(SEARCH_SCHEMA);
    expect(payload.q).toBe('alpha-service');
    expect(payload.limit).toBe(10);
    expect(payload.entities.map((e) => e.canonical_name)).toEqual(['alpha-service']);
    expect(payload.entities[0]?.fact_count).toBe(2);
    expect(payload.entities[0]?.score).toBe(2);
    expect(payload.entities[0]?.etype).toBe('service');
    expect(typeof payload.took_ms).toBe('number');
    expect(payload.took_ms).toBeGreaterThanOrEqual(0);
  });

  it('别名命中也能返回实体（canonical_name 不含查询串）', async () => {
    const { db, app } = await freshApp();
    const gamma = makeEntity(db, 'gamma-service', 'service');
    entityRepo.addAlias(db, { alias: 'g-svc', entityId: gamma, source: 'rule' });

    const res = await app.inject({ method: 'GET', url: '/api/search?q=g-svc' });
    const payload = bodyOf(res);
    expect(payload.entities.map((e) => e.entity_id)).toEqual([gamma]);
  });

  it('合并 loser（merged_into 非空）不出现在结果里', async () => {
    const { db, app } = await freshApp();
    const winner = makeEntity(db, 'winner-token', 'pkg');
    const loser = makeEntity(db, 'merged-token', 'pkg');
    entityRepo.markMerged(db, loser, winner);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=merged-token' });
    expect(bodyOf(res).entities).toEqual([]);
  });

  it('LIKE 通配符按字面量匹配：% 与 _ 不放大命中', async () => {
    const { db, app } = await freshApp();
    makeEntity(db, 'pct%name', 'concept');
    makeEntity(db, 'pctXname', 'concept');
    makeEntity(db, 'a_b', 'concept');
    makeEntity(db, 'aXb', 'concept');

    const pct = bodyOf(await app.inject({ method: 'GET', url: '/api/search?q=%25' }));
    expect(pct.entities.map((e) => e.canonical_name)).toEqual(['pct%name']);

    const underscore = bodyOf(await app.inject({ method: 'GET', url: '/api/search?q=a_b' }));
    expect(underscore.entities.map((e) => e.canonical_name)).toEqual(['a_b']);
  });

  it('同为 0 条活跃事实时按 entity id 升序，两次调用逐行一致', async () => {
    const { db, app } = await freshApp();
    const idA = makeEntity(db, 'tie-key-aa', 'concept');
    const idB = makeEntity(db, 'tie-key-bb', 'concept');
    const expected = [idA, idB].sort();

    const first = bodyOf(await app.inject({ method: 'GET', url: '/api/search?q=tie-key' }));
    const second = bodyOf(await app.inject({ method: 'GET', url: '/api/search?q=tie-key' }));
    expect(first.entities.map((e) => e.entity_id)).toEqual(expected);
    // took_ms 是耗时，天然会变；只对逐行数据做深度比较（契约要求两次调用逐行一致）
    expect({ ...second, took_ms: 0 }).toEqual({ ...first, took_ms: 0 });
  });
});

describe('GET /api/search 事实命中', () => {
  it('FTS5 命中事实并返回 content/canonical_key/importance/confidence/score', async () => {
    const { db, app } = await freshApp();
    const ent = makeEntity(db, 'delta-service', 'service');
    const factId = insertFact(db, {
      content: 'delta service version = 22.0.0',
      importance: 0.7,
      confidence: 0.8,
      subject: makeSubject(ent, 'delta-service'),
    });
    syncMissingFts(db);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=delta' });
    const payload = bodyOf(res);
    expect(payload.facts).toHaveLength(1);
    const hit = payload.facts[0];
    expect(hit?.fact_id).toBe(factId);
    expect(hit?.content).toBe('delta service version = 22.0.0');
    expect(hit?.importance).toBe(0.7);
    expect(hit?.confidence).toBe(0.8);
    expect(hit?.canonical_key.startsWith('ck1:')).toBe(true);
    // score 已转成「越大越相关」（bm25 原始值为负）
    expect(typeof hit?.score).toBe('number');
    expect(hit?.score).toBeGreaterThan(0);
  });

  it('content 截断到 200 码点（emoji 不被切坏）', async () => {
    const { db, app } = await freshApp();
    const ent = makeEntity(db, 'epsilon-service', 'service');
    const longContent = `epsilon ${'x'.repeat(300)}`;
    insertFact(db, { content: longContent, subject: makeSubject(ent, 'epsilon-service') });
    syncMissingFts(db);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=epsilon' });
    const hit = bodyOf(res).facts[0];
    expect(hit).toBeDefined();
    expect(Array.from(hit?.content ?? '')).toHaveLength(200);
    expect(longContent.startsWith(hit?.content ?? '')).toBe(true);
  });

  it('事实命中同样受 limit 限制（默认 10）', async () => {
    const { db, app } = await freshApp();
    for (let i = 0; i < 12; i += 1) {
      insertFact(db, { id: `fact_common_${String(i).padStart(2, '0')}`, content: `common token ${i}` });
    }
    syncMissingFts(db);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=common' });
    const payload = bodyOf(res);
    expect(payload.limit).toBe(10);
    expect(payload.facts).toHaveLength(10);
  });
});

describe('GET /api/search 参数校验', () => {
  it('q 为空 / 纯空白 / 数组入参 → 400 E_INPUT', async () => {
    const { app } = await freshApp();
    for (const url of ['/api/search', '/api/search?q=', '/api/search?q=%20%20', '/api/search?q=a&q=b']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.payload) as { error: string }).error).toBe('E_INPUT');
    }
  });

  it('limit 非法（abc / 0 / -1 / 数组）→ 400，超上限夹到 50', async () => {
    const { app } = await freshApp();
    for (const limit of ['abc', '0', '-1', '1.9', '']) {
      const res = await app.inject({ method: 'GET', url: `/api/search?q=alpha&limit=${limit}` });
      expect(res.statusCode, `limit=${limit}`).toBe(400);
    }
    const array = await app.inject({ method: 'GET', url: '/api/search?q=alpha&limit=1&limit=2' });
    expect(array.statusCode).toBe(400);

    const clamped = bodyOf(await app.inject({ method: 'GET', url: '/api/search?q=alpha&limit=999' }));
    expect(clamped.limit).toBe(50);
  });
});

describe('GET /api/search 空结果', () => {
  it('未命中返回 200 + 空数组（不是 404）', async () => {
    const { db, app } = await freshApp();
    makeEntity(db, 'zeta-service', 'service');
    syncMissingFts(db);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=nothing-matches-this' });
    expect(res.statusCode).toBe(200);
    const payload = bodyOf(res);
    expect(payload.schema).toBe(SEARCH_SCHEMA);
    expect(payload.entities).toEqual([]);
    expect(payload.facts).toEqual([]);
    expect(payload.limit).toBe(10);
  });
});
