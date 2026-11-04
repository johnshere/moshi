/**
 * 三队列游标分页（P2-19-A）：keyset 翻页不重不漏 + 非法游标 400。
 *
 * 覆盖：
 * - repo 层：三个 `list*Queue` 的 `cursor` 参数按各自排序键翻页（resolve: confidence DESC,
 *   alias ASC, entity_id ASC；lowconf: importance DESC, id ASC；prune: strength ASC, id ASC）；
 * - HTTP 层：`next_cursor` 串联、末页为 null、无 cursor 行为与旧版兼容（limit 默认 50/上限 200）、
 *   非法/数组 cursor 一律 400 `E_INPUT` reason=`cursor_invalid`。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import * as inboxRepo from '../../src/infra/sqlite/inboxRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact, makeEntity } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];
const TOKEN = 'test_token_p19a_queues';

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
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-queues-'));
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

function body(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

function seedResolveRows(db: Db): void {
  const confidences = [0.9, 0.8, 0.8, 0.7, 0.6];
  for (let i = 0; i < confidences.length; i += 1) {
    const entityId = makeEntity(db, `canonical-${String(i)}`);
    entityRepo.addAlias(db, {
      alias: `alias-${String(i)}`,
      entityId,
      source: 'vector',
      confidence: confidences[i] ?? 0.5,
    });
  }
}

function seedLowConfRows(db: Db): string[] {
  return [0.9, 0.8, 0.8, 0.7, 0.6].map((importance, i) =>
    insertFact(db, {
      content: `lowconf-${String(i)}`,
      confidence: 0.3,
      importance,
      value: `v${String(i)}`,
    }),
  );
}

function seedPruneRows(db: Db): string[] {
  return [0.05, 0.06, 0.07, 0.08, 0.09].map((strength, i) =>
    insertFact(db, { content: `prune-${String(i)}`, strength, value: `p${String(i)}` }),
  );
}

describe('repo：三队列 keyset 游标', () => {
  it('resolve 按 confidence DESC / alias ASC 翻页不重不漏', () => {
    const db = freshDb();
    seedResolveRows(db);
    const seen: string[] = [];
    let cursor: inboxRepo.ResolveCursor | undefined;
    for (;;) {
      const rows = inboxRepo.listResolveQueue(db, { limit: 2, cursor });
      seen.push(...rows.map((r) => r.alias));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = { confidence: last.confidence, alias: last.alias, entityId: last.entityId };
    }
    expect(seen).toEqual(['alias-0', 'alias-1', 'alias-2', 'alias-3', 'alias-4']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('lowconf 按 importance DESC / id ASC 翻页不重不漏', () => {
    const db = freshDb();
    const ids = seedLowConfRows(db);
    const seen: string[] = [];
    let cursor: inboxRepo.LowConfCursor | undefined;
    for (;;) {
      const rows = inboxRepo.listLowConfQueue(db, { limit: 2, cursor });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = { importance: last.importance, id: last.id };
    }
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('prune 按 strength ASC / id ASC 翻页不重不漏', () => {
    const db = freshDb();
    const ids = seedPruneRows(db);
    const seen: string[] = [];
    let cursor: inboxRepo.PruneCursor | undefined;
    for (;;) {
      const rows = inboxRepo.listPruneQueue(db, { limit: 2, cursor });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = { strength: last.strength, id: last.id };
    }
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});

describe('HTTP：next_cursor 串联与错误分支', () => {
  it('resolve 翻页：next_cursor 串联、末页 null、无重复', async () => {
    const db = freshDb();
    seedResolveRows(db);
    const app = await makeApp(db);
    const first = body(await app.inject({ method: 'GET', url: '/api/queues/resolve?limit=2', headers: auth }));
    expect((first['items'] as unknown[]).length).toBe(2);
    const cursor1 = first['next_cursor'];
    expect(typeof cursor1).toBe('string');

    const second = body(
      await app.inject({
        method: 'GET',
        url: `/api/queues/resolve?limit=2&cursor=${String(cursor1)}`,
        headers: auth,
      }),
    );
    const cursor2 = second['next_cursor'];
    const third = body(
      await app.inject({
        method: 'GET',
        url: `/api/queues/resolve?limit=2&cursor=${String(cursor2)}`,
        headers: auth,
      }),
    );
    expect((third['items'] as unknown[]).length).toBe(1);
    expect(third['next_cursor']).toBeNull();

    const aliases = [
      ...(first['items'] as { alias: string }[]).map((r) => r.alias),
      ...(second['items'] as { alias: string }[]).map((r) => r.alias),
      ...(third['items'] as { alias: string }[]).map((r) => r.alias),
    ];
    expect(aliases).toEqual(['alias-0', 'alias-1', 'alias-2', 'alias-3', 'alias-4']);
  });

  it('lowconf / prune 同样返回 next_cursor；prune 保留 thresholds', async () => {
    const db = freshDb();
    seedLowConfRows(db);
    seedPruneRows(db);
    const app = await makeApp(db);

    const low = body(await app.inject({ method: 'GET', url: '/api/queues/lowconf?limit=2', headers: auth }));
    expect(typeof low['next_cursor']).toBe('string');

    const prune = body(await app.inject({ method: 'GET', url: '/api/queues/prune?limit=2', headers: auth }));
    expect(typeof prune['next_cursor']).toBe('string');
    expect(prune['thresholds']).toEqual({ strength: 0.15, idle_days: 60 });
  });

  it('无 cursor 时行为与旧版一致（少量数据 next_cursor=null）', async () => {
    const db = freshDb();
    makeEntity(db, 'only');
    const app = await makeApp(db);
    const res = body(await app.inject({ method: 'GET', url: '/api/queues/resolve', headers: auth }));
    expect((res['items'] as unknown[]).length).toBe(0);
    expect(res['next_cursor']).toBeNull();
  });

  it('非法 cursor → 400 cursor_invalid；数组 cursor 也 400', async () => {
    const app = await makeApp(freshDb());
    const bad = await app.inject({ method: 'GET', url: '/api/queues/resolve?cursor=garbage', headers: auth });
    expect(bad.statusCode).toBe(400);
    expect(body(bad)['detail']).toMatchObject({ reason: 'cursor_invalid' });

    const array = await app.inject({
      method: 'GET',
      url: '/api/queues/lowconf?cursor=a&cursor=b',
      headers: auth,
    });
    expect(array.statusCode).toBe(400);
    expect(body(array)['detail']).toMatchObject({ reason: 'cursor_invalid' });

    // 形状合法 JSON / base64url 但字段类型不对
    const shape = Buffer.from(JSON.stringify({ confidence: 'high' }), 'utf8').toString('base64url');
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/queues/resolve?cursor=${shape}`,
      headers: auth,
    });
    expect(wrong.statusCode).toBe(400);
    expect(body(wrong)['detail']).toMatchObject({ reason: 'cursor_invalid' });
  });
});
