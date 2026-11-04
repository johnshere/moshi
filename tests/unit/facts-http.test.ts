/**
 * `GET /api/facts/:id?depth=1|2|3` 契约测试（P2-19A-13b / 详设 §4.3 L1345）。
 *
 * 钉住：
 * ① 默认 depth=1（只展开一跳依赖链），2/3 逐层放大；
 * ② 非 1..3（0/4/小数/文本/数组）→ 400 `depth_invalid`；
 * ③ 不存在的 id 仍 404，不受 depth 影响。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-facts-http-'));
  dirs.push(dir);
  return dir;
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

async function makeApp(db: Db): Promise<{ app: Awaited<ReturnType<typeof buildHttpApp>>['app']; h: Record<string, string> }> {
  const cfg = loadConfig({ home: tempDir() });
  const token = 'test_token_facts_depth';
  const { app } = await buildHttpApp({ db, cfg, token });
  return { app, h: { 'X-Moshi-Token': token } };
}

/** f1 → f2 → f3（f1 依赖 f2，f2 依赖 f3）；f0 依赖 f1（下游方向） */
function seedChain(db: Db): void {
  for (const id of ['f1', 'f2', 'f3', 'f0']) {
    insertFact(db, { id, content: `${id} 的内容`, value: id });
  }
  insertEdge(db, 'f1', 'f2');
  insertEdge(db, 'f2', 'f3');
  insertEdge(db, 'f0', 'f1');
}

type DetailBody = {
  id: string;
  depth: number;
  depends: { upstream: { id: string }[]; downstream: { id: string }[] };
};

describe('GET /api/facts/:id?depth', () => {
  it('默认 depth=1：只展开一跳', async () => {
    const db = freshDb();
    seedChain(db);
    const { app, h } = await makeApp(db);

    const res = await app.inject({ method: 'GET', url: '/api/facts/f1', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json<DetailBody>();
    expect(body.depth).toBe(1);
    expect(body.depends.upstream.map((d) => d.id)).toEqual(['f2']);
    expect(body.depends.downstream.map((d) => d.id)).toEqual(['f0']);
  });

  it('depth=2：依赖链放大到两跳', async () => {
    const db = freshDb();
    seedChain(db);
    const { app, h } = await makeApp(db);

    const res = await app.inject({ method: 'GET', url: '/api/facts/f1?depth=2', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json<DetailBody>();
    expect(body.depth).toBe(2);
    // 上游：f2（第 1 跳）→ f3（第 2 跳）
    expect(body.depends.upstream.map((d) => d.id)).toEqual(['f2', 'f3']);
    expect(body.depends.downstream.map((d) => d.id)).toEqual(['f0']);
  });

  it('depth=3 与 2 在短链上等价，且不越界', async () => {
    const db = freshDb();
    seedChain(db);
    const { app, h } = await makeApp(db);

    const res = await app.inject({ method: 'GET', url: '/api/facts/f1?depth=3', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json<DetailBody>();
    expect(body.depth).toBe(3);
    expect(body.depends.upstream.map((d) => d.id)).toEqual(['f2', 'f3']);
  });

  it('非法 depth：0/4/1.5/abc/数组 → 400 depth_invalid', async () => {
    const db = freshDb();
    seedChain(db);
    const { app, h } = await makeApp(db);

    for (const qs of ['depth=0', 'depth=4', 'depth=1.5', 'depth=abc', 'depth=1&depth=2']) {
      const res = await app.inject({ method: 'GET', url: `/api/facts/f1?${qs}`, headers: h });
      expect(res.statusCode, qs).toBe(400);
      const body = res.json<{ error: string; detail: { reason: string } }>();
      expect(body.error).toBe('E_INPUT');
      expect(body.detail.reason).toBe('depth_invalid');
    }
  });

  it('不存在的 id 带 depth 仍 404', async () => {
    const db = freshDb();
    const { app, h } = await makeApp(db);

    const res = await app.inject({ method: 'GET', url: '/api/facts/fact_nope?depth=2', headers: h });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('E_NOT_FOUND');
  });
});
