/**
 * 钩子服务面测试（Z-01C / 设计 §8、§13 AC-1..AC-8 里的可离线部分）。
 *
 * 走真的 Fastify 实例（`app.inject`），DB 是临时文件——不 mock 管线，因为
 * "开没开开关、降级成什么、注入文本长什么样"这几件事正是端到端才看得出来。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpApp } from '../../src/app/http/server.js';
import { loadConfig } from '../../src/app/config.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { HOOK_SCHEMA, MAGPIE_CAPS, type HookEnvelope } from '../../src/core/hook/protocol.js';

const TOKEN = 'test_token_hook';

const appRef: { app?: Awaited<ReturnType<typeof buildHttpApp>>['app'] } = {};
const opened: Db[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-hook-api-'));
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

function envelope(over: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    schema: HOOK_SCHEMA,
    host: 'magpie',
    turn: 'user_prompt',
    ts: '2026-11-10T00:00:00.000Z',
    identity: { moshi_id: 'a'.repeat(32), project_id: null, identity_source: 'unknown' },
    caps: MAGPIE_CAPS,
    budget: { deadlineMs: 800, phaseTimeoutMs: 1000 },
    session: { id: 'sess-1', source: 'magpie' },
    project: { cwd: null, identitySource: 'unknown' },
    payload: { text: '范围模型是什么' },
    ...over,
  };
}

/**
 * 造一个最小前端产物目录：`/ui/hook` 现在是 SPA 路由（Z-01C-g），服务端只回
 * `index.html` 并把令牌占位替换掉；React 侧再渲染接入页。
 *
 * 占位串与 `src/app/http/static.ts` 的 `TOKEN_PLACEHOLDER` 是同一条契约（那边没导出，
 * 这里重复一份并断言替换生效——比导出内部常量更稳）。
 */
function uiDist(home: string): string {
  const dir = path.join(home, 'ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script>window.__MOSHI_TOKEN__ = window.__MOSHI_TOKEN__ || \'\'</script></body></html>',
  );
  return dir;
}

async function makeApp(over: Record<string, unknown> = {}): Promise<void> {
  const home = tempDir();
  const cfg = loadConfig({ home });
  const { app } = await buildHttpApp({
    db: freshDb(),
    cfg,
    token: TOKEN,
    uiDistDir: uiDist(home),
    home,
    configFile: path.join(home, 'config.toml'),
    // 自建 `.moshi/project.yaml` 要落到临时工程目录里，得显式放行
    markerRoots: [tmpdir()],
    ...over,
  });
  appRef.app = app;
}

function app() {
  const a = appRef.app;
  if (a === undefined) throw new Error('app not built');
  return a;
}

function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app().inject({
    method,
    url,
    headers: { 'x-moshi-token': TOKEN },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

beforeEach(() => {
  appRef.app = undefined;
});

afterEach(async () => {
  if (appRef.app !== undefined) await appRef.app.close();
  appRef.app = undefined;
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略：Windows 上偶发 EBUSY，不影响断言 */
    }
  }
});

describe('/hook/api 鉴权', () => {
  it('没有 token 一律 401（hook.js 也是走同一个口径）', async () => {
    await makeApp();
    const res = await app().inject({ method: 'POST', url: '/hook/api/recall', payload: envelope() });
    expect(res.statusCode).toBe(401);
  });

  it('/ui/hook 的 HTML 壳不校验 token（浏览器直接打开，带不上请求头）', async () => {
    await makeApp();
    const res = await app().inject({ method: 'GET', url: '/ui/hook' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('<div id="root">');
    // 边界在 API：壳能拿，接口不能
    const api = await app().inject({ method: 'GET', url: '/hook/api/status' });
    expect(api.statusCode).toBe(401);
  });
});

describe('/hook/api/recall', () => {
  it('库里没有事实时如实不注入（empty + no_evidence），不是报错', async () => {
    await makeApp();
    const res = await call('POST', '/hook/api/recall', envelope());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.inject).toBe(false);
    expect(body.degraded).toContain('no_evidence');
  });

  it('信封字段不对也不 500，只回一个不注入并说明原因', async () => {
    await makeApp();
    const res = await call('POST', '/hook/api/recall', { schema: 'wrong' });
    expect(res.statusCode).toBe(200);
    expect(res.json().inject).toBe(false);
    expect(res.json().degraded[0]).toBe('invalid_envelope');
  });

  it('总开关关掉时一个字节都不注（skipped + disabled）', async () => {
    await makeApp();
    const patched = await call('POST', '/hook/api/config', { enabled: false });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().switches.enabled).toBe(false);
    const res = await call('POST', '/hook/api/recall', envelope());
    expect(res.json().inject).toBe(false);
    expect(res.json().degraded).toContain('disabled');
  });


  it('cwd 缺失 → unknown 档，且不拿 daemon 自己的 cwd 充数', async () => {
    await makeApp();
    const res = await call('POST', '/hook/api/identity', {});
    expect(res.json().project.identity_source).toBe('unknown');
    expect(res.json().project.project_id).toBeNull();
  });

  it('recall 带上真实 cwd：回的信封里工程身份和台账都跟着变', async () => {
    await makeApp();
    const proj = path.join(tempDir(), 'ledger-project');
    mkdirSync(proj, { recursive: true });
    const res = await call(
      'POST',
      '/hook/api/recall',
      envelope({ project: { cwd: proj, identitySource: 'vcs' } }),
    );
    const body = res.json();
    // 库里没事实 → 不注入，但身份已经算出来了（不会因为"没召回"就丢掉工程身份）
    expect(body.identity.project_id).toMatch(/^[0-9a-f]{32}$/);
    const trace = (await call('GET', '/hook/api/trace?limit=5')).json().items;
    expect(trace.length).toBe(1);
    expect(trace[0].identity_source).not.toBe('unknown');
  });
});

describe('/hook/api/signal', () => {
  it('落 episode，第二次同样的信号回 duplicate', async () => {
    await makeApp();
    const first = await call('POST', '/hook/api/signal', envelope());
    expect(first.json().captured).toBe(true);
    expect(first.json().duplicate).toBe(false);
    const second = await call('POST', '/hook/api/signal', envelope());
    expect(second.json().duplicate).toBe(true);
    expect(second.json().episode_id).toBe(first.json().episode_id);
  });

  it('输出记忆关掉时回复不落库，但 ok 仍 true（不是错误）', async () => {
    await makeApp();
    const res = await call(
      'POST',
      '/hook/api/signal',
      envelope({ turn: 'response', payload: { reply: '我答完了' } }),
    );
    expect(res.json().ok).toBe(true);
    expect(res.json().captured).toBe(false);
    expect(res.json().reason).toBe('capture_reply_disabled');
  });
});

describe('/hook/api/status 与 F8 连接态', () => {
  it('默认未连接，needs_connect=true（从没连过也要先提示）', async () => {
    await makeApp();
    const res = await call('GET', '/hook/api/status');
    expect(res.json().connected).toBe(false);
    expect(res.json().needs_connect).toBe(true);
    expect(res.json().switches.enabled).toBe(true);
  });

  it('断开后打开界面：仍显示未连接（不会因为打开界面自动连回去）', async () => {
    await makeApp();
    await call('POST', '/hook/api/config', { action: 'connect' });
    await call('POST', '/hook/api/config', { action: 'disconnect' });
    const page = await call('GET', '/ui/hook');
    expect(page.statusCode).toBe(200);
    // Z-01C-g：`/ui/hook` 改成 SPA 路由，遮罩由 React 按 `/status.needs_connect` 渲染，
    // 服务端只回壳；「有没有要求先连接」以 status 为准（下面两行）
    expect(page.payload).toContain('<div id="root">');
    expect(page.payload).not.toContain('连接 Magpie 才能使用');
    const status = (await call('GET', '/hook/api/status')).json();
    expect(status.connected).toBe(false);
    expect(status.needs_connect).toBe(true);
  });

  it('?from=magpie 打开界面 = 连接（这是唯一自动连接入口）', async () => {
    await makeApp();
    const page = await call('GET', '/ui/hook?from=magpie');
    expect(page.statusCode).toBe(200);
    // 连接语义留在服务端（onRequest 钩子），不靠前端脚本——所以壳里不会出现标记
    expect((await call('GET', '/hook/api/status')).json().connected).toBe(true);
  });

  it('caps 表里 magpie 只有两个时机（2/7，如实标 absent 的来源）', async () => {
    await makeApp();
    const res = await call('GET', '/hook/api/caps');
    expect(res.json().hosts.magpie.turns).toEqual(['user_prompt', 'response']);
  });
});

describe('/hook/api/trace', () => {
  it('召回会留台账条目（只记计数，不记正文）', async () => {
    await makeApp();
    await call('POST', '/hook/api/recall', envelope());
    const res = await call('GET', '/hook/api/trace?limit=5');
    const items = res.json().items;
    expect(items.length).toBe(1);
    expect(items[0].turn).toBe('user_prompt');
    // 台账里不能出现用户原话
    expect(JSON.stringify(items)).not.toContain('范围模型是什么');
  });
});
