/**
 * 钩子服务面测试（Z-01C / 设计 §8、§13 AC-1..AC-8 里的可离线部分）。
 *
 * 走真的 Fastify 实例（`app.inject`），DB 是临时文件——不 mock 管线，因为
 * "开没开开关、降级成什么、注入文本长什么样"这几件事正是端到端才看得出来。
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpApp } from '../../src/app/http/server.js';
import { loadConfig } from '../../src/app/config.js';
import { TraceSink } from '../../src/core/hook/traceSink.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { HOOK_SCHEMA, MAGPIE_CAPS, type HookEnvelope } from '../../src/core/hook/protocol.js';

const TOKEN = 'test_token_hook';

const appRef: { app?: Awaited<ReturnType<typeof buildHttpApp>>['app'] } = {};
const dbRef: { db?: Db } = {};
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
  const db = freshDb();
  dbRef.db = db;
  const { app } = await buildHttpApp({
    db,
    cfg,
    token: TOKEN,
    uiDistDir: uiDist(home),
    home,
    configFile: path.join(home, 'config.yaml'),
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
  dbRef.db = undefined;
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


  it('只有宿主元数据的 user 消息：不检索、不注入（empty_query，清洗见 core/hook/clean）', async () => {
    await makeApp();
    const raw = [
      '<acp tokens="63" type="text" time="2026-11-10 16:12:43">m00694</acp>',
      'Time sampled while preparing turn 2, step 208: 2026-11-10T16:12:42+08:00[Asia/Shanghai]',
      'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.',
      'Elapsed since the preceding step context: 11m 21s.',
    ].join('\n');
    const res = await call('POST', '/hook/api/recall', envelope({ payload: { text: raw } }));
    expect(res.json().inject).toBe(false);
    expect(res.json().degraded).toContain('empty_query');
    const db = dbRef.db;
    if (db === undefined) throw new Error('db not built');
    // 空查询不进检索，也就不写 query_log
    const row = db.prepare('SELECT count(*) AS c FROM query_log').get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('检索用的 query 先清洗：ACP 标记不落 query_log', async () => {
    await makeApp();
    await call(
      'POST',
      '/hook/api/recall',
      envelope({ payload: { text: '<acp tokens="1" type="text">m00001</acp>\n范围模型是什么' } }),
    );
    const db = dbRef.db;
    if (db === undefined) throw new Error('db not built');
    const row = db.prepare('SELECT query_text FROM query_log ORDER BY rowid DESC LIMIT 1').get() as {
      query_text: string;
    };
    expect(row.query_text).toBe('范围模型是什么');
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

  it('moshi_id 由 daemon 用宿主原始会话 id 回填（I-61：信封里送到的是原始 id）', async () => {
    await makeApp();
    const res = await call('POST', '/hook/api/recall', envelope());
    const body = res.json();
    // session.id='sess-1' → sessionMoshiId('sess-1')，与 packages/magpie-moshi/identity.cjs 同口径
    expect(body.identity.moshi_id).toBe('b56ed156bab52740c805785237405f43');
    // 原始会话 id 不出现在回包里
    expect(JSON.stringify(body)).not.toContain('sess-1');
  });

  it('daemon 有 sidecar 时钩子召回带语义通道（I-62：不再固定 degraded=["no_sidecar"]）', async () => {
    let encodes = 0;
    const fakeSidecar = {
      encode: async (texts: string[]) => {
        encodes += texts.length;
        return texts.map(() => new Array(512).fill(0));
      },
      score: async () => ({ scores: null, modelVersion: null, ms: 0, degraded: ['no_sidecar'] }),
      status: () => ({ state: 'ready' }),
    };
    await makeApp({ sidecar: fakeSidecar as never });
    const res = await call('POST', '/hook/api/recall', envelope());
    expect(res.statusCode).toBe(200);
    expect(encodes).toBeGreaterThan(0);
    expect(res.json().degraded).not.toContain('no_sidecar');
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

  it('落库前先清洗：只有宿主元数据的用户消息不落 episode', async () => {
    await makeApp();
    const raw = '<acp tokens="1" type="text">m00001</acp>\nTime sampled while preparing turn 1';
    const res = await call(
      'POST',
      '/hook/api/signal',
      envelope({ turn: 'user_prompt', payload: { text: raw } }),
    );
    expect(res.json().ok).toBe(true);
    expect(res.json().captured).toBe(false);
    expect(String(res.json().reason)).toContain('清洗后正文为空');
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

  it('落库的 session 是 daemon 回填的哈希，不是宿主原始 id（I-61）', async () => {
    const db = freshDb();
    await makeApp({ db });
    const res = await call('POST', '/hook/api/signal', envelope());
    expect(res.json().captured).toBe(true);
    const row = db.prepare('SELECT session FROM episode ORDER BY rowid DESC LIMIT 1').get() as {
      session: string;
    };
    expect(row.session).toBe('b56ed156bab52740c805785237405f43');
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

  it('召回带回执号，signal 回带后进同一条台账（Z-01C-e）', async () => {
    await makeApp();
    const recalled = await call('POST', '/hook/api/recall', envelope());
    const corr = recalled.json().corr_id as string;
    expect(corr).toMatch(/^[0-9a-f]{16}$/);
    await call(
      'POST',
      '/hook/api/signal',
      envelope({ turn: 'response', payload: { reply: '我答完了' }, corr }),
    );
    const items = (await call('GET', '/hook/api/trace?limit=5')).json().items as Record<string, unknown>[];
    const signalItem = items.find((item) => item['turn'] === 'response');
    expect(signalItem).toBeDefined();
    expect(signalItem?.['corr_id']).toBe(corr);
    expect(String(signalItem?.['reply_sha256'])).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(signalItem)).not.toContain('我答完了');
  });

  it('埋点带接入点与回执号（P2：caller/kind/plugin/status/字节数）', async () => {
    await makeApp();
    const recalled = await call('POST', '/hook/api/recall', envelope());
    const corr = recalled.json().corr_id as string;
    expect(corr).toMatch(/^[0-9a-f]{16}$/);
    const db = dbRef.db;
    if (db === undefined) throw new Error('db not built');
    const row = db
      .prepare(
        'SELECT caller_id, caller_kind, plugin_id, corr_id, status, in_bytes, out_bytes FROM query_log ORDER BY ts DESC LIMIT 1',
      )
      .get() as Record<string, unknown>;
    expect(row['caller_id']).toBe('gateway:magpie:moshi');
    expect(row['caller_kind']).toBe('gateway');
    expect(row['plugin_id']).toBe('moshi');
    expect(row['corr_id']).toBe(corr);
    expect(['ok', 'degraded']).toContain(row['status']);
    expect(Number(row['in_bytes'])).toBeGreaterThan(0);
    expect(Number(row['out_bytes'])).toBeGreaterThan(0);
  });

  it('summary 档落盘但不含正文；清盘要显式带 disk', async () => {
    const dir = tempDir();
    const sink = new TraceSink({ dir, level: 'summary', maxBytes: 4096, keepDays: 7 });
    await makeApp({ hookTraceSink: sink });
    await call('POST', '/hook/api/recall', envelope());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const name = readdirSync(dir).find((entry) => entry.startsWith('trace-'));
    expect(name).toBeDefined();
    const raw = readFileSync(path.join(dir, name as string), 'utf8').trim();
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record['corr_id']).toMatch(/^[0-9a-f]{16}$/);
    expect(raw).not.toContain('范围模型是什么');
    // 默认只清内存；显式 disk=1 才删文件
    expect((await call('POST', '/hook/api/trace')).json().disk_removed).toBe(0);
    expect(readdirSync(dir).some((entry) => entry.startsWith('trace-'))).toBe(true);
    expect((await call('POST', '/hook/api/trace?disk=1')).json().disk_removed).toBe(1);
    expect(readdirSync(dir).some((entry) => entry.startsWith('trace-'))).toBe(false);
  });
});
