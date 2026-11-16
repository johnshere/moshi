/**
 * 历史会话导入 HTTP 面测试（POST /api/import、GET /api/import/status）。
 *
 * 子进程用**假 spawn**（EventEmitter）代替：这里要验的是「202 立即回包、
 * 状态机、409/400/鉴权」这些契约，不是真的跑一次导入。真子进程只在
 * `pnpm build` 后的 daemon 里存在，测试环境没有 dist。
 * 最后一条用例显式传 `spawn: null`，覆盖「拿不到 daemon 入口时的进程内降级」。
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpApp } from '../../src/app/http/server.js';
import { loadConfig } from '../../src/app/config.js';
import { createDefaultSpawn, type ImportChild, type ImportSpawn } from '../../src/app/http/routes/import.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';

const TOKEN = 'test_token_import';

/** 假子进程：只提供路由用到的 stdout/stderr 与 error/close 事件 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface Spawned {
  command: string;
  args: string[];
  child: FakeChild;
}

const appRef: { app?: Awaited<ReturnType<typeof buildHttpApp>>['app'] } = {};
const opened: Db[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-import-api-'));
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

/** `/ui` 壳目录：静态路由注册要求它存在（与 hook-api 测试同一做法） */
function uiDist(home: string): string {
  const dir = path.join(home, 'ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script>window.__MOSHI_TOKEN__ = window.__MOSHI_TOKEN__ || \'\'</script></body></html>',
  );
  return dir;
}

/** 假 spawn：记录最后一次调用，测试自己驱动事件 */
function fakeSpawn(): { spawn: ImportSpawn; last: () => Spawned } {
  let last: Spawned | null = null;
  return {
    spawn: (command, args) => {
      const child = new FakeChild();
      last = { command, args: [...args], child };
      return child as unknown as ImportChild;
    },
    last: () => {
      if (last === null) throw new Error('没有发生 spawn');
      return last;
    },
  };
}

async function makeApp(
  opts: { spawn?: ImportSpawn | null; configFile?: string } = {},
): Promise<void> {
  const home = tempDir();
  const cfg = loadConfig({ home });
  // 降级路径要确定性：不扫这台机器上真实的会话目录
  cfg.ingest.sources = [];
  const { app } = await buildHttpApp({
    db: freshDb(),
    cfg,
    token: TOKEN,
    uiDistDir: uiDist(home),
    home,
    configFile: opts.configFile ?? path.join(home, 'config.yaml'),
    ...(opts.spawn === undefined ? {} : { importSpawn: opts.spawn }),
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

async function status(): Promise<Record<string, unknown>> {
  const res = await call('GET', '/api/import/status');
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

/** 进程内降级没有进程退出事件，轮询到状态落定为止 */
async function waitIdle(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i += 1) {
    const st = await status();
    if (st['running'] === false) return st;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('导入 2s 内没有结束');
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

describe('POST /api/import', () => {
  it('202 立即回包 → running → 结果落定，子进程参数符合契约', async () => {
    const fake = fakeSpawn();
    await makeApp({ spawn: fake.spawn });

    const res = await call('POST', '/api/import', { since: '2026-01-01' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.since).toBe('2026-01-01T00:00:00.000Z');
    expect(typeof body.started_at).toBe('string');

    const spawned = fake.last();
    expect(spawned.command).toBe(process.execPath);
    // 契约：execPath + 入口脚本 + `import --since <iso> --json`
    expect(spawned.args).toEqual([
      process.argv[1],
      'import',
      '--since',
      '2026-01-01T00:00:00.000Z',
      '--json',
    ]);

    const running = await status();
    expect(running['running']).toBe(true);
    expect(running['since']).toBe('2026-01-01T00:00:00.000Z');
    expect(running['finished_at']).toBeNull();
    expect(running['exit_code']).toBeNull();

    spawned.child.stderr.emit('data', 'imported 10 turns, 20 facts\nimported 20 turns, 40 facts\n');
    spawned.child.stdout.emit(
      'data',
      `${JSON.stringify({
        ok: true,
        sessions: 2,
        turns: 20,
        facts: 40,
        refreshed: 1,
        quarantined: 0,
        skipped: 0,
        failed: 0,
        unavailable: [],
        promoted: 3,
        ms: 1234,
      })}\n`,
    );
    spawned.child.emit('close', 0);

    const done = await status();
    expect(done['running']).toBe(false);
    expect(done['exit_code']).toBe(0);
    expect(done['error']).toBeNull();
    expect(typeof done['finished_at']).toBe('string');
    expect(done['lines']).toEqual([
      'imported 10 turns, 20 facts',
      'imported 20 turns, 40 facts',
    ]);
    const result = done['result'] as Record<string, unknown>;
    expect(result['facts']).toBe(40);
    expect(result['promoted']).toBe(3);
  });

  it('默认 spawn 工厂让子进程继承 daemon 配置（MOSHI_CONFIG）且参数不变', async () => {
    const configFile = path.join(tempDir(), 'daemon-config.yaml');
    const captured: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    // 用假进程实现替掉 child_process.spawn：断言工厂构造出的 env/stdio，不真的起进程
    const spawnFn = createDefaultSpawn(configFile, (command, args, options) => {
      captured.push({ command, args: [...args], env: options.env });
      return new FakeChild() as unknown as ImportChild;
    });

    await makeApp({ spawn: spawnFn, configFile });
    const res = await call('POST', '/api/import', { since: '2026-01-01' });
    expect(res.statusCode).toBe(202);

    const spawned = captured[0];
    if (spawned === undefined) throw new Error('没有发生 spawn');
    expect(spawned.command).toBe(process.execPath);
    expect(spawned.args.slice(1)).toEqual([
      'import',
      '--since',
      '2026-01-01T00:00:00.000Z',
      '--json',
    ]);
    // 子进程无条件拿到 daemon 已解析的配置路径（客户不必知道启动时要加 --config）
    expect(spawned.env['MOSHI_CONFIG']).toBe(configFile);
    // 是「继承 process.env 再覆盖」而不是只带一个变量
    expect(Object.keys(spawned.env).length).toBeGreaterThan(1);
  });

  it('进度行只保留最近 50 条', async () => {
    const fake = fakeSpawn();
    await makeApp({ spawn: fake.spawn });
    await call('POST', '/api/import', { since: 'all' });
    const lines = Array.from({ length: 60 }, (_, i) => `line-${String(i)}`).join('\n');
    fake.last().child.stderr.emit('data', `${lines}\n`);
    const st = await status();
    const kept = st['lines'] as string[];
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe('line-10');
    expect(kept[49]).toBe('line-59');
  });

  it('子进程非 0 退出：结果照收，error 说明原因', async () => {
    const fake = fakeSpawn();
    await makeApp({ spawn: fake.spawn });
    await call('POST', '/api/import', { since: 'all' });
    fake.last().child.stderr.emit('data', '跳过 /tmp/x.jsonl：bad jsonl\n');
    fake.last().child.emit('close', 1);
    const st = await status();
    expect(st['running']).toBe(false);
    expect(st['exit_code']).toBe(1);
    expect(st['result']).toBeNull();
    expect(String(st['error'])).toContain('退出码 1');
    expect(st['lines']).toEqual(['跳过 /tmp/x.jsonl：bad jsonl']);
  });

  it("'all' 归一化为 1970-01-01", async () => {
    const fake = fakeSpawn();
    await makeApp({ spawn: fake.spawn });
    const res = await call('POST', '/api/import', { since: 'all' });
    expect(res.statusCode).toBe(202);
    expect(res.json().since).toBe('1970-01-01T00:00:00.000Z');
    expect(fake.last().args[3]).toBe('1970-01-01T00:00:00.000Z');
  });

  it('非法 since / 缺 body → 400 E_INPUT（detail.reason 可判）', async () => {
    const fake = fakeSpawn();
    await makeApp({ spawn: fake.spawn });
    const cases: unknown[] = [{ since: 'not-a-date' }, { since: 123 }, {}];
    for (const payload of cases) {
      const res = await call('POST', '/api/import', payload);
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('E_INPUT');
      expect(body.detail.reason).toBe('since_invalid');
    }
    // 一个子进程都没起
    expect(() => fake.last()).toThrow();
  });

  it('已有导入在跑 → 409，且不会起第二个子进程', async () => {
    const fake = fakeSpawn();
    await makeApp({ spawn: fake.spawn });
    const first = await call('POST', '/api/import', { since: '2026-01-01' });
    expect(first.statusCode).toBe(202);

    const second = await call('POST', '/api/import', { since: '2026-01-02' });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toBe('E_CONFLICT');
    expect(body.message).toBe('导入正在执行，稍后再试');
    expect(body.detail.reason).toBe('import_running');

    fake.last().child.emit('close', 0);
    expect((await status())['running']).toBe(false);
  });

  it('没有 token 一律 401（POST 与 GET 都校验）', async () => {
    await makeApp({ spawn: fakeSpawn().spawn });
    const res = await app().inject({ method: 'POST', url: '/api/import', payload: { since: 'all' } });
    expect(res.statusCode).toBe(401);
    const st = await app().inject({ method: 'GET', url: '/api/import/status' });
    expect(st.statusCode).toBe(401);
  });
});

describe('GET /api/import/status', () => {
  it('从未导入过时是完整空态', async () => {
    await makeApp({ spawn: fakeSpawn().spawn });
    const st = await status();
    expect(st).toEqual({
      running: false,
      since: null,
      started_at: null,
      finished_at: null,
      exit_code: null,
      lines: [],
      result: null,
      error: null,
    });
  });

  it('spawn 注入为 null 时走进程内降级，状态同样能落定', async () => {
    await makeApp({ spawn: null });
    const res = await call('POST', '/api/import', { since: '2026-01-01' });
    expect(res.statusCode).toBe(202);

    const done = await waitIdle();
    expect(done['exit_code']).toBe(0);
    expect(done['error']).toBeNull();
    const result = done['result'] as Record<string, unknown>;
    expect(result['unavailable']).toEqual([]);
    expect(result['facts']).toBe(0);
  });
});
