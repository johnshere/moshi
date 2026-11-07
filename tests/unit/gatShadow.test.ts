/**
 * P3-07 shadow 打分与埋点。
 *
 * 不变式（详设 §4.7 硬约束）：
 * - `shadow` 只记录，**不改变证据包顺序**（`rank_final == rank_symbolic`）；
 * - 打分失败绝不失败查询，只补 `degraded[]`；
 * - `stage_ms_json` 增加 `subgraph_nodes`（§7.6 门槛 2）与 `model_ms`；
 * - `fused_json` 按节点带 `model_delta` / `overturn_prob`（未打分的行不带）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { searchWithPipeline, type ModelScoreFn, type SearchRuntime } from '../../src/core/read/search.js';
import { insertFact } from '../fixtures/factories.js';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-gat-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function seed(db: Db): void {
  insertFact(db, { content: 'alpha one' });
  insertFact(db, { content: 'alpha two' });
  insertFact(db, { content: 'alpha three' });
  syncMissingFts(db);
}

/** 每个节点给固定分，便于断言「入埋点但不入排序」 */
const fakeScore: ModelScoreFn = async (payload) => ({
  scores: payload.nodes.map((n) => ({ fact_id: n.fact_id, delta: 0.05, overturn_prob: 0.2 })),
  modelVersion: 'gat-v1@test',
  degraded: [],
});

function lastQueryRow(db: Db): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM query_log ORDER BY rowid DESC LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) throw new Error('没有 query_log 行');
  return row;
}

describe('searchWithPipeline · GAT shadow（P3-07）', () => {
  it('不注入 score：行为与 off 一致，仍记录 subgraph_nodes', async () => {
    const db = freshDb();
    seed(db);
    const rt: SearchRuntime = { db, gatMode: 'off' };
    const out = await searchWithPipeline(rt, { query: 'alpha', scope: 'global', topK: 10 });

    expect(out.pack.evidence.length).toBe(3);
    expect(out.stageMs['model_ms']).toBeUndefined();
    expect(out.stageMs['subgraph_nodes']).toBeGreaterThanOrEqual(3);
    const row = lastQueryRow(db);
    const fused = JSON.parse(String(row['fused_json'])) as { model_delta?: number }[];
    expect(fused.every((f) => f.model_delta === undefined)).toBe(true);
  });

  it('shadow 打分：排序不变，fused_json 带模型分，trace 带模型版本', async () => {
    const db = freshDb();
    seed(db);
    const base = await searchWithPipeline({ db, gatMode: 'off' }, { query: 'alpha', scope: 'global', topK: 10 });
    const traced: string[] = [];
    const out = await searchWithPipeline(
      {
        db,
        gatMode: 'shadow',
        score: fakeScore,
        trace: {
          put: (record) => {
            traced.push(record.model_version ?? 'null');
          },
        },
      },
      { query: 'alpha', scope: 'global', topK: 10 },
    );

    // 硬约束：shadow 不改顺序
    expect(out.pack.evidence.map((e) => e.fact_id)).toEqual(base.pack.evidence.map((e) => e.fact_id));
    expect(out.stageMs['model_ms']).toBeTypeOf('number');

    const row = lastQueryRow(db);
    expect(JSON.parse(String(row['flags_json']))['gat']).toBe('shadow');
    const fused = JSON.parse(String(row['fused_json'])) as { model_delta?: number; overturn_prob?: number }[];
    expect(fused.length).toBeGreaterThan(0);
    expect(fused.every((f) => f.model_delta === 0.05 && f.overturn_prob === 0.2)).toBe(true);
    expect(traced).toEqual(['gat-v1@test']);
  });

  it('score 返回 scores=null（no_sidecar）→ 查询照常成功，degraded 带 no_sidecar', async () => {
    const db = freshDb();
    seed(db);
    const out = await searchWithPipeline(
      {
        db,
        gatMode: 'shadow',
        score: async () => ({ scores: null, modelVersion: null, degraded: ['no_sidecar'] }),
      },
      { query: 'alpha', scope: 'global', topK: 10 },
    );

    expect(out.pack.evidence.length).toBeGreaterThan(0);
    expect(out.pack.degraded).toContain('no_sidecar');
    const fused = JSON.parse(String(lastQueryRow(db)['fused_json'])) as { model_delta?: number }[];
    expect(fused.every((f) => f.model_delta === undefined)).toBe(true);
  });

  it('score 抛错 → degraded 带 no_model，查询不失败', async () => {
    const db = freshDb();
    seed(db);
    const out = await searchWithPipeline(
      {
        db,
        gatMode: 'shadow',
        score: async () => {
          throw new Error('boom');
        },
      },
      { query: 'alpha', scope: 'global', topK: 10 },
    );

    expect(out.pack.evidence.length).toBeGreaterThan(0);
    expect(out.pack.degraded).toContain('no_model');
  });

  it('gatMode=off 时即使注入 score 也不调用', async () => {
    const db = freshDb();
    seed(db);
    let called = 0;
    const out = await searchWithPipeline(
      {
        db,
        gatMode: 'off',
        score: async (payload) => {
          called += 1;
          return fakeScore(payload);
        },
      },
      { query: 'alpha', scope: 'global', topK: 10 },
    );

    expect(called).toBe(0);
    expect(out.stageMs['model_ms']).toBeUndefined();
  });
});
