/**
 * P2-09 巩固：情景 → 语义（详设 §8.3.1、概设 §5.5.2）。
 *
 * 验收口径（台账 §4）：
 * - 同 key ≥3 条 episodic → **1 条** semantic + 每条源事实一条 `derived_from` 边；
 * - **跑两次不产生重复要点**（幂等键 = 源 id 集合指纹）；
 * - 产出的 `confidence` **不高于源均值**（且 ≤0.90）；
 * - **红线**：源事实一个字段都不改、一行都不删（概设 §5.5.4）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConsolidatedValue,
  consolidate,
  consolidatedConfidence,
  CONSOLIDATE_PROVENANCE,
  derivedFromOf,
  renderConsolidatedContent,
} from '../../src/core/lifecycle/consolidate.js';
import type { Fact } from '../../src/domain/types.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as edgeRepo from '../../src/infra/sqlite/edgeRepo.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact as seedFact, makeEntity, type FactSeed } from '../fixtures/factories.js';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-consolidate-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

interface GroupOptions {
  entityId?: string;
  name?: string;
  predicate?: string;
  status?: FactSeed['epistemicStatus'];
  confidence?: number;
}

/** 同 key 的一组 episodic 观测（同 entity + predicate，取值各不相同） */
function seedObservations(db: Db, values: readonly unknown[], opts: GroupOptions = {}): string[] {
  const entityId = opts.entityId ?? makeEntity(db, 'svc-node');
  return values.map((value) =>
    seedFact(db, {
      subject: { entity_id: entityId, name: opts.name ?? 'node' },
      predicate: opts.predicate ?? 'runtime_state',
      value,
      ftype: 'episodic',
      epistemicStatus: opts.status ?? 'active',
      ...(opts.confidence === undefined ? {} : { confidence: opts.confidence }),
    }),
  );
}

function canonicalKeyOf(db: Db, id: string): string {
  const fact = factRepo.getFact(db, id);
  expect(fact).not.toBeNull();
  return (fact as Fact).canonicalKey;
}

/** 该 key 下的全部已提炼要点（含已收口的，按 valid_at 升序） */
function derivedPoints(db: Db, canonicalKey: string): Fact[] {
  return factRepo
    .listByIdentityKey(db, canonicalKey, 'global')
    .filter((f) => f.confidenceSource === 'derived')
    .sort((a, b) => (a.validAt < b.validAt ? -1 : 1));
}

describe('纯函数口径', () => {
  it('derived_from 指纹与 id 顺序无关，不同集合必然不同', () => {
    expect(derivedFromOf(['a', 'b', 'c'])).toBe(derivedFromOf(['c', 'a', 'b']));
    expect(derivedFromOf(['a', 'b', 'c'])).not.toBe(derivedFromOf(['a', 'b', 'd']));
    expect(derivedFromOf(['a', 'b', 'c'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('聚合取值排序固定：同样的观测集合 → 同样的结构', () => {
    expect(buildConsolidatedValue(['b', 'a'])).toEqual(buildConsolidatedValue(['a', 'b']));
    expect(buildConsolidatedValue(['b', 'a'])).toEqual({
      consolidated: true,
      observations: 2,
      values: ['a', 'b'],
    });
  });

  it('confidence = min(0.90, avg(源))，绝不高于源均值', () => {
    expect(consolidatedConfidence([0.5, 0.6, 0.7])).toBe(0.6);
    // 平均 0.95 被上限压到 0.90
    expect(consolidatedConfidence([0.95, 0.95, 0.95])).toBe(0.9);
    const confs = [0.72, 0.81, 0.66, 0.9];
    const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
    expect(consolidatedConfidence(confs)).toBeLessThanOrEqual(avg);
  });

  it('正文按详设模板渲染：字符串原样、结构化取值走 canonicalJson', () => {
    expect(renderConsolidatedContent('node', 'runtime_state', ['idle', 'listening'])).toBe(
      'node 的 runtime_state 为 idle、listening（由 2 次观测归纳）',
    );
    expect(renderConsolidatedContent('node', 'port', [{ port: 7001 }])).toBe(
      'node 的 port 为 {"port":7001}（由 1 次观测归纳）',
    );
  });
});

describe('情景 → 语义（P2-09）', () => {
  it('3 条同 key episodic → 1 条要点 + 3 条 derived_from 边，confidence 不高于源均值', async () => {
    const db = freshDb();
    const ids = seedObservations(db, ['listening', 'idle', 'crashed'], { confidence: 0.7 });
    const before = ids.map((id) => factRepo.getFact(db, id));

    const res = await consolidate(db, { ratePerSec: 0 });
    expect(res).toMatchObject({ groups: 1, created: 1, skipped: 0, superseded: 0 });

    const points = derivedPoints(db, canonicalKeyOf(db, ids[0] as string));
    expect(points).toHaveLength(1);
    const point = points[0] as Fact;

    // 形状：semantic / derived / 不挂 episode / 幂等键 = 源 id 集合指纹
    expect(point.ftype).toBe('semantic');
    expect(point.confidenceSource).toBe('derived');
    expect(point.sourceEpisode).toBeNull();
    expect(point.validTo).toBeNull();
    expect(point.epistemicStatus).toBe('active');
    expect(point.attrs.ext.derived_from).toBe(derivedFromOf(ids));

    // 取值是聚合结构（否则与活跃源行撞身份唯一索引）
    expect(point.attrs.frozen.value).toEqual({
      consolidated: true,
      observations: 3,
      values: ['crashed', 'idle', 'listening'],
    });
    expect(point.content).toBe('node 的 runtime_state 为 crashed、idle、listening（由 3 次观测归纳）');

    // 置信：源均值 0.7 → 0.7；按 4 位小数为精度比较（与 strength 同一舍入口径）
    expect(point.confidence).toBe(0.7);
    const sourceAvg = before.reduce((a, f) => a + (f as Fact).confidence, 0) / before.length;
    expect(point.confidence).toBeLessThanOrEqual(Math.round(sourceAvg * 1e4) / 1e4);

    // 溯源边：要点 → 源事实，一条不少
    const edges = edgeRepo
      .neighbors(db, point.id, { etypes: ['derived_from'] })
      .filter((e) => e.src === point.id);
    expect(edges).toHaveLength(3);
    expect(new Set(edges.map((e) => e.dst))).toEqual(new Set(ids));
    for (const e of edges) expect(e.provenance).toBe(CONSOLIDATE_PROVENANCE);

    // 红线：源事实的 content/attrs/strength/状态/valid_* 一个字段都没变。
    // 唯一被动变化是 `degree`——`trg_degree_ins` 随「新增溯源边」自增，是边数的函数，
    // 不是被我们改写的观测内容（概设 §5.5.4 允许新增溯源边）。
    ids.forEach((id, i) => {
      const after = factRepo.getFact(db, id) as Fact;
      const { degree, ...rest } = after;
      const { degree: degreeBefore, ...restBefore } = before[i] as Fact;
      expect(rest).toEqual(restBefore);
      expect(degree).toBe(degreeBefore + 1);
    });
  });

  it('跑两次不产生重复要点（幂等）', async () => {
    const db = freshDb();
    const ids = seedObservations(db, ['listening', 'idle', 'crashed']);

    expect(await consolidate(db, { ratePerSec: 0 })).toMatchObject({ created: 1, skipped: 0 });
    const second = await consolidate(db, { ratePerSec: 0 });
    expect(second).toMatchObject({ groups: 1, created: 0, skipped: 1, superseded: 0 });

    expect(factRepo.countFacts(db)).toBe(4);
    expect(edgeRepo.countEdges(db, true)).toBe(3);
    expect(derivedPoints(db, canonicalKeyOf(db, ids[0] as string))).toHaveLength(1);
  });

  it('不足 3 条 / 已归档的观测都不提炼', async () => {
    const db = freshDb();
    seedObservations(db, ['listening', 'idle']);
    expect(await consolidate(db, { ratePerSec: 0 })).toMatchObject({ groups: 0, created: 0 });

    seedObservations(db, ['listening', 'idle', 'crashed'], {
      status: 'archived',
      entityId: makeEntity(db, 'svc-archived'),
    });
    expect(await consolidate(db, { ratePerSec: 0 })).toMatchObject({ groups: 0, created: 0 });
  });

  it('disputed 观测参与提炼（与详设 SQL 的 status 口径一致）', async () => {
    const db = freshDb();
    seedObservations(db, ['listening', 'idle', 'crashed'], { status: 'disputed' });
    expect(await consolidate(db, { ratePerSec: 0 })).toMatchObject({ groups: 1, created: 1 });
  });

  it('第 4 条观测到达 → 新要点产出、旧要点收口（源事实仍全部活跃）', async () => {
    const db = freshDb();
    const entityId = makeEntity(db, 'svc-node');
    const ids = seedObservations(db, ['listening', 'idle', 'crashed'], { entityId });
    const ck = canonicalKeyOf(db, ids[0] as string);
    await consolidate(db, { ratePerSec: 0 });
    const firstPoint = derivedPoints(db, ck)[0] as Fact;

    seedObservations(db, ['restarting'], { entityId });
    const res = await consolidate(db, { ratePerSec: 0 });
    expect(res).toMatchObject({ created: 1, superseded: 1 });

    const points = derivedPoints(db, ck);
    expect(points).toHaveLength(2);
    const oldPoint = factRepo.getFact(db, firstPoint.id) as Fact;
    const newPoint = points.find((f) => f.validTo === null) as Fact;
    expect(oldPoint.validTo).not.toBeNull();
    expect(oldPoint.supersededBy).toBe(newPoint.id);
    expect(oldPoint.epistemicStatus).toBe('invalidated');

    // 溯源是追加式的：旧要点的边不删，新要点给 4 条源事实各建一条
    expect(edgeRepo.countEdges(db, true)).toBe(7);

    // 4 条源事实一个都没动
    const episodic = factRepo.listByIdentityKey(db, ck, 'global').filter((f) => f.ftype === 'episodic');
    expect(episodic).toHaveLength(4);
    for (const f of episodic) {
      expect(f.validTo).toBeNull();
      expect(f.epistemicStatus).toBe('active');
    }
  });

  it('--dry-run 只统计不写库', async () => {
    const db = freshDb();
    seedObservations(db, ['listening', 'idle', 'crashed']);
    const res = await consolidate(db, { ratePerSec: 0, dryRun: true });
    expect(res).toMatchObject({ groups: 1, created: 1, superseded: 0 });
    expect(factRepo.countFacts(db)).toBe(3);
    expect(edgeRepo.countEdges(db, false)).toBe(0);
  });

  it('多组各自独立提炼；阈值可配', async () => {
    const db = freshDb();
    seedObservations(db, ['a', 'b'], {
      entityId: makeEntity(db, 'svc-a'),
      name: 'alpha',
      predicate: 'state',
    });
    seedObservations(db, ['a', 'b', 'c'], {
      entityId: makeEntity(db, 'svc-b'),
      name: 'beta',
      predicate: 'state',
    });

    // 默认阈值 3：只有 beta 够（groups 是"达到阈值的候选组数"）
    expect(await consolidate(db, { ratePerSec: 0 })).toMatchObject({ groups: 1, created: 1 });
    // 阈值降到 2：alpha 也进候选，beta 靠指纹跳过
    expect(await consolidate(db, { ratePerSec: 0, minObservations: 2 })).toMatchObject({
      groups: 2,
      created: 1,
      skipped: 1,
    });
  });
});
