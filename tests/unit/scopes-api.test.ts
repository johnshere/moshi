import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { insertFact } from '../fixtures/factories.js';

const TOKEN = 'scopes_test_token';
const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-scopes-'));
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

describe('GET /api/scopes（V-02）', () => {
  it('按 scope 分组计数，global 排最前；无 token 401', async () => {
    const db = freshDb();
    insertFact(db, { id: 'f1', content: '全局一', scope: 'global' });
    insertFact(db, { id: 'f2', content: '全局二', scope: 'global' });
    insertFact(db, { id: 'f3', content: '项目一', scope: 'project:c:/a' });
    const cfg = loadConfig({ home: tempDir() });
    const { app } = await buildHttpApp({ db, cfg, token: TOKEN });

    const res = await app.inject({
      method: 'GET',
      url: '/api/scopes',
      headers: { 'x-moshi-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      schema: 'moshi-scopes/1',
      items: [
        { scope: 'global', fact_count: 2 },
        { scope: 'project:c:/a', fact_count: 1 },
      ],
    });

    const denied = await app.inject({ method: 'GET', url: '/api/scopes' });
    expect(denied.statusCode).toBe(401);
  });
});
