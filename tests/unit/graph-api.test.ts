/**
 * `/api/graph` 契约测试（P2-02）。
 *
 * 钉住的是"这个接口不会把库拖死"的三条线：limit 夹取、截断如实上报、
 * 边不越页。外加两条口径：只画 active/disputed、没 layout 的节点不塞原点。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT } from '../../src/app/http/routes/graph.js';
import { nowIso } from '../../src/domain/time.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

const TOKEN = 'graph_test_token';

const opened: Db[] = [];
const dirs: string[] = [];

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

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-graph-'));
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

function putLayout(db: Db, factId: string, x: number, y: number, z: number, version = 1): void {
  db.prepare(
    `INSERT INTO layout (fact_id, x, y, z, layout_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(factId, x, y, z, version, nowIso());
}

async function makeApp(db: Db) {
  const cfg = loadConfig({ home: tempDir() });
  const { app } = await buildHttpApp({ db, cfg, token: TOKEN });
  return app;
}

interface GraphBody {
  nodes: {
    id: string;
    x: number;
    y: number;
    z: number;
    ftype: string;
    importance: number;
    strength: number;
    community_id: number | null;
    label: string;
    access_count: number;
  }[];
  edges: { src: string; dst: string; etype: string; confidence: number }[];
  meta: {
    total_nodes: number;
    returned_nodes: number;
    total_edges: number;
    returned_edges: number;
    truncated: boolean;
    nodes_without_layout: number;
    layout_version: number;
    limit: number;
    next_cursor: string | null;
  };
}

/** 三节点三层图：a 最重要，边 a-b、b-c，c 另有条通往归档节点的边 */
function seedThree(db: Db): void {
  insertFact(db, { id: 'fact_a', importance: 0.9, strength: 0.8, content: 'a 依赖 b' });
  insertFact(db, { id: 'fact_b', importance: 0.8, strength: 0.5, content: 'b 依赖 c' });
  insertFact(db, { id: 'fact_c', importance: 0.7, strength: 0.1, content: 'c 已过时' });
  putLayout(db, 'fact_a', 10, 60, 0);
  putLayout(db, 'fact_b', 20, 0, 5);
  putLayout(db, 'fact_c', 30, -60, -5);

  insertEdge(db, 'fact_a', 'fact_b', 'depends_on');
  insertEdge(db, 'fact_b', 'fact_c', 'logic');
}

/** n 个节点，importance 递减、各带坐标：用来测分页边界 */
function seedMany(db: Db, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const id = `fact_${String(i).padStart(2, '0')}`;
    insertFact(db, { id, importance: 1 - i * 0.01, content: `节点 ${i}` });
    putLayout(db, id, i * 10, 0, 0);
  }
}

describe('GET /api/graph', () => {
  it('无 token 直接 401', async () => {
    const app = await makeApp(freshDb());
    const res = await app.inject({ method: 'GET', url: '/api/graph' });
    expect(res.statusCode).toBe(401);
  });

  it('默认 limit 生效，meta 统计如实', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/graph',
      headers: { 'x-moshi-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<GraphBody>();

    expect(body.meta.limit).toBe(DEFAULT_GRAPH_LIMIT);
    expect(body.meta.returned_nodes).toBe(3);
    expect(body.meta.total_nodes).toBe(3);
    expect(body.meta.returned_edges).toBe(2);
    expect(body.meta.total_edges).toBe(2);
    expect(body.meta.truncated).toBe(false);
    expect(body.meta.next_cursor).toBeNull();
    expect(body.meta.layout_version).toBe(1);

    // 重要节点先出图
    expect(body.nodes.map((n) => n.id)).toEqual(['fact_a', 'fact_b', 'fact_c']);
    // 坐标来自 layout，不是原点
    expect(body.nodes[0]).toMatchObject({ x: 10, y: 60, z: 0, community_id: null });
    // 边字段齐备
    expect(body.edges[0]).toMatchObject({ src: 'fact_a', dst: 'fact_b', etype: 'depends_on' });
  });

  it('limit 被夹到上限，非法 limit 回落到默认值', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    const h = { 'x-moshi-token': TOKEN };

    const huge = await app.inject({ method: 'GET', url: '/api/graph?limit=999999', headers: h });
    expect(huge.json<GraphBody>().meta.limit).toBe(MAX_GRAPH_LIMIT);

    for (const bad of ['abc', '0', '-5', '']) {
      const res = await app.inject({ method: 'GET', url: `/api/graph?limit=${bad}`, headers: h });
      expect(res.json<GraphBody>().meta.limit).toBe(DEFAULT_GRAPH_LIMIT);
    }
  });

  it('截断时如实报 truncated，且边只取本页两端都在的', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/graph?limit=2',
      headers: { 'x-moshi-token': TOKEN },
    });
    const body = res.json<GraphBody>();

    expect(body.nodes.map((n) => n.id)).toEqual(['fact_a', 'fact_b']);
    expect(body.meta.returned_nodes).toBe(2);
    expect(body.meta.total_nodes).toBe(3);
    expect(body.meta.truncated).toBe(true);
    expect(body.meta.returned_edges).toBe(1); // 只有 a-b；b-c 跨页被剪掉
    expect(body.edges.map((e) => `${e.src}->${e.dst}`)).toEqual(['fact_a->fact_b']);
    expect(body.meta.total_edges).toBe(2); // 总数不受分页影响
    expect(body.meta.next_cursor).toBeTypeOf('string');
  });

  it('cursor 翻页不重不漏，页内自洽', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    const h = { 'x-moshi-token': TOKEN };

    const p1 = (await app.inject({ method: 'GET', url: '/api/graph?limit=2', headers: h })).json<GraphBody>();
    const cursor = p1.meta.next_cursor;
    expect(cursor).not.toBeNull();

    const p2 = (
      await app.inject({
        method: 'GET',
        url: `/api/graph?limit=2&cursor=${cursor}`,
        headers: h,
      })
    ).json<GraphBody>();

    expect(p2.nodes.map((n) => n.id)).toEqual(['fact_c']);
    expect(p2.meta.truncated).toBe(false);
    expect(p2.meta.next_cursor).toBeNull();
    // b-c 的 c 在第二页，b 不在 → 第二页没有边
    expect(p2.edges).toHaveLength(0);

    const ids = new Set([...p1.nodes, ...p2.nodes].map((n) => n.id));
    expect(ids.size).toBe(3);
  });

  it('末页恰是最后一页：总数是 limit 整数倍时不假报 truncated', async () => {
    // 4 个节点、limit=2 → 第 2 页正好是最后一页。
    // 旧口径 `rows.length === limit && total > limit` 在这里会说 truncated=true 并给 cursor，
    // 第 3 页却 0 条（P2-02 返工 H2）。
    const db = freshDb();
    seedMany(db, 4);
    const app = await makeApp(db);
    const h = { 'x-moshi-token': TOKEN };

    const p1 = (await app.inject({ method: 'GET', url: '/api/graph?limit=2', headers: h })).json<GraphBody>();
    expect(p1.meta.truncated).toBe(true);
    expect(p1.meta.next_cursor).toBeTypeOf('string');

    const p2 = (
      await app.inject({ method: 'GET', url: `/api/graph?limit=2&cursor=${p1.meta.next_cursor}`, headers: h })
    ).json<GraphBody>();
    expect(p2.nodes).toHaveLength(2);
    expect(p2.meta.truncated).toBe(false);
    expect(p2.meta.next_cursor).toBeNull();
  });

  it('次末页仍然报 truncated，翻到末页才收口', async () => {
    const db = freshDb();
    seedMany(db, 6);
    const app = await makeApp(db);
    const h = { 'x-moshi-token': TOKEN };

    const p1 = (await app.inject({ method: 'GET', url: '/api/graph?limit=2', headers: h })).json<GraphBody>();
    const p2 = (
      await app.inject({ method: 'GET', url: `/api/graph?limit=2&cursor=${p1.meta.next_cursor}`, headers: h })
    ).json<GraphBody>();
    expect(p2.nodes).toHaveLength(2);
    expect(p2.meta.truncated).toBe(true);

    const p3 = (
      await app.inject({ method: 'GET', url: `/api/graph?limit=2&cursor=${p2.meta.next_cursor}`, headers: h })
    ).json<GraphBody>();
    expect(p3.nodes).toHaveLength(2);
    expect(p3.meta.truncated).toBe(false);
    expect(p3.meta.next_cursor).toBeNull();
  });

  it('limit 等于总数时不算截断', async () => {
    const db = freshDb();
    seedMany(db, 4);
    const app = await makeApp(db);
    const body = (
      await app.inject({ method: 'GET', url: '/api/graph?limit=4', headers: { 'x-moshi-token': TOKEN } })
    ).json<GraphBody>();
    expect(body.nodes).toHaveLength(4);
    expect(body.meta.truncated).toBe(false);
    expect(body.meta.next_cursor).toBeNull();
  });

  it('坏 cursor 回 400，不静默当成首页', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/graph?cursor=%E4%B8%8D%E6%98%AFcursor',
      headers: { 'x-moshi-token': TOKEN },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('E_BAD_CURSOR');
  });

  it('只画 active / disputed，归档节点与它的边都不出现', async () => {
    const db = freshDb();
    seedThree(db);
    insertFact(db, { id: 'fact_arch', importance: 0.99, epistemicStatus: 'archived' });
    insertFact(db, { id: 'fact_pruned', importance: 0.98, epistemicStatus: 'pruned' });
    insertFact(db, { id: 'fact_disp', importance: 0.6, epistemicStatus: 'disputed' });
    putLayout(db, 'fact_arch', 1, 1, 1);
    putLayout(db, 'fact_pruned', 2, 2, 2);
    putLayout(db, 'fact_disp', 3, 3, 3);
    insertEdge(db, 'fact_a', 'fact_arch', 'depends_on');

    const app = await makeApp(db);
    const body = (
      await app.inject({ method: 'GET', url: '/api/graph', headers: { 'x-moshi-token': TOKEN } })
    ).json<GraphBody>();

    const ids = body.nodes.map((n) => n.id);
    expect(ids).toContain('fact_disp');
    expect(ids).not.toContain('fact_arch');
    expect(ids).not.toContain('fact_pruned');
    // 归档节点那条边也不该算进总数
    expect(body.meta.total_edges).toBe(2);
  });

  it('没有 layout 的节点丢弃并计入 nodes_without_layout', async () => {
    const db = freshDb();
    seedThree(db);
    insertFact(db, { id: 'fact_unlaid', importance: 0.95 });
    insertEdge(db, 'fact_a', 'fact_unlaid', 'co_occur');

    const app = await makeApp(db);
    const body = (
      await app.inject({ method: 'GET', url: '/api/graph', headers: { 'x-moshi-token': TOKEN } })
    ).json<GraphBody>();

    expect(body.nodes.map((n) => n.id)).not.toContain('fact_unlaid');
    expect(body.meta.nodes_without_layout).toBe(1);
    expect(body.meta.total_nodes).toBe(3);
    // 一端不在返回集里的边被剪掉
    expect(body.meta.returned_edges).toBe(2);
  });

  it('失效边（valid_to 非空）不计入', async () => {
    const db = freshDb();
    seedThree(db);
    insertEdge(db, 'fact_a', 'fact_c', 'supersedes', '2020-01-01T00:00:00.000Z');
    const app = await makeApp(db);
    const body = (
      await app.inject({ method: 'GET', url: '/api/graph', headers: { 'x-moshi-token': TOKEN } })
    ).json<GraphBody>();
    expect(body.meta.total_edges).toBe(2);
    expect(body.edges.some((e) => e.etype === 'supersedes')).toBe(false);
  });

  it('label 是截断后的一行短文本，不是全文', async () => {
    const db = freshDb();
    const long = '第一行内容\n第二行内容'.repeat(20);
    insertFact(db, { id: 'fact_long', content: long, importance: 0.5 });
    putLayout(db, 'fact_long', 0, 0, 0);
    const app = await makeApp(db);
    const body = (
      await app.inject({ method: 'GET', url: '/api/graph', headers: { 'x-moshi-token': TOKEN } })
    ).json<GraphBody>();

    const label = body.nodes[0]?.label ?? '';
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label).not.toContain('\n');
    expect(label.startsWith('第一行内容')).toBe(true);
  });
});


interface NeighborBody {
  schema: string;
  id: string;
  depth: number;
  nodes: { id: string; label: string; ftype: string; degree: number }[];
  edges: { src: string; dst: string; etype: string; weight: number }[];
  truncated: boolean;
}

describe('GET /api/graph/neighbors/:id（P2-19A-18）', () => {
  it('默认 depth=1：只带一跳，根在第一位，字段齐备', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/graph/neighbors/fact_a',
      headers: { 'x-moshi-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.json<NeighborBody>();
    expect(body.schema).toBe('moshi-graph/1');
    expect(body.id).toBe('fact_a');
    expect(body.depth).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.nodes.map((n) => n.id)).toEqual(['fact_a', 'fact_b']);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toMatchObject({ src: 'fact_a', dst: 'fact_b', etype: 'depends_on' });
    expect(body.nodes[0]).toMatchObject({ label: expect.any(String), ftype: 'semantic' });
    expect(typeof body.nodes[0]?.degree).toBe('number');
  });

  it('depth=2 展开两跳', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/graph/neighbors/fact_a?depth=2',
        headers: { 'x-moshi-token': TOKEN },
      })
    ).json<NeighborBody>();
    expect(body.depth).toBe(2);
    expect(body.nodes.map((n) => n.id)).toEqual(['fact_a', 'fact_b', 'fact_c']);
    expect(body.edges).toHaveLength(2);
  });

  it('depth 非法 → 400 E_INPUT', async () => {
    const db = freshDb();
    seedThree(db);
    const app = await makeApp(db);
    for (const q of ['?depth=3', '?depth=abc', '?depth=', '?depth=0', '?depth=1&depth=2']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/graph/neighbors/fact_a${q}`,
        headers: { 'x-moshi-token': TOKEN },
      });
      expect(res.statusCode, q).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('E_INPUT');
    }
  });

  it('节点不存在 / 已归档 → 404 E_NOT_FOUND', async () => {
    const db = freshDb();
    seedThree(db);
    insertFact(db, { id: 'fact_arch', epistemicStatus: 'archived', content: '已归档' });
    const app = await makeApp(db);
    for (const id of ['fact_missing', 'fact_arch']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/graph/neighbors/${id}`,
        headers: { 'x-moshi-token': TOKEN },
      });
      expect(res.statusCode, id).toBe(404);
      expect(res.json<{ error: string }>().error).toBe('E_NOT_FOUND');
    }
  });

  it('每层最多 200 个邻居：超了截断但 200 返回 truncated=true', async () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_root', content: '根', importance: 1 });
    for (let i = 0; i < 205; i += 1) {
      const id = `fact_p${String(i).padStart(3, '0')}`;
      insertFact(db, { id, content: `邻居 ${i}` });
      insertEdge(db, 'fact_root', id, 'depends_on');
    }
    const app = await makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/graph/neighbors/fact_root',
      headers: { 'x-moshi-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<NeighborBody>();
    expect(body.truncated).toBe(true);
    expect(body.nodes).toHaveLength(201); // 根 + 200
    expect(body.nodes[1]?.id).toBe('fact_p000');
    expect(body.edges).toHaveLength(200);
  });

  it('只含可见邻居（active/disputed）：归档邻居与其边都被剔除，失效边不算', async () => {
    const db = freshDb();
    seedThree(db);
    insertFact(db, { id: 'fact_disp', epistemicStatus: 'disputed', content: '有争议' });
    insertFact(db, { id: 'fact_arch2', epistemicStatus: 'archived', content: '归档邻居' });
    insertFact(db, { id: 'fact_inv', content: '失效边对端' });
    insertEdge(db, 'fact_a', 'fact_disp', 'logic');
    insertEdge(db, 'fact_a', 'fact_arch2', 'depends_on');
    insertEdge(db, 'fact_a', 'fact_inv', 'depends_on', '2020-01-01T00:00:00.000Z');
    const app = await makeApp(db);
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/graph/neighbors/fact_a',
        headers: { 'x-moshi-token': TOKEN },
      })
    ).json<NeighborBody>();
    const ids = body.nodes.map((n) => n.id);
    expect(ids).toContain('fact_disp');
    expect(ids).not.toContain('fact_arch2');
    expect(ids).not.toContain('fact_inv');
    expect(body.edges.map((e) => e.dst)).toEqual(['fact_b', 'fact_disp']);
  });

  it('邻居不需要 layout 坐标也能返回（adjacency 只读边表）', async () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_x', content: 'x' });
    insertFact(db, { id: 'fact_y', content: 'y' });
    insertEdge(db, 'fact_x', 'fact_y', 'logic');
    const app = await makeApp(db);
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/graph/neighbors/fact_x',
        headers: { 'x-moshi-token': TOKEN },
      })
    ).json<NeighborBody>();
    expect(body.nodes.map((n) => n.id)).toEqual(['fact_x', 'fact_y']);
  });

  it('同权重邻居按 id 升序，两次调用逐行一致', async () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_root', content: '根' });
    for (const id of ['fact_z', 'fact_m', 'fact_a']) {
      insertFact(db, { id, content: id });
      insertEdge(db, 'fact_root', id, 'depends_on');
    }
    const app = await makeApp(db);
    const url = '/api/graph/neighbors/fact_root?depth=2';
    const first = (
      await app.inject({ method: 'GET', url, headers: { 'x-moshi-token': TOKEN } })
    ).json<NeighborBody>();
    const second = (
      await app.inject({ method: 'GET', url, headers: { 'x-moshi-token': TOKEN } })
    ).json<NeighborBody>();
    expect(first.nodes.map((n) => n.id)).toEqual(['fact_root', 'fact_a', 'fact_m', 'fact_z']);
    expect(second).toEqual(first);
  });

  it('无 token 直接 401', async () => {
    const app = await makeApp(freshDb());
    const res = await app.inject({ method: 'GET', url: '/api/graph/neighbors/fact_a' });
    expect(res.statusCode).toBe(401);
  });
});
