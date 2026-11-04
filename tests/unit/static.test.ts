/**
 * `/ui/graph` 静态托管测试（P2-02）。
 *
 * 三件事必须钉住：
 * 1. `/ui`、`/ui/` 302 到 `/ui/graph`（P2-19-A 起老单文件 UI 不再由 HTTP 提供）；
 * 2. 五个一级页面的入口/深链都回 `index.html`（SPA fallback），否则刷新 404；
 * 3. 路径穿越不能读到 dist 外面的文件。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';

const dirs: string[] = [];
const opened: Db[] = [];

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

function tempDir(prefix = 'moshi-static-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const TOKEN = 'static_test_token';

/** 造一棵假的 dist 树，外加一个 dist 之外的秘密文件 */
function makeDist(): { dist: string; secret: string } {
  const root = tempDir();
  const dist = path.join(root, 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(
    path.join(dist, 'index.html'),
    `<!doctype html><html><body><script>window.__MOSHI_TOKEN__ = window.__MOSHI_TOKEN__ || '';</script></body></html>`,
    'utf8',
  );
  writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'console.log("graph");', 'utf8');
  writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>', 'utf8');
  const secret = path.join(root, 'secret.txt');
  writeFileSync(secret, 'TOP_SECRET', 'utf8');
  return { dist, secret };
}

async function makeApp(dist: string) {
  const home = tempDir('moshi-static-home-');
  const { db } = openDb({ file: path.join(home, 'moshi.db') });
  migrate(db, { backupsDir: path.join(home, 'backups') });
  opened.push(db);
  const cfg = loadConfig({ home });
  const { app } = await buildHttpApp({ db, cfg, token: TOKEN, uiDistDir: dist });
  return app;
}

describe('/ui/graph 托管', () => {
  it('入口回 index.html 并注入 token', async () => {
    const { dist } = makeDist();
    const app = await makeApp(dist);

    for (const url of ['/ui/graph', '/ui/graph/']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain(`window.__MOSHI_TOKEN__ = '${TOKEN}'`);
      expect(res.body).not.toContain("window.__MOSHI_TOKEN__ || ''");
    }
  });

  it('前端子路由走 SPA fallback（深链刷新不 404）', async () => {
    const { dist } = makeDist();
    const app = await makeApp(dist);
    const res = await app.inject({ method: 'GET', url: '/ui/graph/some/deep/link' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('__MOSHI_TOKEN__');
  });

  it('assets/ 下带 hash 的产物长缓存，其余 no-cache', async () => {
    const { dist } = makeDist();
    const app = await makeApp(dist);

    const js = await app.inject({ method: 'GET', url: '/ui/graph/assets/index-abc.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cache-control']).toContain('immutable');
    expect(js.body).toBe('console.log("graph");');

    const svg = await app.inject({ method: 'GET', url: '/ui/graph/favicon.svg' });
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.headers['cache-control']).toBe('no-cache');
  });

  it('路径穿越读不到 dist 外面的文件', async () => {
    const { dist } = makeDist();
    const app = await makeApp(dist);
    for (const url of [
      '/ui/graph/%2e%2e%2fsecret.txt',
      '/ui/graph/..%2fsecret.txt',
      '/ui/graph/%2e%2e/%2e%2e/secret.txt',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain('TOP_SECRET');
    }
  });

  it('产物缺失时回 503，而不是抛异常', async () => {
    const empty = tempDir('moshi-static-empty-');
    const app = await makeApp(path.join(empty, 'nope'));
    const res = await app.inject({ method: 'GET', url: '/ui/graph' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('E_UI_NOT_BUILT');
  });

  it('/ui 与 /ui/ 302 到 /ui/graph，并保留 query', async () => {
    const { dist } = makeDist();
    const app = await makeApp(dist);
    for (const url of ['/ui', '/ui/']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/ui/graph');
    }
    const withToken = await app.inject({ method: 'GET', url: '/ui?token=t0k' });
    expect(withToken.statusCode).toBe(302);
    expect(withToken.headers['location']).toBe('/ui/graph?token=t0k');
  });

  it('五个一级页面入口都回 index.html 并注入 token（P2-19-A）', async () => {
    const { dist } = makeDist();
    const app = await makeApp(dist);
    for (const page of ['graph', 'memories', 'inbox', 'archive', 'settings']) {
      for (const url of [`/ui/${page}`, `/ui/${page}/`, `/ui/${page}/deep/link`]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.body).toContain(`window.__MOSHI_TOKEN__ = '${TOKEN}'`);
      }
    }
  });
});

describe('/ui/inbox 托管（P2-07）', () => {
  it('入口与深链都回同一份 index.html 并注入 token', async () => {
    const { dist } = makeDist();
    const app = await makeApp(dist);

    for (const url of ['/ui/inbox', '/ui/inbox/', '/ui/inbox/deep/link']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain(`window.__MOSHI_TOKEN__ = '${TOKEN}'`);
      expect(res.body).not.toContain("window.__MOSHI_TOKEN__ || ''");
    }
  });

  it('产物缺失时 /ui/inbox 也回 503 E_UI_NOT_BUILT', async () => {
    const empty = tempDir('moshi-static-empty-');
    const app = await makeApp(path.join(empty, 'nope'));
    const res = await app.inject({ method: 'GET', url: '/ui/inbox' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('E_UI_NOT_BUILT');
  });
});
