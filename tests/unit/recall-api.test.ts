/**
 * `POST /api/recall` 契约单测（P2①，moshi-recall/1）。
 *
 * 这条路由的职责只有一个：把 HTTP 入参翻译成 `QueryInput`，再把 `EvidencePackJson`
 * 翻译成召回契约——**读取链本身不在这里测**（`runMemoryQuery` 的 gate/打包/降级由
 * `tests/unit/mcp.test.ts` 覆盖，这里只在端到端意义上确认「确实走了那条链」）。
 *
 * 重点钉三件事：
 * 1. 命中：证据带 m_id/content/confidence，注入文本是编号列表；
 * 2. **空命中是 200 + 「无可靠记忆」**，不是 4xx/5xx（本任务要修的旧习惯）；
 * 3. 入参错误是 400 `E_INPUT`（`limit` 超上限是夹住，不是报错）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { recallRoutes, RECALL_SCHEMA } from '../../src/app/http/routes/recall.js';
import { loadConfig } from '../../src/app/config.js';
import type { McpDeps } from '../../src/app/mcp/deps.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { insertFact } from '../fixtures/factories.js';
import { confidenceKey, degradedCodes, isEmptyHit } from '../../src/ui/recall/pure.js';

const opened: Db[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function freshDb(): Db {
  const dir = tempDir('moshi-recall-api-');
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

interface RecallBody {
  schema: string;
  query: string;
  scope: string;
  limit: number;
  status: string;
  route: string;
  degraded: string[];
  advice: string;
  confidence_summary: string;
  identity: string;
  coverage: string;
  truncated: boolean;
  empty: boolean;
  injection_text: string;
  evidence: {
    m_id: number;
    fact_id: string;
    content: string;
    confidence: number;
    confidence_source: string;
    ftype: string;
  }[];
  conflict_count: number;
  trace: { query_id: string; route: string; cached: boolean; stats: Record<string, number> };
  took_ms: number;
}

async function freshApp(): Promise<{ db: Db; app: FastifyInstance }> {
  const db = freshDb();
  const deps: McpDeps = { db, cfg: loadConfig({ home: tempDir('moshi-recall-home-') }) };
  const app = Fastify({ logger: false });
  await app.register(recallRoutes, { prefix: '/api/recall', deps });
  await app.ready();
  apps.push(app);
  return { db, app };
}

function bodyOf(res: { payload: string }): RecallBody {
  return JSON.parse(res.payload) as RecallBody;
}

function errorOf(res: { payload: string }): { error: string; message: string; detail?: { reason?: string } } {
  return JSON.parse(res.payload) as { error: string; message: string; detail?: { reason?: string } };
}

describe('POST /api/recall 命中', () => {
  it('走唯一读取链：证据带 m_id / content / confidence，注入文本是编号列表', async () => {
    const { db, app } = await freshApp();
    insertFact(db, { content: 'node version = 22' });
    insertFact(db, { content: 'python version = 3.13' });
    syncMissingFts(db);

    const res = await app.inject({ method: 'POST', url: '/api/recall', payload: { query: 'node' } });
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.schema).toBe(RECALL_SCHEMA);
    expect(body.query).toBe('node');
    expect(body.scope).toBe('global');
    expect(body.limit).toBe(8);
    expect(body.empty).toBe(false);
    expect(body.evidence).toHaveLength(1);
    const hit = body.evidence[0]!;
    expect(hit.m_id).toBe(1);
    expect(hit.content).toContain('node');
    expect(typeof hit.fact_id).toBe('string');
    expect(hit.fact_id.length).toBeGreaterThan(0);
    expect(hit.confidence).toBeGreaterThan(0);
    expect(typeof hit.confidence_source).toBe('string');
    expect(typeof hit.ftype).toBe('string');
    // 证据包语义字段（前端据 confidence_summary 上色、据 advice 给口径）
    expect(['high', 'medium', 'low']).toContain(body.confidence_summary);
    expect(body.advice.length).toBeGreaterThan(0);
    expect(body.injection_text).toContain('[M1]');
    expect(body.conflict_count).toBe(0);
    // trace 摘要能回放：query_id 非空，stats 四个计数都在
    expect(body.trace.query_id.length).toBeGreaterThan(0);
    expect(body.trace.route).toBe(body.route);
    expect(Object.keys(body.trace.stats).sort()).toEqual(['candidates', 'latency_ms', 'packed', 'tokens']);
    expect(body.took_ms).toBeGreaterThanOrEqual(0);
  });

  it('limit 生效且被夹到上限 32', async () => {
    const { db, app } = await freshApp();
    for (let i = 0; i < 3; i += 1) insertFact(db, { content: `alpha item ${String(i)}` });
    syncMissingFts(db);

    const small = bodyOf(await app.inject({ method: 'POST', url: '/api/recall', payload: { query: 'alpha', limit: 5 } }));
    expect(small.limit).toBe(5);

    const capped = bodyOf(await app.inject({ method: 'POST', url: '/api/recall', payload: { query: 'alpha', limit: 999 } }));
    expect(capped.limit).toBe(32);
  });

  it('query 两端空白被裁掉；scope 透传', async () => {
    const { db, app } = await freshApp();
    insertFact(db, { content: 'node version = 22' });
    syncMissingFts(db);
    const body = bodyOf(
      await app.inject({ method: 'POST', url: '/api/recall', payload: { query: '  node  ', scope: 'proj-x' } }),
    );
    expect(body.query).toBe('node');
    expect(body.scope).toBe('proj-x');
  });

  it('响应带 cache-control: no-store（同一次召回不该被 HTTP 缓存）', async () => {
    const { app } = await freshApp();
    const res = await app.inject({ method: 'POST', url: '/api/recall', payload: { query: 'anything' } });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/recall 空命中', () => {
  it('查不到是 200 + 无可靠记忆（不是错误）', async () => {
    const { db, app } = await freshApp();
    insertFact(db, { content: 'node version = 22' });
    syncMissingFts(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/recall',
      payload: { query: 'zzzz-no-such-thing-anywhere' },
    });
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.empty).toBe(true);
    expect(body.evidence).toEqual([]);
    expect(body.confidence_summary).toBe('none');
    expect(body.advice).toBe('无可靠记忆，请勿臆断');
    expect(body.injection_text).toBe('');
    // 空包也可能带降级码（cold_start / no_sidecar），这是状态说明而不是失败
    expect(Array.isArray(body.degraded)).toBe(true);
    // 前端按 evidence 判空
    expect(isEmptyHit(body)).toBe(true);
  });

  it('空库同理：200，不抛 4xx/5xx', async () => {
    const { app } = await freshApp();
    const res = await app.inject({ method: 'POST', url: '/api/recall', payload: { query: 'node' } });
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.empty).toBe(true);
    expect(body.confidence_summary).toBe('none');
  });
});

describe('POST /api/recall 入参校验（400 E_INPUT）', () => {
  const bad: Array<[string, unknown]> = [
    ['缺 query', {}],
    ['query 为空串', { query: '' }],
    ['query 全是空白', { query: '   ' }],
    ['query 非字符串', { query: 42 }],
    ['body 是数组', [{ query: 'x' }]],
    ['limit 为 0', { query: 'x', limit: 0 }],
    ['limit 为小数', { query: 'x', limit: 1.5 }],
    ['limit 是字符串', { query: 'x', limit: '8' }],
    ['scope 为空串', { query: 'x', scope: '  ' }],
  ];

  for (const [name, payload] of bad) {
    it(name, async () => {
      const { app } = await freshApp();
      const res = await app.inject({ method: 'POST', url: '/api/recall', payload: payload as object });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).error).toBe('E_INPUT');
    });
  }

  it('query 超 2000 码点 → 400（与 queryShape 上限对齐）', async () => {
    const { app } = await freshApp();
    const res = await app.inject({ method: 'POST', url: '/api/recall', payload: { query: 'a'.repeat(2001) } });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).detail?.reason).toBe('query_too_long');
  });

  it('2000 码点整好通过（不误杀边界）', async () => {
    const { app } = await freshApp();
    const res = await app.inject({ method: 'POST', url: '/api/recall', payload: { query: 'a'.repeat(2000) } });
    expect(res.statusCode).toBe(200);
  });
});

describe('召回页纯函数', () => {
  it('confidenceKey：未知档按 none（宁可说无，不假装有）', () => {
    expect(confidenceKey('high')).toBe('recall.confidence.high');
    expect(confidenceKey('medium')).toBe('recall.confidence.medium');
    expect(confidenceKey('low')).toBe('recall.confidence.low');
    expect(confidenceKey('none')).toBe('recall.confidence.none');
    expect(confidenceKey('whatever')).toBe('recall.confidence.none');
  });

  it('degradedCodes：去重并稳定排序', () => {
    expect(degradedCodes(['no_sidecar', 'cold_start', 'no_sidecar'])).toEqual(['cold_start', 'no_sidecar']);
    expect(degradedCodes([])).toEqual([]);
  });

  it('isEmptyHit：只看 evidence（空包 status 仍是 ok）', () => {
    expect(isEmptyHit({ evidence: [] })).toBe(true);
    expect(isEmptyHit({ evidence: [{ m_id: 1 }] })).toBe(false);
  });
});
