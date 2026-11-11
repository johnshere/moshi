/**
 * 接入层日志服务面（P3；开发方案 §4 P3）。
 *
 * 真 Fastify 实例 + 真 SQLite + 真 trace 目录：分页合并、过滤、统计、清空
 * 这几件事都要在"两源不同存储介质"上验证，mock 掉任一侧就失去意义。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpApp } from '../../src/app/http/server.js';
import { loadConfig } from '../../src/app/config.js';
import { TraceSink } from '../../src/core/hook/traceSink.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';

const TOKEN = 'test_token_logs';

interface Ctx {
  db: Db;
  sink: TraceSink;
  traceDir: string;
}

const appRef: { app?: Awaited<ReturnType<typeof buildHttpApp>>['app'] } = {};
const opened: Db[] = [];

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'moshi-logs-api-'));
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups'), vectorEnabled: false });
  opened.push(db);
  return db;
}

interface RowOver {
  caller_id?: string | null;
  caller_kind?: string | null;
  plugin_id?: string | null;
  corr_id?: string | null;
  status?: string | null;
  in_bytes?: number | null;
  out_bytes?: number | null;
  latency_ms?: number;
  packed_json?: string;
}

function insertQuery(db: Db, id: string, ts: string, over: RowOver = {}): void {
  db.prepare(
    `INSERT INTO query_log (id, ts, query_text, query_hash, route, flags_json, latency_ms,
       caller_id, caller_kind, plugin_id, corr_id, status, in_bytes, out_bytes, packed_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    ts,
    `query ${id}`,
    `hash_${id}`,
    'local',
    '{}',
    over.latency_ms ?? 30,
    over.caller_id === undefined ? 'gateway:magpie:moshi' : over.caller_id,
    over.caller_kind === undefined ? 'gateway' : over.caller_kind,
    over.plugin_id === undefined ? 'moshi' : over.plugin_id,
    over.corr_id === undefined ? null : over.corr_id,
    over.status === undefined ? 'ok' : over.status,
    over.in_bytes === undefined ? 12 : over.in_bytes,
    over.out_bytes === undefined ? 128 : over.out_bytes,
    over.packed_json ?? '[{"m_id":1}]',
  );
}

async function makeApp(): Promise<Ctx> {
  const home = tempDir();
  const cfg = loadConfig({ home });
  const db = freshDb();
  const uiDir = path.join(home, 'ui');
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf8');
  // 服务端把 traceDir 定为 dataPaths(cfg).hook = <home>/.moshi/hook
  const traceDir = path.join(home, '.moshi', 'hook');
  const sink = new TraceSink({ dir: traceDir, level: 'summary', maxBytes: 1 << 20, keepDays: 7 });
  const { app } = await buildHttpApp({
    db,
    cfg,
    token: TOKEN,
    uiDistDir: uiDir,
    home,
    configFile: path.join(home, 'config.yaml'),
    hookTraceSink: sink,
  });
  appRef.app = app;
  return { db, sink, traceDir };
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
});

describe('GET /api/logs', () => {
  it('两源合并按时间倒序，cursor 翻页不重不漏', async () => {
    const { db, sink } = await makeApp();
    insertQuery(db, 'q_10', '2026-11-11T10:00:00.000Z', { corr_id: 'c'.repeat(16) });
    insertQuery(db, 'q_09', '2026-11-11T09:00:00.000Z', {
      caller_id: 'mcp:moshi:server',
      caller_kind: 'mcp',
    });
    sink.append({
      ts: '2026-11-11T09:30:00.000Z',
      host: 'magpie',
      turn: 'user_prompt',
      status: 'ready',
      inject_bytes: 300,
      evidence: 5,
      degraded: [],
      identity_source: 'vcs',
      latency_ms: 50,
      corr_id: 'a'.repeat(16),
    });
    await sink.flush();

    const first = (await call('GET', '/api/logs?limit=2')).json() as Record<string, unknown>;
    const items = first['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]?.['source']).toBe('query');
    expect(String(items[0]?.['id'])).toBe('q_10');
    expect(items[1]?.['source']).toBe('trace');
    const cursor = first['next_cursor'] as string | null;
    expect(cursor).not.toBeNull();
    const second = (
      await call('GET', `/api/logs?limit=2&cursor=${encodeURIComponent(cursor as string)}`)
    ).json() as Record<string, unknown>;
    const rest = second['items'] as Record<string, unknown>[];
    expect(rest).toHaveLength(1);
    expect(String(rest[0]?.['id'])).toBe('q_09');
    expect(second['next_cursor']).toBeNull();
  });

  it('按 source / q 过滤；历史行归 unknown 接入点', async () => {
    const { db } = await makeApp();
    insertQuery(db, 'q_a', '2026-11-11T10:00:00.000Z', {});
    insertQuery(db, 'q_old', '2026-11-11T09:00:00.000Z', {
      caller_id: null,
      caller_kind: null,
      plugin_id: null,
      status: null,
      in_bytes: null,
      out_bytes: null,
    });
    const onlyQuery = (await call('GET', '/api/logs?source=query')).json() as Record<string, unknown>;
    expect((onlyQuery['items'] as unknown[]).length).toBe(2);
    const mcp = (await call('GET', '/api/logs?kind=mcp')).json() as Record<string, unknown>;
    expect((mcp['items'] as unknown[]).length).toBe(0);
    const q = (await call('GET', '/api/logs?q=query%20q_a')).json() as Record<string, unknown>;
    const qItems = q['items'] as Record<string, unknown>[];
    expect(qItems.map((item) => item['id'])).toContain('q_a');
    const hist = (await call('GET', '/api/logs?kind=unknown')).json() as Record<string, unknown>;
    const histItems = hist['items'] as Record<string, unknown>[];
    expect(histItems[0]?.['caller_id']).toBe('unknown');
  });
});

describe('GET /api/logs/summary', () => {
  it('按接入点聚合：计数、降级、P95', async () => {
    const { db } = await makeApp();
    const now = new Date().toISOString();
    insertQuery(db, 'q_1', now, { latency_ms: 100 });
    insertQuery(db, 'q_2', now, { latency_ms: 200, status: 'degraded' });
    insertQuery(db, 'q_3', now, {
      caller_id: 'mcp:moshi:server',
      caller_kind: 'mcp',
      latency_ms: 40,
    });
    const body = (await call('GET', '/api/logs/summary?window=24h')).json() as Record<string, unknown>;
    const groups = body['groups'] as Record<string, unknown>[];
    const gateway = groups.find((group) => group['caller_id'] === 'gateway:magpie:moshi');
    expect(gateway?.['count']).toBe(2);
    expect(gateway?.['degraded']).toBe(1);
    expect(gateway?.['p95_ms']).toBe(200);
    const mcp = groups.find((group) => group['caller_id'] === 'mcp:moshi:server');
    expect(mcp?.['count']).toBe(1);
    expect((body['totals'] as Record<string, unknown>)['count']).toBe(3);
  });
});

describe('清空日志（维护接口）', () => {
  it('query-log 必须 confirm: "PURGE"，清空后留 audit', async () => {
    const { db } = await makeApp();
    insertQuery(db, 'q_1', '2026-11-11T10:00:00.000Z', {});
    const denied = await call('POST', '/api/maintenance/query-log/purge', {});
    expect(denied.statusCode).toBe(400);
    const okRes = (
      await call('POST', '/api/maintenance/query-log/purge', { confirm: 'PURGE' })
    ).json() as Record<string, unknown>;
    expect(okRes['removed']).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM query_log').get()).toEqual({ n: 0 });
    const audit = db
      .prepare("SELECT reason FROM audit WHERE tbl = 'query_log' ORDER BY ts DESC LIMIT 1")
      .get() as { reason: string } | undefined;
    expect(audit?.reason).toContain('manual purge');
  });

  it('trace purge 同时清磁盘与内存 ring', async () => {
    const { sink } = await makeApp();
    sink.append({
      ts: new Date().toISOString(),
      host: 'magpie',
      turn: 'response',
      status: 'ready',
      inject_bytes: 10,
      evidence: 1,
      degraded: [],
      identity_source: 'vcs',
      latency_ms: 5,
    });
    await sink.flush();
    const okRes = (
      await call('POST', '/api/maintenance/trace/purge', { confirm: 'PURGE' })
    ).json() as Record<string, unknown>;
    expect(okRes['disk_removed']).toBe(1);
    expect(okRes['memory_removed']).toBe(0);
    const after = (await call('GET', '/api/logs?source=trace')).json() as Record<string, unknown>;
    expect((after['items'] as unknown[]).length).toBe(0);
  });
});
