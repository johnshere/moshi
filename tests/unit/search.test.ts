/**
 * 读取通路总编排单测（详设 §6.1；台账 P1-19 的 Phase 1 验收缺口）。
 *
 * 覆盖编排层自己负责的东西，不重复各分段已有单测：
 *   - 路由分流（global 只给主题概览、local 出证据）
 *   - 过滤器（scope / 生命周期 / include_history 豁免）
 *   - 缓存命中（query_id 重新生成）与写入失效（schema_rev 变化）
 *   - top_k 截断、token 预算、stageMs 累计口径
 *   - 埋点（query_log / evidence_log）
 *
 * 工厂 `insertFact` 故意绕过仓储层，不会同步 fact_fts；凡走 BM25 的用例
 * 插入后必须 `syncFts(db)`（与 tests/unit/mcp.test.ts 同一约定）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { schemaRev } from '../../src/infra/sqlite/metaRepo.js';
import * as queryLogRepo from '../../src/infra/sqlite/queryLogRepo.js';
import { newId } from '../../src/domain/ids.js';
import { searchWithPipeline, type SearchRuntime } from '../../src/core/read/search.js';
import { EvidenceCache } from '../../src/core/read/cache.js';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-search-'));
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

describe('searchWithPipeline · 局部路径', () => {
  it('BM25 出证据：m_id 连续，query_log 与 evidence_log 都落盘', async () => {
    const db = freshDb();
    insertFact(db, { content: 'alpha one' });
    insertFact(db, { content: 'alpha two' });
    insertFact(db, { content: 'beta three' });
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: 'alpha', scope: 'global', topK: 10 });

    expect(out.cached).toBe(false);
    expect(out.pack.route).toBe('local');
    expect(out.pack.evidence).toHaveLength(2);
    expect(out.pack.evidence.map((e) => e.m_id)).toEqual([1, 2]);
    for (const e of out.pack.evidence) expect(e.content).toContain('alpha');
    // 没注入 encode：向量路如实降级，不能不吭声
    expect(out.pack.degraded).toContain('no_sidecar');
    expect(out.pack.status).toBe('degraded');

    expect(queryLogRepo.countQueryLogs(db)).toBe(1);
    const resolved = queryLogRepo.resolveMIds(db, out.pack.query_id, [1, 2]);
    expect(resolved).toHaveLength(2);
  });

  it('生命周期过滤：默认只看 active，include_history 才带出 archived', async () => {
    const db = freshDb();
    insertFact(db, { content: 'gamma now' });
    insertFact(db, { content: 'gamma old', epistemicStatus: 'archived' });
    syncFts(db);

    const live = await searchWithPipeline(runtime(db), { query: 'gamma', scope: 'global' });
    expect(live.pack.evidence.map((e) => e.content)).toEqual(['gamma now']);

    const all = await searchWithPipeline(runtime(db), {
      query: 'gamma',
      scope: 'global',
      includeHistory: true,
    });
    expect(all.pack.evidence.map((e) => e.content).sort()).toEqual(['gamma now', 'gamma old']);
  });

  it('scope 过滤：跨 scope 不出证据', async () => {
    const db = freshDb();
    insertFact(db, { content: 'delta port 53000', scope: 'proj-x' });
    syncFts(db);

    const global = await searchWithPipeline(runtime(db), { query: 'delta', scope: 'global' });
    expect(global.pack.evidence).toHaveLength(0);

    const scoped = await searchWithPipeline(runtime(db), { query: 'delta', scope: 'proj-x' });
    expect(scoped.pack.evidence).toHaveLength(1);
    expect(scoped.pack.evidence[0]!.content).toContain('delta');
  });

  it('top_k 截断 + token 预算不越界', async () => {
    const db = freshDb();
    for (let i = 0; i < 12; i += 1) insertFact(db, { content: `epsilon item ${String(i)}` });
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: 'epsilon', scope: 'global', topK: 3 });
    expect(out.pack.evidence).toHaveLength(3);
    expect(out.pack.stats.tokens).toBeLessThanOrEqual(1500);
    expect(out.pack.truncated).toBe(true);
  });

  it('依赖边：子图里的 depends_on 进 dependency_summary', async () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'zeta uses 8080' });
    const b = insertFact(db, { content: 'omega lib 1.0' });
    insertEdge(db, a, b, 'depends_on');
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: 'zeta', scope: 'global' });
    expect(out.pack.evidence.map((e) => e.content)).toContain('zeta uses 8080');
    expect(out.pack.dependency_summary.length).toBeGreaterThanOrEqual(1);
  });

  it('stageMs：关键阶段都有记录，且按累计口径单调不减', async () => {
    const db = freshDb();
    insertFact(db, { content: 'eta value' });
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: 'eta', scope: 'global' });
    for (const stage of ['route', 'recognize', 'recall_vector', 'recall_bm25', 'recall_ppr', 'load', 'fuse', 'subgraph', 'adjudicate', 'pack', 'assemble']) {
      expect(out.stageMs[stage], `缺阶段 ${stage}`).toBeTypeOf('number');
    }
    const values = Object.values(out.stageMs);
    const sorted = [...values].sort((x, y) => x - y);
    expect(values).toEqual(sorted);
  });
});

describe('searchWithPipeline · 全局路径', () => {
  it('只给主题概览：evidence 恒空，无社区摘要时诚实降级', async () => {
    const db = freshDb();
    insertFact(db, { content: 'theta fact' });
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: '整体概况有哪些风险', scope: 'global' });

    expect(out.pack.route).toBe('global');
    expect(out.pack.evidence).toHaveLength(0);
    expect(out.pack.coverage).toBe('partial');
    expect(out.pack.degraded).toContain('no_summary');
    expect(out.pack.topic_hint.community_id).toBeNull();
    expect(queryLogRepo.countQueryLogs(db)).toBe(1);
  });

  it('空库：cold_start 降级，绝不报 ok + 空', async () => {
    const db = freshDb();
    const out = await searchWithPipeline(runtime(db), { query: 'node 版本是多少', scope: 'global' });
    expect(out.pack.status).toBe('degraded');
    expect(out.pack.degraded).toContain('cold_start');
    expect(out.pack.confidence_summary).toBe('none');
  });
});

describe('searchWithPipeline · 会话内缓存', () => {
  it('第二次同查询命中缓存：cached=true 且 query_id 重新生成', async () => {
    const db = freshDb();
    insertFact(db, { content: 'iota one' });
    syncFts(db);
    const cache = newCache(db);
    const rt = runtime(db, { cache });

    const first = await searchWithPipeline(rt, { query: 'iota', scope: 'global' });
    const second = await searchWithPipeline(rt, { query: 'iota', scope: 'global' });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.pack.query_id).not.toBe(first.pack.query_id);
    expect(second.pack.evidence.map((e) => e.fact_id)).toEqual(first.pack.evidence.map((e) => e.fact_id));
    // 命中也要写埋点（§6.12）
    expect(queryLogRepo.countQueryLogs(db)).toBe(2);
  });

  it('写入后 schema_rev 变化 → 缓存全清', async () => {
    const db = freshDb();
    insertFact(db, { content: 'kappa one' });
    syncFts(db);
    const cache = newCache(db);
    const rt = runtime(db, { cache });

    const first = await searchWithPipeline(rt, { query: 'kappa', scope: 'global' });
    expect(first.cached).toBe(false);

    insertFact(db, { content: 'kappa two' });
    syncFts(db);
    const second = await searchWithPipeline(rt, { query: 'kappa', scope: 'global' });
    expect(second.cached).toBe(false);
    expect(cache.size).toBe(1);
  });
});

describe('searchWithPipeline · 排序（P1-23）', () => {
  /**
   * B-3 回归：直命中 conf 0.90，图邻居 conf 0.98 但只是邻居。
   * 融合分不传 base 时 finalScore 只剩 0.30×conf + 0.15×strength，直命中在
   * 11 个邻居里排到 12 位，被 top_k=8 直接切掉。
   */
  it('直命中不被高置信邻居挤出证据包', async () => {
    const db = freshDb();
    const hit = insertFact(db, { content: 'noproxy flag required for curl', confidence: 0.9 });
    const neighbours = Array.from({ length: 11 }, (_, i) =>
      insertFact(db, { content: `build note ${String.fromCharCode(97 + i)}`, confidence: 0.98 }),
    );
    for (const n of neighbours) insertEdge(db, hit, n, 'depends_on');
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: 'noproxy', scope: 'global' });
    const ids = out.pack.evidence.map((e) => e.fact_id);
    expect(ids).toContain(hit);
    expect(ids.length).toBeLessThanOrEqual(8);
  });

  it('top_k 在装箱之前生效：返回条数不超过 top_k', async () => {
    const db = freshDb();
    const hit = insertFact(db, { content: 'noproxy flag required for curl', confidence: 0.9 });
    const n1 = insertFact(db, { content: 'build note alpha', confidence: 0.98 });
    insertEdge(db, hit, n1, 'depends_on');
    syncFts(db);

    const out = await searchWithPipeline(runtime(db), { query: 'noproxy', scope: 'global', topK: 1 });
    expect(out.pack.evidence).toHaveLength(1);
  });
});
