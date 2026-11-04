/**
 * 全库流式导出（P2-19A-12）：GET /api/export/all。
 *
 * 覆盖：JSON 附件头、moshi-export/1 结构、全部 epistemic 状态、分批流式拼接、
 * `?include=archive` 只带台账元数据（原文不出境）、空库也输出合法 JSON。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { exportRoutes } from '../../src/app/http/routes/privacy.js';
import type { Db } from '../../src/infra/sqlite/db.js';
import { closeDb, openDb } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import type { Edge, Entity, Fact } from '../../src/domain/types.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

interface Env {
  dir: string;
  db: Db;
  app: FastifyInstance;
}

const opened: { db: Db; app: FastifyInstance }[] = [];

async function makeEnv(): Promise<Env> {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-export-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  const app = Fastify({ logger: false });
  await app.register(exportRoutes, { prefix: '/api/export', db });
  await app.ready();
  opened.push({ db, app });
  return { dir, db, app };
}

afterEach(async () => {
  while (opened.length > 0) {
    const item = opened.pop();
    if (item === undefined) continue;
    await item.app.close();
    closeDb(item.db);
  }
});

interface ExportBody {
  schema: string;
  exported_at: string;
  facts: Fact[];
  edges: Edge[];
  entities: Entity[];
  annotations: Record<string, unknown>[];
  archive_topics?: Record<string, unknown>[];
  meta: { schema_rev: number; user_version: number };
}

const NOW = '2026-01-02T03:04:05.000Z';

function seed(db: Db): { f1: string; f2: string } {
  const f1 = insertFact(db, { content: 'pnpm 版本 10', epistemicStatus: 'active' });
  const f2 = insertFact(db, {
    content: 'node 版本 20',
    epistemicStatus: 'invalidated',
    value: '20.0.0',
  });
  insertEdge(db, f1, f2, 'depends_on');
  db.prepare(
    `INSERT INTO annotation (id, dedup_key, payload_json, channel, received_at)
     VALUES ('an1', 'dedup-1', '{"text":"不参与导出?"}', 'annotate', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO archive_meta (topic_id, slug, path, title, revision, last_exported_at, dirty, human_edited, status)
     VALUES ('1', 'node', 'topics/node.md', 'node', 2, ?, 0, 0, 'active')`,
  ).run(NOW);
  return { f1, f2 };
}

describe('GET /api/export/all', () => {
  it('返回 JSON 附件流，含全部 epistemic 状态与四类数据', async () => {
    const { db, app } = await makeEnv();
    seed(db);

    const res = await app.inject({ method: 'GET', url: '/api/export/all' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).toContain('attachment;');
    expect(disposition).toMatch(/filename="moshi-export-\d{4}-\d{2}-\d{2}\.json"/);

    const body = res.json() as ExportBody;
    expect(body.schema).toBe('moshi-export/1');
    expect(typeof body.exported_at).toBe('string');
    expect(body.facts).toHaveLength(2);
    const statuses = body.facts.map((f) => f.epistemicStatus).sort();
    expect(statuses).toEqual(['active', 'invalidated']);
    expect(body.edges).toHaveLength(1);
    expect(body.entities).toHaveLength(2);
    expect(body.annotations).toHaveLength(1);
    expect(body.annotations[0]?.['dedup_key']).toBe('dedup-1');
    expect(typeof body.meta.schema_rev).toBe('number');
    expect(typeof body.meta.user_version).toBe('number');
    expect(body.archive_topics).toBeUndefined();
  });

  it('?include=archive 只附加台账元数据，不含归档正文', async () => {
    const { db, app } = await makeEnv();
    seed(db);

    const res = await app.inject({ method: 'GET', url: '/api/export/all?include=archive' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportBody;
    expect(body.archive_topics).toHaveLength(1);
    const topic = body.archive_topics?.[0] ?? {};
    expect(topic['slug']).toBe('node');
    expect(topic['revision']).toBe(2);
    // 元数据白名单：不应带正文/摘要字段
    expect(topic['content']).toBeUndefined();
    expect(topic['body']).toBeUndefined();
  });

  it('空库也输出合法 JSON（数组为空）', async () => {
    const { app } = await makeEnv();
    const res = await app.inject({ method: 'GET', url: '/api/export/all' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportBody;
    expect(body.schema).toBe('moshi-export/1');
    expect(body.facts).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.entities).toEqual([]);
    expect(body.annotations).toEqual([]);
    expect(typeof body.meta.user_version).toBe('number');
  });

  it('超过单页 500 条时流式分页拼出完整 JSON', async () => {
    const { db, app } = await makeEnv();
    for (let i = 0; i < 520; i += 1) {
      insertFact(db, { content: `批量事实 ${i}`, value: `v-${i}` });
    }
    const res = await app.inject({ method: 'GET', url: '/api/export/all' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportBody;
    expect(body.facts).toHaveLength(520);
    // 分页边界不丢/不重：id 唯一
    expect(new Set(body.facts.map((f) => f.id)).size).toBe(520);
  });
});
