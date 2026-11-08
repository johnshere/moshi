import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';

const TOKEN = 'control_test_token';
const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-control-'));
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

describe('POST /api/control/stop（V-03）', () => {
  it('有 onStop 时先回包再异步停止', async () => {
    const db = freshDb();
    const onStop = vi.fn();
    const { app } = await buildHttpApp({
      db,
      cfg: loadConfig({ home: tempDir() }),
      token: TOKEN,
      onStop,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/control/stop',
      headers: { 'x-moshi-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // setImmediate 在下一轮事件循环触发
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onStop).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('非 daemon 实例返回 501，无 token 401', async () => {
    const db = freshDb();
    const { app } = await buildHttpApp({
      db,
      cfg: loadConfig({ home: tempDir() }),
      token: TOKEN,
    });

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/control/stop',
      headers: { 'x-moshi-token': TOKEN },
    });
    expect(unsupported.statusCode).toBe(501);
    expect(unsupported.json()).toMatchObject({ error: 'E_NO_STOP' });

    const denied = await app.inject({ method: 'POST', url: '/api/control/stop' });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });
});
