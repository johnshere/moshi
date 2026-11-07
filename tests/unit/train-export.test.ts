/**
 * P3-06 样本导出（`moshi samples export` 的核心）。
 *
 * 覆盖：
 * - 每条样本展开成 `moshi-subgraph/2` payload，节点数 = 子图节点数；
 * - overturn 样本的 `focus_fact_id` 取 favored（mutex `@2` 的 factIds[0]），rank 样本取单条 fact；
 * - 没有向量/没有 query 向量时照样导出（embedding=null、query_vector=null），不中断；
 * - 引用的 fact 全被清 → `skipped.noNodes`，不产非法行；
 * - JSONL 一行一条，可被 Python `json.loads` 逐行消费。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTrainingSamples } from '../../src/core/lifecycle/train-samples.js';
import { exportTrainingPayloads, toJsonl } from '../../src/core/lifecycle/train-export.js';
import { SUBGRAPH_SCHEMA } from '../../src/domain/subgraph.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { openAdjudication, resolveAdjudication } from '../../src/infra/sqlite/adjudicationRepo.js';
import { insertFeedback } from '../../src/infra/sqlite/feedbackRepo.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-p306-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function ensureFact(db: Db, id: string): void {
  db.prepare(
    `INSERT INTO fact (id, content, ftype, attrs, canonical_key, value_hash,
                       valid_at, recorded_at, last_decay_at, created_at, updated_at)
     VALUES (?, ?, 'semantic', '{"frozen":{},"ext":{}}', ?, ?,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z')
     ON CONFLICT (id) DO NOTHING`,
  ).run(id, `content ${id}`, id, id);
}

describe('exportTrainingPayloads（P3-06）', () => {
  it('导出 overturn/rank 样本为 moshi-subgraph/2 payload', async () => {
    const db = freshDb();
    ensureFact(db, 'f_a');
    ensureFact(db, 'f_b');
    const adjId = openAdjudication(db, {
      kind: 'mutex_win',
      factIds: ['f_a', 'f_b'],
      decidedBy: 'mutex_by_confidence@2',
      decidedAt: '2026-11-01T00:00:00.000Z',
    });
    resolveAdjudication(db, adjId, 'overturned', null, '2026-11-01T00:00:00.000Z');
    insertFeedback(db, { queryId: null, factId: 'f_a', verdict: 'reject', ts: '2026-11-02T00:00:00.000Z' });
    buildTrainingSamples(db);

    const { records, stats } = await exportTrainingPayloads(db);

    expect(stats.scanned).toBe(2);
    expect(stats.exported).toBe(2);
    expect(stats.skipped).toEqual({ noNodes: 0, invalid: 0 });
    expect(stats.queryWithVector).toBe(0);

    const overturn = records.find((r) => r.label_kind === 'overturn');
    const rank = records.find((r) => r.label_kind === 'rank');
    expect(overturn).toBeDefined();
    expect(rank).toBeDefined();

    // favored = factIds[0]（mutex @2 有序标记）
    expect(overturn!.focus_fact_id).toBe('f_a');
    expect(overturn!.label).toBe(1);
    expect(rank!.focus_fact_id).toBe('f_a');
    expect(rank!.label).toBe(0);

    for (const r of records) {
      expect(r.payload.schema).toBe(SUBGRAPH_SCHEMA);
      expect(r.payload.nodes.length).toBeGreaterThan(0);
      expect(r.payload.query_vector).toBeNull();
      // 没有向量库时 embedding=null，payload 依然合法
      expect(r.payload.nodes.every((n) => n.embedding === null)).toBe(true);
    }
  });

  it('引用的 fact 全被清 → 计入 skipped.noNodes', async () => {
    const db = freshDb();
    ensureFact(db, 'f_a');
    insertFeedback(db, { queryId: null, factId: 'f_a', verdict: 'adopt', ts: '2026-11-02T00:00:00.000Z' });
    buildTrainingSamples(db);
    db.prepare('DELETE FROM feedback').run();
    db.prepare('DELETE FROM fact WHERE id = ?').run('f_a');

    const { records, stats } = await exportTrainingPayloads(db);

    expect(records).toHaveLength(0);
    expect(stats.scanned).toBe(1);
    expect(stats.skipped.noNodes).toBe(1);
  });

  it('queryVectors 注入成功时 query_vector 落到 payload', async () => {
    const db = freshDb();
    ensureFact(db, 'f_a');
    db.prepare(
      `INSERT INTO query_log (id, ts, query_text, query_hash, route, flags_json, latency_ms)
       VALUES ('q_1', '2026-11-01T00:00:00.000Z', '端口冲突怎么查', 'h', 'local', '{}', 1.0)`,
    ).run();
    insertFeedback(db, { queryId: 'q_1', factId: 'f_a', verdict: 'adopt', ts: '2026-11-02T00:00:00.000Z' });
    buildTrainingSamples(db);

    const { records, stats } = await exportTrainingPayloads(db, {
      queryVectors: async (texts) => texts.map(() => new Array(512).fill(0.1)),
    });

    expect(stats.queryWithText).toBe(1);
    expect(stats.queryWithVector).toBe(1);
    expect(records[0]!.payload.query_vector).toHaveLength(512);
  });

  it('toJsonl 一行一条记录', async () => {
    const db = freshDb();
    ensureFact(db, 'f_a');
    insertFeedback(db, { queryId: null, factId: 'f_a', verdict: 'adopt', ts: '2026-11-02T00:00:00.000Z' });
    buildTrainingSamples(db);
    const { records } = await exportTrainingPayloads(db);

    const jsonl = toJsonl(records);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(records.length);
    const parsed = JSON.parse(lines[0]!) as { payload: { schema: string }; label_kind: string };
    expect(parsed.payload.schema).toBe(SUBGRAPH_SCHEMA);
    expect(parsed.label_kind).toBe('rank');
    expect(toJsonl([])).toBe('');
  });
});
