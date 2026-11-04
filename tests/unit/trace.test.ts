/**
 * 证据链回放单测（P2-24，详设 §4.7 / §12.2）。
 *
 * 覆盖四层：
 *   1. `buildTrace` 纯函数——schema/字段规范化、「模型未生效 ⇒ rank_symbolic==rank_final」
 *      与 hop=0 不带边；
 *   2. `TraceStore` ring buffer——满 64 淘汰最旧、recent 新→旧、get 缺失为 null；
 *   3. `searchWithPipeline` 采集——本地查询回放 seeds/hop/path/edge_mass、全局查询
 *      route=global 空 results、缓存命中不伪造 seeds；
 *   4. HTTP 与 MCP 注入——`traceRoutes` 的 200/404/400/limit 夹住，`runMemoryQuery`
 *      带 traceStore 时把 query_id 对上。
 *
 * 约定同 search.test.ts：工厂插入不碰 FTS，走 BM25 的用例必须 syncFts(db)；
 * 不注入 `trace` 的既有行为由 search.test.ts / mcp.test.ts 原有用例保证。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { schemaRev } from '../../src/infra/sqlite/metaRepo.js';
import { newId } from '../../src/domain/ids.js';
import { loadConfig } from '../../src/app/config.js';
import { searchWithPipeline, type SearchRuntime } from '../../src/core/read/search.js';
import { EvidenceCache } from '../../src/core/read/cache.js';
import { buildTrace, TraceStore, TRACE_CAPACITY, type TraceRecord } from '../../src/core/read/trace.js';
import { traceRoutes } from '../../src/app/http/routes/trace.js';
import { runMemoryQuery } from '../../src/app/mcp/query.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

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

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-trace-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 工厂写库不碰 FTS；走 BM25 的用例必须补这一步 */
function syncFts(db: Db): void {
  syncMissingFts(db);
}

function runtime(db: Db, extra: Partial<SearchRuntime> = {}): SearchRuntime {
  return { db, ...extra };
}

function newCache(db: Db): EvidenceCache {
  return new EvidenceCache({ schemaRev: () => schemaRev(db), newQueryId: () => newId('query') });
}

function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-trace-home-'));
  dirs.push(dir);
  return dir;
}

function seedRecord(store: TraceStore, queryId: string): void {
  store.put(buildTrace({ queryId, ts: 1_700_000_000_000, seeds: [], results: [] }));
}

describe('buildTrace · §4.7 契约', () => {
  it('字段名与 schema 逐字对齐；hop=0 不带 path；模型未生效强制符号排名', () => {
    const rec = buildTrace({
      queryId: 'q1',
      ts: 1_700_000_000_123,
      seeds: ['a', 'a', 'b'],
      results: [
        {
          fact_id: 'a',
          hop: 0,
          // hop=0 就是直击：即使调用方带了边也必须清掉（§4.7「未沿边」）
          path: [{ src: 'a', dst: 'b', etype: 'depends_on', mass: 0.9 }],
          fused_rank: 2,
          rank_symbolic: 1,
        },
        {
          fact_id: 'b',
          hop: 1,
          path: [{ src: 'a', dst: 'b', etype: 'depends_on', mass: 0.5 }],
          fused_rank: null,
          rank_symbolic: 2,
          rank_final: 7,
        },
      ],
    });

    expect(rec.schema).toBe('moshi-trace/1');
    expect(rec.query_id).toBe('q1');
    expect(rec.ts).toBe(1_700_000_000_123);
    expect(rec.route).toBe('local');
    expect(rec.model_mode).toBe('off');
    expect(rec.model_version).toBeNull();
    expect(rec.source).toBe('symbolic');
    expect(rec.seeds).toEqual(['a', 'b']);

    const [direct, extended] = rec.results;
    expect(direct).toBeDefined();
    expect(extended).toBeDefined();
    expect(direct!.hop).toBe(0);
    expect(direct!.path).toEqual([]);
    expect(direct!.edge_mass).toEqual([]);
    expect(direct!.fused_rank).toBe(2);
    // 模型未生效：传入的 rank_final=7 必须被符号排名覆盖
    expect(direct!.rank_final).toBe(1);
    expect(extended!.rank_final).toBe(2);
    expect(extended!.edge_mass).toEqual([0.5]);
    expect(extended!.path[0]!.mass).toBe(0.5);
  });

  it('模型生效（on）时 source=gat 且沿用模型排名；mass 夹到 0–1', () => {
    const rec = buildTrace({
      queryId: 'q2',
      ts: 0,
      modelMode: 'on',
      modelVersion: 'gat-v3',
      results: [
        {
          fact_id: 'x',
          hop: 1,
          path: [{ src: 's', dst: 'x', etype: 'depends_on', mass: 1.7 }],
          rank_symbolic: 1,
          rank_final: 3,
        },
      ],
    });
    expect(rec.source).toBe('gat');
    expect(rec.model_mode).toBe('on');
    expect(rec.model_version).toBe('gat-v3');
    expect(rec.results[0]!.rank_final).toBe(3);
    expect(rec.results[0]!.edge_mass).toEqual([1]);
  });
});

describe('TraceStore · ring buffer', () => {
  it(`容量 ${TRACE_CAPACITY}：满即淘汰最旧`, () => {
    const store = new TraceStore();
    for (let i = 0; i < TRACE_CAPACITY + 6; i += 1) seedRecord(store, `q${i}`);

    expect(store.size).toBe(TRACE_CAPACITY);
    // 淘汰 q0..q5，保留 q6..q69
    expect(store.get('q0')).toBeNull();
    expect(store.get('q5')).toBeNull();
    expect(store.get('q6')).not.toBeNull();
    expect(store.get('q69')).not.toBeNull();
    expect(store.list()[0]!.query_id).toBe('q6');
    expect(store.recent(3).map((r) => r.query_id)).toEqual(['q69', 'q68', 'q67']);
  });

  it('recent 夹在 1..capacity；重复 put 同一 query_id 移到最后；reset 清空', () => {
    const store = new TraceStore();
    for (let i = 0; i < 5; i += 1) seedRecord(store, `q${i}`);

    expect(store.recent(0)).toHaveLength(1);
    expect(store.recent(999)).toHaveLength(5);
    expect(store.recent().map((r) => r.query_id)).toEqual(['q4', 'q3', 'q2', 'q1', 'q0']);

    seedRecord(store, 'q0');
    expect(store.size).toBe(5);
    expect(store.recent(1)[0]!.query_id).toBe('q0');

    store.reset();
    expect(store.size).toBe(0);
    expect(store.recent(10)).toEqual([]);
  });
});

describe('searchWithPipeline · trace 采集', () => {
  it('本地查询：直击 hop=0、PPR 扩散 hop≥1、path/edge_mass 与证据包同序', async () => {
    const db = freshDb();
    // f1 ←(bm25 "alpha")→ 没有任何入边；f2 一跳；f3 两跳。链：f1 depends_on f2 logic f3
    const f1 = insertFact(db, { content: 'alpha postgres 16' });
    const f2 = insertFact(db, { content: 'postgres beta 16' });
    const f3 = insertFact(db, { content: 'beta gamma 16' });
    insertEdge(db, f1, f2, 'depends_on');
    insertEdge(db, f2, f3, 'logic');
    syncFts(db);

    const store = new TraceStore();
    const out = await searchWithPipeline(runtime(db, { trace: store }), {
      query: 'alpha',
      scope: 'global',
      topK: 10,
    });

    expect(out.pack.route).toBe('local');
    expect(store.size).toBe(1);
    const rec = store.get(out.pack.query_id);
    expect(rec).not.toBeNull();
    const trace = rec as TraceRecord;

    expect(trace.schema).toBe('moshi-trace/1');
    expect(trace.source).toBe('symbolic');
    expect(trace.model_mode).toBe('off');
    expect(trace.seeds).toEqual([f1]);

    // 入包顺序 == trace 顺序，rank_symbolic 就是证据包 m_id
    expect(trace.results.map((r) => r.fact_id)).toEqual(out.pack.evidence.map((e) => e.fact_id));
    expect(trace.results.map((r) => r.rank_symbolic)).toEqual(out.pack.evidence.map((e) => e.m_id));
    for (const r of trace.results) expect(r.rank_final).toBe(r.rank_symbolic);

    const byId = new Map(trace.results.map((r) => [r.fact_id, r]));
    const direct = byId.get(f1);
    expect(direct).toBeDefined();
    expect(direct!.hop).toBe(0);
    expect(direct!.path).toEqual([]);
    expect(direct!.edge_mass).toEqual([]);

    const oneHop = byId.get(f2);
    expect(oneHop).toBeDefined();
    expect(oneHop!.hop).toBe(1);
    expect(oneHop!.path).toHaveLength(1);
    expect(oneHop!.path[0]).toMatchObject({ src: f1, dst: f2, etype: 'depends_on' });
    // 种子 p = 3/(3*1+(3-1)) = 0.6，rowSum(f1)=1，w=1 → mass=0.6
    expect(oneHop!.edge_mass[0]).toBeCloseTo(0.6, 6);

    const twoHop = byId.get(f3);
    expect(twoHop).toBeDefined();
    expect(twoHop!.hop).toBe(2);
    expect(twoHop!.path.map((e) => e.dst)).toEqual([f2, f3]);
    expect(twoHop!.path.map((e) => e.src)).toEqual([f1, f2]);
    expect(twoHop!.edge_mass).toHaveLength(2);
    for (const m of [...oneHop!.edge_mass, ...twoHop!.edge_mass]) {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThanOrEqual(1);
    }
    // 融合排名单调：f1 在融合里排最前
    expect(byId.get(f1)!.fused_rank).toBe(1);
  });

  it('全局查询 route=global：seeds/results 为空但 trace 照样留一条', async () => {
    const db = freshDb();
    const store = new TraceStore();

    const out = await searchWithPipeline(runtime(db, { trace: store }), {
      query: '整体总结有哪些风险',
      scope: 'global',
    });

    expect(out.pack.route).toBe('global');
    const trace = store.get(out.pack.query_id);
    expect(trace).not.toBeNull();
    expect(trace!.route).toBe('global');
    expect(trace!.seeds).toEqual([]);
    expect(trace!.results).toEqual([]);
  });

  it('缓存命中：query_id 对上证据包，seeds 留空且全部记直击（不伪造沿边）', async () => {
    const db = freshDb();
    insertFact(db, { content: 'iota one' });
    syncFts(db);

    const store = new TraceStore();
    const cache = newCache(db);
    const rt = runtime(db, { cache, trace: store });

    const first = await searchWithPipeline(rt, { query: 'iota', scope: 'global' });
    const second = await searchWithPipeline(rt, { query: 'iota', scope: 'global' });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(store.size).toBe(2);

    const cachedTrace = store.get(second.pack.query_id);
    expect(cachedTrace).not.toBeNull();
    expect(cachedTrace!.query_id).toBe(second.pack.query_id);
    expect(cachedTrace!.query_id).not.toBe(first.pack.query_id);
    expect(cachedTrace!.seeds).toEqual([]);
    expect(cachedTrace!.results.map((r) => r.fact_id)).toEqual(
      second.pack.evidence.map((e) => e.fact_id),
    );
    for (const r of cachedTrace!.results) {
      expect(r.hop).toBe(0);
      expect(r.path).toEqual([]);
      expect(r.fused_rank).toBeNull();
    }
  });

  it('不注入 trace 时不采集，行为与既有用例一致（query_id 仍落 query_log）', async () => {
    const db = freshDb();
    insertFact(db, { content: 'kappa one' });
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: 'kappa', scope: 'global' });
    expect(out.pack.evidence).toHaveLength(1);
    expect(out.pack.query_id).toBeTruthy();
  });
});

describe('traceRoutes · HTTP 只读接口', () => {
  function buildApp(store: TraceStore) {
    const app = Fastify({ logger: false });
    app.register(traceRoutes, { prefix: '/api/trace', store });
    return app;
  }

  it('GET /api/trace/:query_id 命中返回 §4.7 原样；缺失 404 E_NOT_FOUND', async () => {
    const store = new TraceStore();
    const record = buildTrace({
      queryId: 'q-hit',
      ts: 1_700_000_000_000,
      seeds: ['a'],
      results: [{ fact_id: 'a', hop: 0, rank_symbolic: 1 }],
    });
    store.put(record);
    const app = buildApp(store);

    const hit = await app.inject({ method: 'GET', url: '/api/trace/q-hit' });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['cache-control']).toBe('no-store');
    expect(hit.json()).toEqual(record);

    const miss = await app.inject({ method: 'GET', url: '/api/trace/q-missing' });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error).toBe('E_NOT_FOUND');
    expect(miss.json().query_id).toBe('q-missing');
  });

  it('GET /api/trace 列表：新→旧、limit 缺省 20 且上限 64、非法 400', async () => {
    const store = new TraceStore();
    for (let i = 0; i < 70; i += 1) seedRecord(store, `q${i}`);
    const app = buildApp(store);

    const def = await app.inject({ method: 'GET', url: '/api/trace' });
    expect(def.statusCode).toBe(200);
    const body = def.json() as { schema: string; queries: Array<{ query_id: string }>; total: number; limit: number };
    expect(body.schema).toBe('moshi-trace/1');
    expect(body.limit).toBe(20);
    expect(body.total).toBe(TRACE_CAPACITY);
    expect(body.queries).toHaveLength(20);
    expect(body.queries[0]!.query_id).toBe('q69');
    expect(body.queries[19]!.query_id).toBe('q50');

    const clamped = await app.inject({ method: 'GET', url: '/api/trace?limit=999' });
    expect(clamped.statusCode).toBe(200);
    const clampedBody = clamped.json() as { limit: number; queries: unknown[] };
    expect(clampedBody.limit).toBe(TRACE_CAPACITY);
    expect(clampedBody.queries).toHaveLength(TRACE_CAPACITY);

    for (const bad of ['abc', '0', '-1', '1.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/trace?limit=${bad}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('E_INPUT');
    }

    const arr = await app.inject({ method: 'GET', url: '/api/trace?limit=1&limit=2' });
    expect(arr.statusCode).toBe(400);
    expect(arr.json().error).toBe('E_INPUT');
  });
});

describe('MCP 注入 · runMemoryQuery 带 traceStore', () => {
  it('记忆查询写入的 trace.query_id 与返回证据包一致', async () => {
    const db = freshDb();
    const f1 = insertFact(db, { content: 'lambda postgres 16' });
    insertFact(db, { content: 'postgres theta 16' });
    syncFts(db);

    const store = new TraceStore();
    const cfg = loadConfig({ home: tempHome() });
    const out = await runMemoryQuery({ db, cfg, traceStore: store }, {
      query: 'lambda',
      scope: 'global',
      top_k: 10,
      include_history: false,
      format: 'json',
    });

    expect(store.size).toBe(1);
    const rec = store.get(out.query_id);
    expect(rec).not.toBeNull();
    expect(rec!.seeds).toEqual([f1]);
    expect(rec!.results.length).toBe(out.evidence.length);
  });
});
