/**
 * 设置页后端契约测试（P2-19A-06）。
 *
 * 钉住：
 * ① GET /api/config 只返回白名单安全子集（不含 token）；
 * ② PUT /api/config 的白名单 / cron / interval / 阈值 / 端口校验与原子写盘；
 * ③ restart_required 只对启动期键为 true，且未改动的键不触发；
 * ④ POST /api/maintenance/rebuild 的 target 校验、dry_run 不写、FTS/度数实际修复。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { configRoutes } from '../../src/app/http/routes/config.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { setVectorDisabled } from '../../src/infra/vec/index.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

interface Env {
  dir: string;
  home: string;
  configPath: string;
  db: Db;
  app: FastifyInstance;
}

const envs: Env[] = [];

afterEach(async () => {
  for (const env of envs.splice(0)) {
    await env.app.close();
    closeDb(env.db);
    try {
      rmSync(env.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeEnv(): Env {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-config-api-'));
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const configPath = path.join(home, '.moshi', 'config.yaml');
  const cfg = loadConfig({ home, file: configPath });
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  const app = Fastify();
  app.register(configRoutes, {
    prefix: '/api',
    db,
    cfg,
    configPath,
    roots: [home],
  });
  const env = { dir, home, configPath, db, app };
  envs.push(env);
  return env;
}

function readDoc(file: string): Record<string, unknown> {
  return (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
}

describe('GET /api/config', () => {
  it('返回白名单安全子集，不含 token', async () => {
    const env = makeEnv();
    const res = await env.app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schema: string;
      config: Record<string, Record<string, unknown>>;
      meta: { config_path: string };
    };
    expect(body.schema).toBe('moshi-config/1');
    expect(body.meta.config_path).toBe(env.configPath);
    expect(body.config['ingest']?.['harvest_cron']).toBe('0 3 * * *');
    expect(body.config['layout']?.['interval_ms']).toBeGreaterThanOrEqual(1000);
    expect(body.config['http']?.['port']).toBe(9836);
    expect(body.config['storage']?.['archive_dir']).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain('token');
  });
});

describe('PUT /api/config', () => {
  it('合法 patch 写回 YAML，GET 立刻可见，applied 精确', async () => {
    const env = makeEnv();
    const res = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { ingest: { harvest_cron: '30 2 * * *' }, layout: { interval_ms: 5000 } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; applied: string[]; restart_required: boolean };
    expect(body.ok).toBe(true);
    expect(body.applied.sort()).toEqual(['ingest.harvest_cron', 'layout.interval_ms']);
    expect(body.restart_required).toBe(false);
    const doc = readDoc(env.configPath);
    expect((doc['ingest'] as Record<string, unknown>)['harvest_cron']).toBe('30 2 * * *');
    const got = await env.app.inject({ method: 'GET', url: '/api/config' });
    const view = got.json() as { config: Record<string, Record<string, unknown>> };
    expect(view.config['ingest']?.['harvest_cron']).toBe('30 2 * * *');
    expect(view.config['layout']?.['interval_ms']).toBe(5000);
  });

  it('非法 cron → 400 cron_invalid，且配置文件不变', async () => {
    const env = makeEnv();
    const res = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { ingest: { harvest_cron: '0 3 * *' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'E_INPUT', detail: { reason: 'cron_invalid' } });
    expect(() => readDoc(env.configPath)).toThrow();
  });

  it('未知键 → 400 unknown_key（白名单外一律拒绝）', async () => {
    const env = makeEnv();
    const res = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { sidecar: { base_url: 'http://evil' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'E_INPUT', detail: { reason: 'unknown_key' } });
  });

  it('interval_ms < 1000 → 400 interval_invalid', async () => {
    const env = makeEnv();
    const res = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { layout: { interval_ms: 500 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ detail: { reason: 'interval_invalid' } });
  });

  it('阈值 >1 → 400 value_invalid（交给 ConfigSchema 兜底）', async () => {
    const env = makeEnv();
    const res = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { archive: { dirty_threshold_confidence: 1.5 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'E_INPUT', detail: { reason: 'value_invalid' } });
  });

  it('启动期键 → restart_required=true，且只提交改动键不会误报', async () => {
    const env = makeEnv();
    const portRes = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { http: { port: 53010 } } },
    });
    expect(portRes.statusCode).toBe(200);
    expect(portRes.json()).toMatchObject({ restart_required: true, applied: ['http.port'] });
    expect((readDoc(env.configPath)['server'] as Record<string, unknown>)['port']).toBe(53010);

    const normal = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { archive: { min_facts: 9 } } },
    });
    expect(normal.json()).toMatchObject({ restart_required: false, applied: ['archive.min_facts'] });
  });

  it('保留配置文件里非白名单的既有键（深层合并而非整段覆盖）', async () => {
    const env = makeEnv();
    mkdirSync(path.dirname(env.configPath), { recursive: true });
    writeFileSync(
      env.configPath,
      'model:\n  gat_mode: "on"\n\ningest:\n  harvest_cron: "0 4 * * *"\n',
      'utf8',
    );
    const res = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { patch: { layout: { enabled: false } } },
    });
    expect(res.statusCode).toBe(200);
    const doc = readDoc(env.configPath);
    expect((doc['model'] as Record<string, unknown>)['gat_mode']).toBe('on');
    expect((doc['ingest'] as Record<string, unknown>)['harvest_cron']).toBe('0 4 * * *');
    expect((doc['layout'] as Record<string, unknown>)['enabled']).toBe(false);
  });
});

describe('POST /api/maintenance/rebuild', () => {
  it('dry_run 只统计、不修 FTS', async () => {
    const env = makeEnv();
    setVectorDisabled(env.db, true);
    insertFact(env.db);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/maintenance/rebuild',
      payload: { target: 'fts', dry_run: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dry_run: boolean;
      before: { fts_missing: number };
      after: { fts_missing: number };
    };
    expect(body.dry_run).toBe(true);
    expect(body.before.fts_missing).toBe(1);
    expect(body.after.fts_missing).toBe(1);
  });

  it('fts 实跑后缺失归零', async () => {
    const env = makeEnv();
    setVectorDisabled(env.db, true);
    insertFact(env.db);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/maintenance/rebuild',
      payload: { target: 'fts' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      before: { fts_missing: number };
      after: { fts_missing: number };
      details?: { fts_added?: number };
    };
    expect(body.before.fts_missing).toBe(1);
    expect(body.after.fts_missing).toBe(0);
    expect(body.details?.fts_added).toBe(1);
  });

  it('degree 实跑修复人为破坏的度数', async () => {
    const env = makeEnv();
    setVectorDisabled(env.db, true);
    const a = insertFact(env.db);
    const b = insertFact(env.db);
    insertEdge(env.db, a, b);
    env.db.prepare('UPDATE fact SET degree = 99 WHERE id = ?').run(a);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/maintenance/rebuild',
      payload: { target: 'degree' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      before: { degree_mismatch: 1 },
      after: { degree_mismatch: 0 },
    });
    const degree = env.db.prepare('SELECT degree FROM fact WHERE id = ?').get(a) as {
      degree: number;
    };
    expect(degree.degree).toBe(1);
  });

  it('非法 target → 400 target_invalid', async () => {
    const env = makeEnv();
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/maintenance/rebuild',
      payload: { target: 'everything' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ detail: { reason: 'target_invalid' } });
  });

  it('向量不可用：dry_run 可计数；实跑 vec 无 sidecar → 503', async () => {
    const env = makeEnv();
    setVectorDisabled(env.db, false);
    insertFact(env.db);
    const dry = await env.app.inject({
      method: 'POST',
      url: '/api/maintenance/rebuild',
      payload: { target: 'vec', dry_run: true },
    });
    expect(dry.statusCode).toBe(200);
    expect((dry.json() as { before: { vec_missing: number } }).before.vec_missing).toBe(1);

    const real = await env.app.inject({
      method: 'POST',
      url: '/api/maintenance/rebuild',
      payload: { target: 'vec' },
    });
    expect(real.statusCode).toBe(503);
    expect(real.json()).toMatchObject({ error: 'E_BUSY', detail: { reason: 'sidecar_unavailable' } });
  });
});
