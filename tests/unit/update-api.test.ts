import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig, type Config } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { installerPath } from '../../src/app/update/download.js';

const TOKEN = 'update_test_token';
const PAYLOAD = Buffer.from('fake-installer-bytes');
const ASSET_URL = 'https://github.com/johnshere/moshi/releases/download/v0.2.0/moshi-setup-0.2.0.exe';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-update-'));
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

function release(version: string): unknown {
  return {
    tag_name: `v${version}`,
    name: `v${version}`,
    body: '修复若干问题',
    html_url: `https://github.com/johnshere/moshi/releases/tag/v${version}`,
    published_at: '2026-11-08T00:00:00Z',
    assets: [
      { name: 'source.zip', size: 1, browser_download_url: ASSET_URL.replace('moshi-setup-0.2.0.exe', 'source.zip') },
      { name: `moshi-setup-${version}.exe`, size: PAYLOAD.length, browser_download_url: ASSET_URL },
    ],
  };
}

function fakeFetch(json: () => unknown = () => release('0.2.0')): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify(json()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === ASSET_URL) return new Response(PAYLOAD, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

async function setup(opts: {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  runInstaller?: (installer: string) => void;
}): Promise<{ app: Awaited<ReturnType<typeof buildHttpApp>>['app']; cfg: Config; onStop: ReturnType<typeof vi.fn> }> {
  const cfg = loadConfig({ home: tempDir() });
  const onStop = vi.fn();
  const { app } = await buildHttpApp({
    db: freshDb(),
    cfg,
    token: TOKEN,
    onStop,
    update: {
      currentVersion: opts.currentVersion ?? '0.1.0',
      fetchImpl: opts.fetchImpl ?? fakeFetch(),
      ...(opts.runInstaller === undefined ? {} : { runInstaller: opts.runInstaller }),
      now: () => new Date('2026-11-08T12:00:00Z'),
    },
  });
  return { app, cfg, onStop };
}

const headers = { 'x-moshi-token': TOKEN };

describe('GET /api/update（V-03B）', () => {
  it('有新版本时给出资产地址与大小', async () => {
    const { app } = await setup({});
    const res = await app.inject({ method: 'GET', url: '/api/update?force=1', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      schema: 'moshi-update/1',
      ok: true,
      current: '0.1.0',
      latest: '0.2.0',
      available: true,
      asset_url: ASSET_URL,
      asset_name: 'moshi-setup-0.2.0.exe',
      asset_size: PAYLOAD.length,
    });
    await app.close();
  });

  it('同版本时 available=false', async () => {
    const { app } = await setup({ currentVersion: '0.2.0' });
    const res = await app.inject({ method: 'GET', url: '/api/update', headers });
    expect(res.json()).toMatchObject({ ok: true, available: false, latest: '0.2.0' });
    await app.close();
  });

  it('联网失败折成 ok:false 而不是 5xx', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const { app } = await setup({ fetchImpl });
    const res = await app.inject({ method: 'GET', url: '/api/update?force=1', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, available: false, error: 'offline' });
    await app.close();
  });

  it('无 token 401', async () => {
    const { app } = await setup({});
    const res = await app.inject({ method: 'GET', url: '/api/update' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /api/update/download / install（V-03B）', () => {
  it('下载落盘到 <data_dir>/updates，install 拉起安装器并停 daemon', async () => {
    const runInstaller = vi.fn();
    const { app, cfg, onStop } = await setup({ runInstaller });

    const dl = await app.inject({ method: 'POST', url: '/api/update/download', headers });
    expect(dl.statusCode).toBe(200);
    expect(dl.json()).toMatchObject({ ok: true, version: '0.2.0', bytes: PAYLOAD.length });
    const file = installerPath(cfg, '0.2.0');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file)).toEqual(PAYLOAD);

    const inst = await app.inject({ method: 'POST', url: '/api/update/install', headers });
    expect(inst.statusCode).toBe(200);
    expect(inst.json()).toEqual({ ok: true, version: '0.2.0' });
    expect(runInstaller).toHaveBeenCalledWith(file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onStop).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('没有新版本时 download 返回 409', async () => {
    const { app } = await setup({ currentVersion: '0.2.0' });
    const res = await app.inject({ method: 'POST', url: '/api/update/download', headers });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'E_UPDATE' });
    await app.close();
  });

  it('未下载就 install 返回 409', async () => {
    const { app } = await setup({});
    const res = await app.inject({ method: 'POST', url: '/api/update/install', headers });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'E_UPDATE', message: '请先下载更新包' });
    await app.close();
  });

  it('下载大小与 release 记录不一致时 502', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify(release('0.2.0')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(Buffer.from('short'), { status: 200 });
    }) as unknown as typeof fetch;
    const { app } = await setup({ fetchImpl });
    const res = await app.inject({ method: 'POST', url: '/api/update/download', headers });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'E_UPDATE' });
    await app.close();
  });
});
