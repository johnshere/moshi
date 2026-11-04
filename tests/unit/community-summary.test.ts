/**
 * P2-12 社区摘要（详设 §8.3.3；概设 §4.5「摘要只是入口不是答案」）。
 *
 * 覆盖口径（台账 §4 P2-12 / progress P2-12）：
 * - 纯函数：top-10 截断与 `importance × confidence` 排序、label 最高频实体与回退、
 *   scope 分组、输入顺序无关的确定性、content 截断；
 * - 写库：UPSERT 后 `source_rev` 必须等于**写完后的** `schema_rev`
 *   （002 触发器每写一行 +1），否则全局路径会把刚写的摘要判陈旧；
 * - 端到端：5 个社区 → 全局查询返回 5 条主题 + `moshi://topic/...` 下钻指针；
 * - dryRun 不落摘要。
 *
 * 工厂 `insertFact` 绕过仓储层（不写 FTS）；全局路径不召回事实，无需 `syncMissingFts`。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCommunitySummaries,
  fallbackSummaryLabel,
  rankSummaryFacts,
  SUMMARY_CONTENT_MAX,
  type SummaryFact,
} from '../../src/core/lifecycle/community-summary.js';
import { searchWithPipeline } from '../../src/core/read/search.js';
import { runCommunityOnce } from '../../src/app/communityRunner.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import {
  listTopSummaries,
  loadSummaryFacts,
  writeCommunitySummaries,
} from '../../src/infra/sqlite/communityRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { schemaRev } from '../../src/infra/sqlite/metaRepo.js';
import { insertEdge, insertFact, makeEntity } from '../fixtures/factories.js';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-summary-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 纯函数用例的最小 fact（字段默认值只用于让用例聚焦在被测分支上） */
function summaryFact(partial: Partial<SummaryFact> & { id: string }): SummaryFact {
  return {
    communityId: 1,
    scope: 'global',
    content: `content-${partial.id}`,
    importance: 0.5,
    confidence: 0.5,
    entityId: null,
    entityName: null,
    ...partial,
  };
}

interface SummaryRow {
  communityId: number;
  scope: string;
  label: string | null;
  summary: string;
  factCount: number;
  derivedAt: string;
  sourceRev: number;
}

function summaryRows(db: Db): SummaryRow[] {
  const rows = db
    .prepare(
      `SELECT community_id, scope, label, summary, fact_count, derived_at, source_rev
         FROM community_summary
        ORDER BY community_id, scope`,
    )
    .all() as {
    community_id: number;
    scope: string;
    label: string | null;
    summary: string;
    fact_count: number;
    derived_at: string;
    source_rev: number;
  }[];
  return rows.map((r) => ({
    communityId: r.community_id,
    scope: r.scope,
    label: r.label,
    summary: r.summary,
    factCount: r.fact_count,
    derivedAt: r.derived_at,
    sourceRev: r.source_rev,
  }));
}

/** 用固定 id 造一个节点（社团成员；label 用 makeEntity 的 canonical_name） */
function seedNode(db: Db, id: string): void {
  const entityId = makeEntity(db, `pkg-${id}`);
  insertFact(db, {
    id,
    subject: { entity_id: entityId, name: `node-${id}` },
    content: `${id} 的版本是 1.0`,
  });
}

/** 造一个 n 节点团（不含桥接边 → Louvain 每团一个社区） */
function seedClique(db: Db, prefix: string, n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);
  for (const id of ids) seedNode(db, id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) insertEdge(db, ids[i]!, ids[j]!);
  }
  return ids;
}

describe('community-summary · 纯函数拼接', () => {
  it('top-10 截断：按 importance×confidence 降序，平局 fact id 升序', () => {
    // 12 条事实：utility 随序号递增，序号越大越靠前
    const facts: SummaryFact[] = Array.from({ length: 12 }, (_, i) =>
      summaryFact({
        id: `f-${String(i).padStart(2, '0')}`,
        content: `fact-${String(i).padStart(2, '0')}`,
        importance: (i + 1) / 12,
        confidence: 1,
        entityId: 'e-1',
        entityName: 'alpha',
      }),
    );

    // 默认 3 条要点 = ranked 前 3
    const draft = buildCommunitySummaries(facts)[0]!;
    expect(draft.factCount).toBe(12);
    expect(draft.summary).toContain('fact-11');
    expect(draft.summary).toContain('②fact-10');
    expect(draft.summary).toContain('③fact-09');
    expect(draft.summary).not.toContain('fact-08');

    // 要点数调到 10：只取 top-10（fact-00/01 被截掉），证明 top-10 是硬上限
    const wide = buildCommunitySummaries(facts, { bullets: 10 })[0]!;
    expect(wide.summary).toContain('fact-02');
    expect(wide.summary).not.toContain('fact-01');
    expect(wide.summary).not.toContain('fact-00');

    // utility 平局：id 升序
    const tied = rankSummaryFacts([
      summaryFact({ id: 'f-c', importance: 0.9, confidence: 0.9 }),
      summaryFact({ id: 'f-b', importance: 0.9, confidence: 0.9 }),
      summaryFact({ id: 'f-a', importance: 0.9, confidence: 0.9 }),
    ]);
    expect(tied.map((f) => f.id)).toEqual(['f-a', 'f-b', 'f-c']);
  });

  it('label 取社区内最高频实体；没有实体可标注时回退 主题 #<id>', () => {
    const facts = [
      summaryFact({ id: 'f1', entityId: 'e-a', entityName: 'alpha', content: 'a1' }),
      summaryFact({ id: 'f2', entityId: 'e-a', entityName: 'alpha', content: 'a2' }),
      summaryFact({ id: 'f3', entityId: 'e-b', entityName: 'beta', content: 'b1' }),
    ];
    const draft = buildCommunitySummaries(facts, { bullets: 1 })[0]!;
    expect(draft.label).toBe('alpha');
    expect(draft.summary.startsWith('alpha：3 条事实，覆盖 2 个实体。要点：')).toBe(true);

    const noEntity = buildCommunitySummaries([
      summaryFact({ id: 'f9', communityId: 9, entityId: null, entityName: '  ' }),
    ])[0]!;
    expect(noEntity.label).toBe('主题 #9');
    expect(noEntity.label).toBe(fallbackSummaryLabel(9));
    expect(noEntity.summary).toContain('覆盖 0 个实体');
  });

  it('scope 分组：默认只生成 global，显式 scopes 时按 (community, scope) 分组', () => {
    const facts = [
      summaryFact({ id: 'g1', scope: 'global', content: 'g1' }),
      summaryFact({ id: 'g2', scope: 'global', content: 'g2' }),
      summaryFact({ id: 'p1', scope: 'project:x', content: 'p1' }),
    ];
    expect(buildCommunitySummaries(facts)).toHaveLength(1);
    expect(buildCommunitySummaries(facts)[0]!.factCount).toBe(2);

    const both = buildCommunitySummaries(facts, { scopes: ['global', 'project:x'] });
    expect(both.map((d) => d.scope)).toEqual(['global', 'project:x']);
    expect(both.map((d) => d.factCount)).toEqual([2, 1]);
  });

  it('确定性：输入顺序打乱得到逐字节一致的草稿', () => {
    const facts = Array.from({ length: 9 }, (_, i) =>
      summaryFact({
        id: `f-${String(i).padStart(2, '0')}`,
        communityId: (i % 3) + 1,
        scope: i % 2 === 0 ? 'global' : 'project:x',
        content: `内容 ${String(i)}`,
        importance: 0.3 + (i % 4) * 0.1,
        confidence: 0.5 + (i % 2) * 0.2,
        entityId: `e-${String(i % 4)}`,
        entityName: `ent-${String(i % 4)}`,
      }),
    );
    const forward = buildCommunitySummaries(facts, { scopes: ['global', 'project:x'] });
    const backward = buildCommunitySummaries([...facts].reverse(), {
      scopes: ['global', 'project:x'],
    });
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));

    // 重复跑也一致（拼接里没有时间/随机因子）
    expect(JSON.stringify(buildCommunitySummaries(facts, { scopes: ['global', 'project:x'] }))).toBe(
      JSON.stringify(forward),
    );
  });

  it('未归属（community_id=null）的事实不生成摘要', () => {
    expect(
      buildCommunitySummaries([summaryFact({ id: 'f1', communityId: null })]),
    ).toEqual([]);
  });

  it('content 折叠空白并截断（超出阈值加 …）', () => {
    const long = 'x'.repeat(SUMMARY_CONTENT_MAX + 20);
    const draft = buildCommunitySummaries([
      summaryFact({ id: 'f1', content: `  第一行\n\n  第二行  `, importance: 1, confidence: 1 }),
    ])[0]!;
    expect(draft.summary).toContain('①第一行 第二行');

    const cut = buildCommunitySummaries([
      summaryFact({ id: 'f2', content: long, importance: 1, confidence: 1 }),
    ])[0]!;
    const point = cut.summary.split('①')[1]!;
    expect(point.endsWith('…')).toBe(true);
    expect([...point]).toHaveLength(SUMMARY_CONTENT_MAX);
  });
});

describe('community-summary · 写库与 source_rev', () => {
  it('写入后 source_rev = 写完后的 schema_rev；重跑 UPSERT 仍保持新鲜', () => {
    const db = freshDb();
    seedClique(db, 'a', 4);
    seedClique(db, 'b', 4);
    const before = schemaRev(db);

    const first = runCommunityOnce(db);
    expect(first.summaries).toBe(2);
    const afterSummaries = schemaRev(db);
    // 两个摘要 = 2 次触发器 +1；wrote 的 fact UPDATE 不推 rev
    expect(afterSummaries).toBe(before + first.summaries);

    const rows = summaryRows(db);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.sourceRev).toBe(afterSummaries);
      expect(row.scope).toBe('global');
      expect(row.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    // 全局路径判据：sourceRev >= schemaRev → 全部新鲜
    const top = listTopSummaries(db, 'global', 10);
    expect(top).toHaveLength(2);
    for (const row of top) expect(row.sourceRev).toBeGreaterThanOrEqual(schemaRev(db));
    expect(rows.every((r) => r.label !== null)).toBe(true);

    // 重跑：事实不变，摘要内容逐字节一致，但 source_rev 跟到新的 rev
    const second = runCommunityOnce(db);
    expect(second.wrote).toBe(0);
    expect(second.summaries).toBe(2);
    const again = summaryRows(db);
    expect(again.map((r) => r.summary)).toEqual(rows.map((r) => r.summary));
    expect(again.map((r) => r.factCount)).toEqual(rows.map((r) => r.factCount));
    for (const row of again) expect(row.sourceRev).toBe(schemaRev(db));
  });

  it('全局查询能取到摘要：5 个社区 → 5 条主题 + moshi://topic 下钻指针', async () => {
    const db = freshDb();
    for (const prefix of ['a', 'b', 'c', 'd', 'e']) seedClique(db, prefix, 4);
    runCommunityOnce(db);

    const summaries = summaryRows(db);
    expect(summaries).toHaveLength(5);
    expect(summaries.every((r) => r.factCount === 4)).toBe(true);

    const out = await searchWithPipeline({ db }, { query: '整体概况有哪些风险' });
    expect(out.pack.route).toBe('global');
    expect(out.pack.evidence).toHaveLength(0);
    expect(out.pack.numbered_list).toHaveLength(5);
    expect(out.pack.numbered_list[0]).toMatch(/^\[T1\] \(4 条事实，\d{4}-\d{2}-\d{2} 起\) /);
    expect(out.pack.degraded).not.toContain('no_summary');
    expect(out.pack.coverage).toBe('full');
    expect(out.pack.stats.candidates).toBe(5);
    // 下钻指针指向第一条主题
    expect(out.pack.topic_hint.community_id).not.toBeNull();
    expect(out.pack.topic_hint.label).not.toBeNull();
    expect(out.pack.topic_hint.uri).toMatch(/^moshi:\/\/topic\/.+/);
    expect(out.pack.topic_hint.uri).toBe(`moshi://topic/${out.pack.topic_hint.label!}`);
    // 摘要文本带 n/m：「{label}：4 条事实，覆盖 4 个实体。要点：①…」
    // 团里 4 个节点各有独立主体实体，所以 m=4、label 按名称平局取最小
    expect(out.pack.numbered_list[0]).toContain('：4 条事实，覆盖 4 个实体。要点：①');
  });

  it('dryRun 只算条数不落库；空库不写摘要也不推 rev', () => {
    const db = freshDb();
    seedClique(db, 'a', 4);
    seedClique(db, 'b', 4);
    const revBefore = schemaRev(db);

    const dry = runCommunityOnce(db, { dryRun: true });
    expect(dry.summaries).toBe(2);
    expect(summaryRows(db)).toHaveLength(0);
    expect(schemaRev(db)).toBe(revBefore);

    const empty = freshDb();
    const emptyBefore = schemaRev(empty);
    const emptyRun = runCommunityOnce(empty);
    expect(emptyRun.summaries).toBe(0);
    expect(emptyRun.nodes).toBe(0);
    expect(summaryRows(empty)).toHaveLength(0);
    expect(schemaRev(empty)).toBe(emptyBefore);
  });

  it('loadSummaryFacts：只取 active/disputed，实体名优先 entity.canonical_name', () => {
    const db = freshDb();
    const entityId = makeEntity(db, 'pkg-canonical');
    insertFact(db, {
      id: 'f-active',
      value: 'v1',
      subject: { entity_id: entityId, name: 'frozen-name' },
    });
    insertFact(db, {
      id: 'f-active2',
      value: 'v2',
      subject: { entity_id: entityId, name: 'frozen-name' },
    });
    insertFact(db, { id: 'f-disputed', epistemicStatus: 'disputed' });
    insertFact(db, { id: 'f-archived', epistemicStatus: 'archived' });
    insertFact(db, { id: 'f-pruned', epistemicStatus: 'pruned' });

    const facts = loadSummaryFacts(db);
    expect(facts.map((f) => f.id).sort()).toEqual(['f-active', 'f-active2', 'f-disputed']);
    const active = facts.find((f) => f.id === 'f-active')!;
    expect(active.entityId).toBe(entityId);
    expect(active.entityName).toBe('pkg-canonical'); // entity 表胜过 frozen 里的名字
    expect(active.communityId).toBeNull();

    // 未归属事实 → 归到 7 号社区后写库；label 用 canonical_name（出现 2 次，频次最高）
    const drafts = buildCommunitySummaries(
      facts.map((f) => ({ ...f, communityId: 7 })),
    );
    const written = writeCommunitySummaries(db, drafts, '2026-01-02T03:04:05.678Z');
    expect(written).toBe(1);
    const row = summaryRows(db)[0]!;
    expect(row.label).toBe('pkg-canonical');
    expect(row.derivedAt).toBe('2026-01-02T03:04:05.678Z');
    expect(row.sourceRev).toBe(schemaRev(db));
    // 覆盖 2 个实体（canonical 主体 + f-disputed 的工厂默认主体）
    expect(row.summary).toContain('3 条事实，覆盖 2 个实体');
  });

  it('writeCommunitySummaries 空数组不写库、不推 rev', () => {
    const db = freshDb();
    const before = schemaRev(db);
    expect(writeCommunitySummaries(db, [], '2026-01-01T00:00:00.000Z')).toBe(0);
    expect(schemaRev(db)).toBe(before);
    expect(summaryRows(db)).toHaveLength(0);
  });
});
