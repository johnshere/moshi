/**
 * P3-05 训练样本构造（详设 §7.4）。
 *
 * 验收口径：
 * - AC-1 已回填 outcome 的裁决全部成样本，`label_kind='overturn'`，label 1/0；
 * - AC-2 未回填 outcome 的裁决不进样本（没有标签就没有样本）；
 * - AC-3 feedback 只产出 `label_kind='rank'`（adopt=1/correct=0.5/reject=0），
 *        且**任何** feedback 都不得产出 overturn 样本（循环标签不能训 overturn 头）；
 * - AC-4 幂等：重跑 created=0、总行数不变；
 * - AC-5 `--since` 严格晚于该时间（与详设原 SQL 的 `>` 一致）；
 * - AC-6 dryRun 不写库，但返回"本会写多少条"；
 * - AC-7 `created_at` 取来源时间（outcome_at / ts），`used_at` 保持 NULL。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTrainingSamples, adjudicationSampleId } from '../../src/core/lifecycle/train-samples.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { openAdjudication, resolveAdjudication } from '../../src/infra/sqlite/adjudicationRepo.js';
import { insertFeedback } from '../../src/infra/sqlite/feedbackRepo.js';
import { countSamples, listSamples } from '../../src/infra/sqlite/trainingSampleRepo.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-p305-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** `feedback.fact_id` 有外键，先补一条最小 fact 行（attrs 必须带 frozen，见 DDL CHECK） */
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

function feedback(
  db: Db,
  input: { queryId: string | null; factId: string; verdict: 'adopt' | 'correct' | 'reject'; ts: string },
): void {
  ensureFact(db, input.factId);
  insertFeedback(db, input);
}

/** 造一条已裁决的 adjudication（outcome 由写入侧回填，这里直接调用仓储补上） */
function decidedAdjudication(
  db: Db,
  opts: { factIds: string[]; outcome: 'upheld' | 'overturned'; at: string; queryId?: string },
): string {
  const id = openAdjudication(db, {
    kind: 'mutex_win',
    factIds: opts.factIds,
    decidedBy: 'mutex_by_confidence@2',
    decidedAt: opts.at,
    queryId: opts.queryId ?? null,
  });
  resolveAdjudication(db, id, opts.outcome, null, opts.at);
  return id;
}

describe('buildTrainingSamples（P3-05）', () => {
  it('AC-1：已裁决的 adjudication 全部成 overturn 样本，label 1/0', () => {
    const db = freshDb();
    const overId = decidedAdjudication(db, {
      factIds: ['f_a', 'f_b'],
      outcome: 'overturned',
      at: '2026-11-01T00:00:00.000Z',
      queryId: 'q_1',
    });
    const upId = decidedAdjudication(db, {
      factIds: ['f_c', 'f_d'],
      outcome: 'upheld',
      at: '2026-11-01T01:00:00.000Z',
    });

    const result = buildTrainingSamples(db);

    expect(result.adjudication).toEqual({ scanned: 2, created: 2 });
    const rows = listSamples(db, { source: 'adjudication' });
    expect(rows.map((r) => r.id)).toEqual([adjudicationSampleId(overId), adjudicationSampleId(upId)]);
    expect(rows[0]).toMatchObject({
      labelKind: 'overturn',
      label: 1,
      factIds: ['f_a', 'f_b'],
      queryId: 'q_1',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({ label: 0, factIds: ['f_c', 'f_d'], queryId: null });
  });

  it('AC-2：未回填 outcome 的裁决不进样本', () => {
    const db = freshDb();
    openAdjudication(db, { kind: 'mutex_win', factIds: ['f_x', 'f_y'], decidedBy: 'mutex_by_confidence@2' });

    const result = buildTrainingSamples(db);

    expect(result.adjudication).toEqual({ scanned: 0, created: 0 });
    expect(countSamples(db)).toBe(0);
  });

  it('AC-3：feedback 只产出 rank 样本，verdict → 1/0.5/0', () => {
    const db = freshDb();
    feedback(db, { queryId: 'q_1', factId: 'f_a', verdict: 'adopt', ts: '2026-11-02T00:00:00.000Z' });
    feedback(db, { queryId: 'q_1', factId: 'f_b', verdict: 'correct', ts: '2026-11-02T00:01:00.000Z' });
    feedback(db, { queryId: 'q_1', factId: 'f_c', verdict: 'reject', ts: '2026-11-02T00:02:00.000Z' });

    const result = buildTrainingSamples(db);

    expect(result.feedback).toEqual({ scanned: 3, created: 3 });
    const rows = listSamples(db, { source: 'feedback' });
    expect(rows.map((r) => [r.factIds[0], r.labelKind, r.label])).toEqual([
      ['f_a', 'rank', 1],
      ['f_b', 'rank', 0.5],
      ['f_c', 'rank', 0],
    ]);
    // 循环标签绝不许进 overturn 头
    expect(countSamples(db, { source: 'feedback', labelKind: 'overturn' })).toBe(0);
  });

  it('AC-4：重跑幂等，样本不复制', () => {
    const db = freshDb();
    decidedAdjudication(db, { factIds: ['f_a', 'f_b'], outcome: 'overturned', at: '2026-11-03T00:00:00.000Z' });
    feedback(db, { queryId: 'q_1', factId: 'f_a', verdict: 'adopt', ts: '2026-11-03T00:00:00.000Z' });

    const first = buildTrainingSamples(db);
    const second = buildTrainingSamples(db);

    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(second.adjudication.scanned).toBe(1);
    expect(second.feedback.scanned).toBe(1);
    expect(countSamples(db)).toBe(2);
  });

  it('AC-5：--since 严格晚于该时间', () => {
    const db = freshDb();
    decidedAdjudication(db, { factIds: ['f_old'], outcome: 'upheld', at: '2026-11-01T00:00:00.000Z' });
    decidedAdjudication(db, { factIds: ['f_new'], outcome: 'overturned', at: '2026-11-05T00:00:00.000Z' });
    feedback(db, { queryId: null, factId: 'f_old', verdict: 'reject', ts: '2026-11-01T00:00:00.000Z' });
    feedback(db, { queryId: null, factId: 'f_new', verdict: 'adopt', ts: '2026-11-05T00:00:00.000Z' });

    const result = buildTrainingSamples(db, { since: '2026-11-01T00:00:00.000Z' });

    expect(result.adjudication).toEqual({ scanned: 1, created: 1 });
    expect(result.feedback).toEqual({ scanned: 1, created: 1 });
    // 恰好等于 since 的边界行（f_old）被排除
    expect(listSamples(db).map((r) => r.factIds[0])).toEqual(['f_new', 'f_new']);
  });

  it('AC-6：dryRun 不写库，但报出本会写多少条', () => {
    const db = freshDb();
    decidedAdjudication(db, { factIds: ['f_a'], outcome: 'overturned', at: '2026-11-04T00:00:00.000Z' });
    feedback(db, { queryId: null, factId: 'f_a', verdict: 'adopt', ts: '2026-11-04T00:00:00.000Z' });

    const preview = buildTrainingSamples(db, { dryRun: true });

    expect(preview).toMatchObject({
      dryRun: true,
      adjudication: { scanned: 1, created: 1 },
      feedback: { scanned: 1, created: 1 },
      created: 2,
    });
    expect(countSamples(db)).toBe(0);

    // 真有样本之后 dryRun 的 created 归零（说明它数的是"新增"而不是"扫到"）
    buildTrainingSamples(db);
    expect(buildTrainingSamples(db, { dryRun: true }).created).toBe(0);
    expect(countSamples(db)).toBe(2);
  });

  it('AC-7：created_at 取来源时间，used_at 为空', () => {
    const db = freshDb();
    decidedAdjudication(db, { factIds: ['f_a'], outcome: 'upheld', at: '2026-11-06T08:00:00.000Z' });
    feedback(db, { queryId: null, factId: 'f_a', verdict: 'adopt', ts: '2026-11-06T09:00:00.000Z' });

    buildTrainingSamples(db);

    const rows = listSamples(db);
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-11-06T08:00:00.000Z', '2026-11-06T09:00:00.000Z']);
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
    expect(countSamples(db, { unusedOnly: true })).toBe(2);
  });
});
