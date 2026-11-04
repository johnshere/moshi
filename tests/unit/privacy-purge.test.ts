/**
 * 隐私 purge + 隐私总览（P2-19A-12）。
 *
 * 覆盖：
 * - confirm 二次确认（缺失 → 400 E_INPUT reason=confirm_required）
 * - dry_run 只统计、零写入
 * - scope=all 单事务删除 + 先写 audit + 保留 meta/ontology + 归档白名单
 * - scope=archive / facts / sessions 的边界
 * - GET /api/privacy/overview 计数与 retention
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/app/config.js';
import { privacyRoutes } from '../../src/app/http/routes/privacy.js';
import type { Db } from '../../src/infra/sqlite/db.js';
import { closeDb, openDb } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

interface Env {
  dir: string;
  db: Db;
  cfg: Config;
  archiveDir: string;
  app: FastifyInstance;
}

const opened: { db: Db; app: FastifyInstance }[] = [];

async function makeEnv(): Promise<Env> {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-privacy-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  const archiveDir = path.join(dir, 'archive');
  const cfg = loadConfig({ home: dir });
  cfg.storage.archive_dir = archiveDir;
  const app = Fastify({ logger: false });
  await app.register(privacyRoutes, { prefix: '/api/privacy', db, cfg });
  await app.ready();
  opened.push({ db, app });
  return { dir, db, cfg, archiveDir, app };
}

afterEach(async () => {
  while (opened.length > 0) {
    const item = opened.pop();
    if (item === undefined) continue;
    await item.app.close();
    closeDb(item.db);
  }
});

const NOW = '2026-01-02T03:04:05.000Z';

function count(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { n: number };
  return row.n;
}

function seed(db: Db, archiveDir: string): { f1: string; f2: string } {
  const f1 = insertFact(db, { content: 'node 版本是 22', epistemicStatus: 'active' });
  const f2 = insertFact(db, {
    content: 'node 版本是 20',
    epistemicStatus: 'invalidated',
    value: '20.0.0',
  });
  insertEdge(db, f1, f2);

  db.prepare(
    `INSERT INTO session (id, agent, cwd, started_at, turn_count) VALUES ('s1', 'claude', '/tmp', ?, 3)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO episode (id, session, ts, raw_hash) VALUES ('ep1', 's1', ?, 'raw-hash-1')`,
  ).run(NOW);
  db.prepare('UPDATE fact SET source_episode = ? WHERE id = ?').run('ep1', f1);
  db.prepare(
    `INSERT INTO annotation (id, dedup_key, payload_json, channel, received_at)
     VALUES ('an1', 'dedup-1', '{"secret":"用户原文"}', 'annotate', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO quarantine (id, payload_json, reason, ts) VALUES ('q1', '{}', 'bad', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO feedback (id, query_id, fact_id, verdict, ts) VALUES ('fb1', NULL, ?, 'adopt', ?)`,
  ).run(f1, NOW);
  db.prepare(
    `INSERT INTO layout (fact_id, x, y, z, layout_version, computed_at) VALUES (?, 0, 0, 0, 1, ?)`,
  ).run(f1, NOW);
  db.prepare(
    `INSERT INTO ontology (kind, name, registered_at, promoted) VALUES ('predicate', 'about', ?, 1)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO archive_meta (topic_id, slug, path, title, revision, last_exported_at, dirty, human_edited, status)
     VALUES ('1', 'node', 'topics/node.md', 'node', 2, ?, 1, 1, 'active')`,
  ).run(NOW);

  mkdirSync(path.join(archiveDir, 'topics', 'sub'), { recursive: true });
  mkdirSync(path.join(archiveDir, '_history'), { recursive: true });
  writeFileSync(path.join(archiveDir, 'topics', 'node.md'), '# node');
  writeFileSync(path.join(archiveDir, 'topics', 'sub', 'pnpm.md'), '# pnpm');
  writeFileSync(path.join(archiveDir, '_history', 'node-v1.md'), '# old');
  // 白名单外：目录外的资源文件 / topics 下的非 .md，purge 必须保留
  writeFileSync(path.join(archiveDir, 'outside.txt'), 'keep me');
  writeFileSync(path.join(archiveDir, 'topics', 'keep.txt'), 'keep me too');
  return { f1, f2 };
}

async function post(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: 'POST', url: '/api/privacy/purge', payload: payload as object });
}

describe('POST /api/privacy/purge', () => {
  it('缺少 confirm 时 400 E_INPUT confirm_required，且不写任何行', async () => {
    const { db, archiveDir, app } = await makeEnv();
    seed(db, archiveDir);

    const res = await post(app, { scope: 'all' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; detail: { reason: string } };
    expect(body.error).toBe('E_INPUT');
    expect(body.detail.reason).toBe('confirm_required');
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact')).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE tbl = 'privacy'")).toBe(0);
    expect(existsSync(path.join(archiveDir, 'topics', 'node.md'))).toBe(true);
  });

  it('dry_run 返回统计但不写库、不删文件', async () => {
    const { db, archiveDir, app } = await makeEnv();
    seed(db, archiveDir);

    const res = await post(app, { scope: 'all', confirm: 'PURGE', dry_run: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      dry_run: boolean;
      would_delete: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.dry_run).toBe(true);
    expect(body.would_delete).toEqual({
      facts: 2,
      edges: 1,
      entities: 2,
      annotations: 1,
      sessions: 1,
      archive_files: 3,
    });
    // 零写入
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact')).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE tbl = 'privacy'")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM archive_meta')).toBe(1);
    expect(existsSync(path.join(archiveDir, 'topics', 'node.md'))).toBe(true);
    expect(existsSync(path.join(archiveDir, '_history', 'node-v1.md'))).toBe(true);
  });

  it('scope=all：清事实链/会话/实体/注解，保留 meta+ontology+audit，先写审计，归档只删白名单', async () => {
    const { db, archiveDir, app } = await makeEnv();
    seed(db, archiveDir);

    const res = await post(app, { scope: 'all', confirm: 'PURGE' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      deleted: Record<string, number>;
      archive_files_removed: number;
      size_before_mb: number;
      size_after_mb: number;
      elapsed_ms: number;
    };
    expect(body.ok).toBe(true);
    expect(body.deleted).toEqual({ facts: 2, edges: 1, entities: 2, annotations: 1, sessions: 1 });
    expect(body.archive_files_removed).toBe(3);
    expect(typeof body.size_before_mb).toBe('number');
    expect(typeof body.size_after_mb).toBe('number');
    expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);

    // 数据表全清
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM edge')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM entity')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM annotation')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM session')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM episode')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM quarantine')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM feedback')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM layout')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM archive_meta')).toBe(0);

    // 保留 meta / ontology，且审计先落
    expect(count(db, "SELECT COUNT(*) AS n FROM meta WHERE key = 'schema_rev'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ontology')).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE tbl = 'privacy' AND field = 'privacy.purge'")).toBe(1);
    const after = db
      .prepare("SELECT after_json AS j FROM audit WHERE tbl = 'privacy'")
      .get() as { j: string };
    expect((JSON.parse(after.j) as { scope: string }).scope).toBe('all');

    // 归档：白名单内文件删掉，目录保留，白名单外文件保留
    expect(existsSync(path.join(archiveDir, 'topics', 'node.md'))).toBe(false);
    expect(existsSync(path.join(archiveDir, 'topics', 'sub', 'pnpm.md'))).toBe(false);
    expect(existsSync(path.join(archiveDir, '_history', 'node-v1.md'))).toBe(false);
    expect(existsSync(path.join(archiveDir, 'topics'))).toBe(true);
    expect(existsSync(path.join(archiveDir, '_history'))).toBe(true);
    expect(existsSync(path.join(archiveDir, 'outside.txt'))).toBe(true);
    expect(existsSync(path.join(archiveDir, 'topics', 'keep.txt'))).toBe(true);
  });

  it('scope=archive 只删归档文件与台账，不动事实', async () => {
    const { db, archiveDir, app } = await makeEnv();
    seed(db, archiveDir);

    const res = await post(app, { scope: 'archive', confirm: 'PURGE' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: Record<string, number>; archive_files_removed: number };
    expect(body.archive_files_removed).toBe(3);
    expect(body.deleted).toEqual({ facts: 0, edges: 0, entities: 0, annotations: 0, sessions: 0 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact')).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS n FROM archive_meta')).toBe(0);
    expect(existsSync(path.join(archiveDir, 'topics', 'node.md'))).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE tbl = 'privacy'")).toBe(1);
  });

  it('scope=facts 保留实体与会话/注解，只清事实链', async () => {
    const { db, archiveDir, app } = await makeEnv();
    seed(db, archiveDir);

    const res = await post(app, { scope: 'facts', confirm: 'PURGE' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: Record<string, number> };
    expect(body.deleted).toEqual({ facts: 2, edges: 1, entities: 0, annotations: 0, sessions: 0 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM entity')).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS n FROM annotation')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM session')).toBe(1);
    expect(existsSync(path.join(archiveDir, 'topics', 'node.md'))).toBe(true);
  });

  it('scope=sessions 删除会话/轨迹/注解，断开 fact.source_episode 但不删事实', async () => {
    const { db, archiveDir, app } = await makeEnv();
    seed(db, archiveDir);

    const res = await post(app, { scope: 'sessions', confirm: 'PURGE' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: Record<string, number> };
    expect(body.deleted).toEqual({ facts: 0, edges: 0, entities: 0, annotations: 1, sessions: 1 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM session')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM episode')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM annotation')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact')).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact WHERE source_episode IS NOT NULL')).toBe(0);
  });
});

describe('GET /api/privacy/overview', () => {
  it('返回计数/体积/retention，purge 后 last_purge_at 有值', async () => {
    const { db, archiveDir, app } = await makeEnv();
    seed(db, archiveDir);

    const before = await app.inject({ method: 'GET', url: '/api/privacy/overview' });
    expect(before.statusCode).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    const b = before.json() as {
      schema: string;
      db: { path: string; size_mb: number; wal_mb: number };
      counts: Record<string, number>;
      archive: { dir: string; topics: number; bytes: number };
      retention: { prune_idle_days: number; half_life_days: number };
      last_purge_at: string | null;
    };
    expect(b.schema).toBe('moshi-privacy/1');
    expect(b.db.path).toContain('moshi.db');
    expect(b.counts['facts']).toBe(2);
    expect(b.counts['edges']).toBe(1);
    expect(b.counts['sessions']).toBe(1);
    expect(b.counts['archive_topics']).toBe(1);
    expect(b.counts['facts_pruned']).toBe(0);
    expect(b.counts['facts_invalidated']).toBe(1);
    expect(b.archive.dir).toBe(archiveDir);
    expect(b.archive.topics).toBe(1);
    expect(b.archive.bytes).toBeGreaterThan(0);
    expect(b.retention).toEqual({ prune_idle_days: 60, half_life_days: 14 });
    expect(b.last_purge_at).toBeNull();

    await post(app, { scope: 'all', confirm: 'PURGE' });
    const after = await app.inject({ method: 'GET', url: '/api/privacy/overview' });
    const a = after.json() as { last_purge_at: string | null; counts: Record<string, number> };
    expect(typeof a.last_purge_at).toBe('string');
    expect(a.counts['facts']).toBe(0);
    expect(a.counts['archive_topics']).toBe(0);
  });
});
