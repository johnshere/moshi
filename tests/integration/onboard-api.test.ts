/**
 * 入驻服务面测试（Z-01C-h/i / 设计 §16.3~§16.6）。
 *
 * 真 Fastify 实例 + 真写盘，但**目标根换成临时目录**（`MOSHI_MAGPIE_PLUGIN_DIR`）：
 * 绝不能拿测试去改开发机上真实的 `~/.config/magpie/plugins`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpApp } from '../../src/app/http/server.js';
import { loadConfig } from '../../src/app/config.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { PLUGIN_DIR_ENV } from '../../src/app/onboard/install.js';

const TOKEN = 'test_token_onboard';

const appRef: { app?: Awaited<ReturnType<typeof buildHttpApp>>['app'] } = {};
const opened: Db[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-onboard-api-'));
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

async function makeApp(): Promise<string> {
  const home = tempDir();
  const pluginRoot = path.join(tempDir(), 'plugins');
  mkdirSync(pluginRoot, { recursive: true });
  const cfg = loadConfig({ home });
  const { app } = await buildHttpApp({
    db: freshDb(),
    cfg,
    token: TOKEN,
    home,
    env: { ...process.env, [PLUGIN_DIR_ENV]: pluginRoot },
    configFile: path.join(home, 'config.yaml'),
  });
  appRef.app = app;
  return pluginRoot;
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
      /* 忽略：Windows 上偶发 EBUSY */
    }
  }
});

describe('/hook/api/onboard 状态与鉴权', () => {
  it('没有 token 401（入驻端点不是后门）', async () => {
    await makeApp();
    const res = await app().inject({ method: 'GET', url: '/hook/api/onboard' });
    expect(res.statusCode).toBe(401);
  });

  it('初始：没弹过、没探测过、不该弹（探测不到就不打扰）', async () => {
    await makeApp();
    const body = (await call('GET', '/hook/api/onboard')).json() as Record<string, unknown>;
    expect(body['schema']).toBe('moshi-onboarding/1');
    expect(body['dialog_shown']).toBe(false);
    expect(body['detected']).toBeNull();
    expect(body['should_prompt']).toBe(false);
    expect(body['hosts']).toEqual(['claude-code', 'dsh', 'magpie']);
  });

  it('打开界面只记第一次时间；关掉弹窗后不再弹', async () => {
    await makeApp();
    const first = (await call('POST', '/hook/api/onboard', { open: true })).json() as Record<string, unknown>;
    expect(typeof first['first_open_at']).toBe('string');
    const opened = first['first_open_at'];

    const second = (await call('POST', '/hook/api/onboard', { open: true })).json() as Record<string, unknown>;
    expect(second['first_open_at']).toBe(opened);

    await call('POST', '/hook/api/onboard', { dialog_shown: true, dialog_closed_at: '2026-11-10T00:00:00.000Z' });
    const closed = (await call('GET', '/hook/api/onboard')).json() as Record<string, unknown>;
    expect(closed['dialog_shown']).toBe(true);
    expect(closed['dialog_closed_at']).toBe('2026-11-10T00:00:00.000Z');
    expect(closed['should_prompt']).toBe(false);
  });
});

describe('/hook/api/detect 三路探测', () => {
  it('探测落盘、再读就有；重复调用走缓存，refresh=1 强制重探', async () => {
    await makeApp();
    const first = (await call('POST', '/hook/api/detect')).json() as Record<string, unknown>;
    expect(first['cached']).toBe(false);
    const detected = first['detected'] as { at: string; hosts: Record<string, unknown> };
    expect(typeof detected.at).toBe('string');

    const cached = (await call('POST', '/hook/api/detect')).json() as Record<string, unknown>;
    expect(cached['cached']).toBe(true);

    const forced = (await call('POST', '/hook/api/detect?refresh=1')).json() as Record<string, unknown>;
    expect(forced['cached']).toBe(false);

    const state = (await call('GET', '/hook/api/onboard')).json() as Record<string, unknown>;
    expect(state['detected']).not.toBeNull();
  });

  it('该不该弹窗 = 没弹过 且 探测到至少一个宿主', async () => {
    await makeApp();
    const res = (await call('POST', '/hook/api/detect')).json() as {
      detected: { hosts: Record<string, { hit: boolean }> };
    };
    const hit = Object.values(res.detected.hosts).some((host) => host.hit);
    const state = (await call('GET', '/hook/api/onboard')).json() as Record<string, unknown>;
    expect(state['should_prompt']).toBe(hit);
  });
});

describe('/hook/api/install 安装计划与执行', () => {
  it('计划：六个条目（3 客户端 × 插件/MCP），只有 magpie+hook 可装', async () => {
    const pluginRoot = await makeApp();
    const body = (await call('GET', '/hook/api/install/plan')).json() as {
      plans: {
        host: string;
        kind: string;
        supported: boolean;
        reason: string | null;
        root: string | null;
        steps: { action: string; path: string; note?: { code: string } }[];
        risk: string | null;
      }[];
      keys: { host: string; kind: string; key: string }[];
    };
    expect(body.plans.map((plan) => `${plan.host}:${plan.kind}`)).toEqual([
      'magpie:hook',
      'claude-code:hook',
      'dsh:hook',
      'magpie:mcp',
      'claude-code:mcp',
      'dsh:mcp',
    ]);
    const magpieHook = body.plans[0];
    expect(magpieHook?.supported).toBe(true);
    expect(magpieHook?.root).toBe(pluginRoot);
    expect(magpieHook?.steps.length).toBe(5);
    expect(body.plans.filter((plan) => plan.supported).length).toBe(1);
    // I-70 / D-187：响应只带码值 + 数据，文案在界面词典
    expect(body).not.toHaveProperty('manual');
    expect(magpieHook?.steps.map((step) => step.action)).toEqual(['add', 'add', 'add', 'add', 'add']);
    expect(magpieHook?.steps[0]?.note).toMatchObject({ code: 'from_package' });
    expect(magpieHook?.steps[4]?.note).toMatchObject({ code: 'registry_add' });
    expect(magpieHook?.risk).toBe('reload_plugin_host');
    const reasonOf = (host: string, kind: string): string | null =>
      body.plans.find((plan) => plan.host === host && plan.kind === kind)?.reason ?? null;
    expect(reasonOf('claude-code', 'hook')).toBe('hook_emit_missing');
    expect(reasonOf('dsh', 'hook')).toBe('host_plugin_missing');
    expect(reasonOf('magpie', 'mcp')).toBe('mcp_not_implemented');
    expect(body.keys.find((item) => item.host === 'magpie' && item.kind === 'hook')?.key).toBe('magpie-hook');
  });

  it('不带 confirm 一个字节都不写（确认弹窗必须有实际作用）', async () => {
    const pluginRoot = await makeApp();
    const registry = path.join(path.dirname(pluginRoot), 'plugins.json');
    const body = (await call('POST', '/hook/api/install', { host: 'magpie', kind: 'hook' })).json() as Record<
      string,
      unknown
    >;
    expect(body['ok']).toBe(false);
    expect(body['written']).toEqual([]);
    expect(existsSync(path.join(pluginRoot, 'node_modules'))).toBe(false);
    expect(existsSync(registry)).toBe(false);
  });

  it('confirm 后真装：文件到位、注册表有 path spec、状态可读；再卸载能清干净', async () => {
    const pluginRoot = await makeApp();
    const registry = path.join(path.dirname(pluginRoot), 'plugins.json');
    writeFileSync(
      registry,
      JSON.stringify({ plugins: [{ spec: '@magpie-community/other@latest' }] }),
    );

    const install = (await call('POST', '/hook/api/install', { host: 'magpie', kind: 'hook', confirm: true })).json() as {
      ok: boolean;
      written: string[];
    };
    expect(install.ok).toBe(true);
    expect(install.written.length).toBe(5);
    expect(existsSync(path.join(pluginRoot, 'node_modules', 'moshi', 'hook.cjs'))).toBe(true);
    const spec = JSON.parse(readFileSync(registry, 'utf8')) as {
      plugins: { spec: string }[];
    };
    expect(spec.plugins.some((item) => item.spec === path.resolve(path.join(pluginRoot, 'node_modules', 'moshi')))).toBe(true);
    // 别人的插件不能被顶掉
    expect(spec.plugins.some((item) => item.spec === '@magpie-community/other@latest')).toBe(true);

    const state = (await call('GET', '/hook/api/onboard')).json() as {
      installs: Record<string, { state: string; version: string | null }>;
    };
    expect(state.installs['magpie-hook']?.state).toBe('installed');

    const uninstall = (await call('POST', '/hook/api/uninstall', { host: 'magpie', kind: 'hook' })).json() as {
      ok: boolean;
    };
    expect(uninstall.ok).toBe(true);
    expect(existsSync(path.join(pluginRoot, 'node_modules', 'moshi', 'hook.cjs'))).toBe(false);
    const after = (await call('GET', '/hook/api/onboard')).json() as {
      installs: Record<string, { state: string }>;
    };
    expect(after.installs['magpie-hook']?.state).toBe('absent');
  });

  it('本轮只允许 magpie+hook：其它组合 400（MCP 只显示不处理）', async () => {
    await makeApp();
    for (const body of [
      { host: 'claude-code', kind: 'hook' },
      { host: 'magpie', kind: 'mcp' },
      { host: 'dsh', kind: 'mcp' },
    ]) {
      const res = await call('POST', '/hook/api/install', body);
      expect(res.statusCode).toBe(400);
      expect((res.json() as Record<string, unknown>)['error']).toBe('E_INPUT');
    }
  });
});
