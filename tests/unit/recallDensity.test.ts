/**
 * 召回密度回归（W5）。
 *
 * 背景：活动库 query_log 实测「平均子图 0.6 节点」，训练样本平均 54.5 节点，
 * GAT 密度门槛（≥20）卡死。三个机制原因，前两个在读路径、第三个是口径：
 *   1. 通道内先按 topK 截断、之后才 passFilters —— cache/invalidated 事实
 *      把 topK 名额吃光，融合池塌到个位数；
 *   2. 种子上限 8 条时若种子在图上孤立，节点数就停在 8；密度必须靠 2 跳扩展，
 *      而扩展只有「种子之外还有名额」时才发生；
 *   3. 种子上限训练与推理必须同源（SUBGRAPH_SEED_LIMIT），推理侧一旦把它放到
 *      subgraphMaxNodes，isSeed 一热分布就与训练样本（8/64）反向，2 跳也归零。
 * 本文件锁住：过滤后截断、8 种子 + 2 跳能撑起 ≥20、无 encoder 时降级码照旧、
 * 上限（maxNodes/maxEdges）照旧截断、种子上限不随 maxNodes 漂移。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { searchWithPipeline, type SearchRuntime } from '../../src/core/read/search.js';
import { buildSubgraph } from '../../src/core/read/subgraph.js';
import { recallBm25 } from '../../src/core/read/recall/bm25.js';
import { SUBGRAPH_SEED_LIMIT } from '../../src/domain/subgraph.js';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-density-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/**
 * 造 25 条 cache 事实 + 30 条 active 事实，全部命中 token `alpha`。
 * cache 的 content 把 `alpha` 重复 3 次（tf 更高 → bm25 更靠前），
 * 于是「top-20 全被 cache 占满」是确定性的，不依赖行序。
 *
 * `hub: true` 时额外造一条命中 `alpha` 的 hub 事实，把 30 条 active 全挂上去：
 * 任意 8 个种子都能 1 跳摸到 hub、2 跳摸到全部 active，从而在**种子仍是 8 条**
 * 的前提下拿到 ≥20 节点——这正是训练样本（8 种子 + 1~2 跳邻居）的形状。
 */
function seedCacheTrap(db: Db, opts: { hub?: boolean } = {}): { cache: string[]; active: string[] } {
  const cache = Array.from({ length: 25 }, (_, i) =>
    insertFact(db, { content: `alpha alpha alpha cache-${i}`, retentionClass: 'cache' }),
  );
  const active = Array.from({ length: 30 }, (_, i) => insertFact(db, { content: `alpha active-${i}` }));
  if (opts.hub === true) {
    const hub = insertFact(db, { content: 'alpha hub' });
    for (const id of active) insertEdge(db, hub, id, 'co_occur');
  }
  syncMissingFts(db);
  return { cache, active };
}

function runtime(db: Db, extra: Partial<SearchRuntime> = {}): SearchRuntime {
  return { db, ...extra };
}

const subgraphNodes = (out: { stageMs: Record<string, number> }): number =>
  out.stageMs['subgraph_nodes'] ?? -1;

describe('searchWithPipeline · 召回超取（W5 密度）', () => {
  it('recallOverfetch=1 复现旧行为：topK 被 cache 吃光，子图为 0～1', async () => {
    const db = freshDb();
    // 不带 hub 边：没有扩展可补，密度只能来自候选本身 → 旧口径塌陷暴露无遗
    seedCacheTrap(db);

    const out = await searchWithPipeline(runtime(db, { recallOverfetch: 1 }), {
      query: 'alpha',
      scope: 'global',
    });

    // 旧口径：top-20 里绝大多数是 cache，passFilters 后候选塌到个位数 → 密度 <20
    expect(out.pack.evidence.length).toBeLessThan(SUBGRAPH_SEED_LIMIT * 2);
    expect(subgraphNodes(out)).toBeLessThanOrEqual(1);
  });

  it('超取 + 8 种子 + 2 跳：同一批数据子图 ≥20 节点', async () => {
    const db = freshDb();
    seedCacheTrap(db, { hub: true });

    const out = await searchWithPipeline(runtime(db), { query: 'alpha', scope: 'global' });

    // 超取后 30+ 条 active 进入过滤，截断回 topK=20，取前 8 当种子，2 跳补满
    expect(subgraphNodes(out)).toBeGreaterThanOrEqual(20);
    expect(out.pack.evidence.length).toBeGreaterThanOrEqual(2);
    for (const e of out.pack.evidence) expect(e.content).toContain('alpha');
  });

  it('种子上限与训练同源：候选再多也只取 SUBGRAPH_SEED_LIMIT 个种子', async () => {
    const db = freshDb();
    const { active } = seedCacheTrap(db);

    const hits = recallBm25(db, 'alpha', 200).map((h) => h.fact_id);
    expect(hits.length).toBeGreaterThan(SUBGRAPH_SEED_LIMIT * 3);

    const sub = buildSubgraph(db, hits, {});
    expect(sub.nodes.filter((n) => n.isSeed)).toHaveLength(SUBGRAPH_SEED_LIMIT);
    // 没有边时扩展无处可去，节点数就是种子数——不会因为候选多而偷偷变多
    expect(sub.nodes).toHaveLength(SUBGRAPH_SEED_LIMIT);
    expect(sub.nodes.every((n) => active.includes(n.fact_id) || n.isSeed)).toBe(true);
    expect(SUBGRAPH_SEED_LIMIT).toBe(8);
  });

  it('无 encoder：降级码照旧，BM25 单路 + 2 跳扩展也能撑起 ≥20 节点', async () => {
    const db = freshDb();
    seedCacheTrap(db, { hub: true });

    // 不注入 encode = sidecar 不可用（生产里 encoder 缺失就是这个形态）
    const out = await searchWithPipeline(runtime(db), { query: 'alpha', scope: 'global' });

    expect(out.pack.degraded).toContain('no_sidecar');
    expect(subgraphNodes(out)).toBeGreaterThanOrEqual(20);
  });

  it('上限照旧截断：subgraphMaxNodes=10 时节点不超过 10', async () => {
    const db = freshDb();
    seedCacheTrap(db, { hub: true });

    const out = await searchWithPipeline(
      runtime(db, { params: { subgraphMaxNodes: 10, subgraphMaxEdges: 3 } }),
      { query: 'alpha', scope: 'global' },
    );

    expect(subgraphNodes(out)).toBeLessThanOrEqual(10);
    expect(subgraphNodes(out)).toBeGreaterThan(0);
  });
});
