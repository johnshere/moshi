/**
 * I-49（P3-A9）：`adjudication.outcome` 的真实写入方。
 *
 * 语义：裁决快照只记录"规则在 t 时刻押注了哪条事实"（favored），
 * `outcome` 由**写入侧的新观测**回填，读取侧仍然只开裁决：
 *   - favored 被再次观测（case B refresh）        → upheld，evidence=favored fact
 *   - favored 被后续 single-valued 新值失效（case D）→ overturned，evidence=新 fact
 *   - 非 favored 的刷新/失效证据不足               → 保持 open，不猜
 *
 * 覆盖验收 AC-2 / AC-3 / AC-4：
 * - mutex_win 用真实 `adjudicate` 产生，不伪造；
 * - outcome 只写一次（`outcome IS NULL`），重复观测不覆盖；
 * - `openAdjudicationOnce` 落库保留传入顺序、仍按集合去重；
 * - `findMutexWin` 兼容原序与历史排序两种存储。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cardinality } from '../../src/domain/enums.js';
import { valueHash } from '../../src/domain/hash.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { getFact, insertFact, invalidate, listByIds } from '../../src/infra/sqlite/factRepo.js';
import {
  favoredFactId,
  findMutexWin,
  getAdjudication,
  listOpenAdjudicationsForFact,
  openAdjudication,
  openAdjudicationOnce,
  resolveAdjudication,
} from '../../src/infra/sqlite/adjudicationRepo.js';
import { adjudicate } from '../../src/core/read/adjudicate.js';
import { upsertFact, type FactDraft } from '../../src/core/write/harvest.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-i49-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 只登记 ontology（读取期 ② 判互斥的唯一依据），不走 schema infer */
function registerSingleValued(db: Db, name: string): void {
  db.prepare(
    `INSERT INTO ontology (kind, name, cardinality, registered_at, promoted)
     VALUES ('predicate', ?, 'single-valued', '2026-10-01T00:00:00.000Z', 0)`,
  ).run(name);
}

function countAdjudications(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM adjudication').get() as { n: number }).n;
}

interface UpsertOpts {
  subject?: string;
  predicate?: string;
  confidence?: number;
  cardinality?: Cardinality;
  validAt?: string;
}

function upsertValue(db: Db, value: string, opts: UpsertOpts = {}) {
  const subject = opts.subject ?? 'pkg_x';
  const predicate = opts.predicate ?? 'port_state';
  const draft: FactDraft = {
    subject,
    etype: 'pkg',
    predicate,
    value,
    content: `${predicate} ${subject} = ${value}`,
    confidence: opts.confidence ?? 0.9,
    confidenceSource: 'tool_obs',
    ...(opts.cardinality === undefined ? {} : { cardinality: opts.cardinality }),
    ...(opts.validAt === undefined ? {} : { validAt: opts.validAt }),
  };
  return upsertFact(db, draft);
}

/**
 * 手工插一条同 identity、不同 value 的 active fact（模拟"另一轮观测"）。
 * 走 upsert 会触发单值失效，互斥场景必须先让它们并存，所以这里用仓储直插。
 */
function insertRivalFact(db: Db, winnerId: string, confidence: number, value: string): string {
  const winner = getFact(db, winnerId);
  if (winner === null) throw new Error(`winner ${winnerId} 不存在`);
  const id = `f_rival_${value}`;
  insertFact(db, {
    id,
    content: `rival ${value}`,
    ftype: 'semantic',
    confidence,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs: {
      frozen: {
        subject: { entity_id: winner.attrs.frozen.subject.entity_id, name: winner.attrs.frozen.subject.name },
        predicate: winner.attrs.frozen.predicate,
        value,
      },
      ext: {},
    },
    canonicalKey: winner.canonicalKey,
    valueHash: valueHash(value),
    scope: winner.scope,
    supersededBy: null,
    validAt: '2026-10-02T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-10-02T00:00:00.000Z',
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: '2026-10-02T00:00:00.000Z',
    sourceEpisode: null,
    span: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  });
  return id;
}

/** AC-2 前置：真实 adjudicate 开出一条 open 的 mutex_win，返回 [裁决 id, winner, loser] */
function openRealMutex(db: Db): { adjId: string; winnerId: string; loserId: string } {
  const created = upsertValue(db, 'open', {
    confidence: 0.95,
    cardinality: 'set',
    validAt: '2026-10-01T00:00:00.000Z',
  });
  const winnerId = created.factId;
  const loserId = insertRivalFact(db, winnerId, 0.6, 'closed');
  registerSingleValued(db, 'port_state');

  const res = adjudicate(db, listByIds(db, [winnerId, loserId]), [], { now: '2026-11-01T00:00:00.000Z' });
  expect(res.adjudicationWrites).toBe(1);

  const open = listOpenAdjudicationsForFact(db, winnerId);
  expect(open).toHaveLength(1);
  const adjId = open[0]!.id;
  expect(open[0]!.kind).toBe('mutex_win');
  expect(open[0]!.factIds).toEqual([winnerId, loserId]);
  // 新的有序标记版本：写入侧才敢据此判 favored
  expect(open[0]!.decidedBy).toBe('mutex_by_confidence@2');
  expect(favoredFactId(open[0]!)).toBe(winnerId);
  return { adjId, winnerId, loserId };
}

describe('I-49 adjudication.outcome 回填', () => {
  it('AC-2：favored winner 被再次观测 → upheld，且只写一次', () => {
    const db = freshDb();
    const { adjId, winnerId } = openRealMutex(db);
    expect(getAdjudication(db, adjId)!.outcome).toBeNull();

    // 与 winner 同值的重复观测（case B refresh）
    const refreshed = upsertValue(db, 'open', { confidence: 0.9 });
    expect(refreshed.outcome).toBe('refreshed');
    expect(refreshed.factId).toBe(winnerId);

    const row = getAdjudication(db, adjId)!;
    expect(row.outcome).toBe('upheld');
    expect(row.outcomeEvidence).toBe(winnerId);
    expect(row.outcomeAt).not.toBeNull();
    const at = row.outcomeAt;

    // 重复观测不再覆盖已 resolved 的裁决，也不新增裁决行
    upsertValue(db, 'open', { confidence: 0.9 });
    const again = getAdjudication(db, adjId)!;
    expect(again.outcome).toBe('upheld');
    expect(again.outcomeAt).toBe(at);
    expect(countAdjudications(db)).toBe(1);
  });

  it('AC-2：single-valued 新值使 favored winner 失效 → overturned，evidence=新 fact', () => {
    const db = freshDb();
    const { adjId, winnerId, loserId } = openRealMutex(db);

    const third = upsertValue(db, 'broken', {
      cardinality: 'single-valued',
      validAt: '2026-11-05T00:00:00.000Z',
    });
    expect(third.outcome).toBe('superseded');
    expect(third.conflict.invalidated).toEqual(expect.arrayContaining([winnerId, loserId]));

    const row = getAdjudication(db, adjId)!;
    expect(row.outcome).toBe('overturned');
    expect(row.outcomeEvidence).toBe(third.factId);
    expect(row.outcomeAt).toBe('2026-11-05T00:00:00.000Z');

    // 再观测这个新值：mutex 裁决已 resolved，不被改写
    upsertValue(db, 'broken', {
      cardinality: 'single-valued',
      validAt: '2026-11-05T00:00:00.000Z',
    });
    expect(getAdjudication(db, adjId)).toEqual(row);
  });

  it('AC-2：非 favored 的 loser 被刷新时不写 outcome', () => {
    const db = freshDb();
    const { adjId, loserId } = openRealMutex(db);

    // loser 的 value 是 'closed'，同值刷新（case B）但它不是 favored
    const refreshed = upsertValue(db, 'closed', { confidence: 0.6 });
    expect(refreshed.outcome).toBe('refreshed');
    expect(refreshed.factId).toBe(loserId);
    expect(getAdjudication(db, adjId)!.outcome).toBeNull();
  });

  it('legacy @1 排序行顺序已丢：refresh / 失效都不写 outcome（保持 open，不猜）', () => {
    const db = freshDb();
    const created = upsertValue(db, 'open', {
      confidence: 0.95,
      cardinality: 'set',
      validAt: '2026-10-01T00:00:00.000Z',
    });
    const factId = created.factId;
    // I-49 之前的落库口径：排序 JSON，stored[0] 可能就是真 loser
    db.prepare(
      `INSERT INTO adjudication (id, kind, fact_ids, decided_by, decided_at, outcome, outcome_at,
                                 outcome_evidence, query_id)
       VALUES (?, 'mutex_win', ?, 'mutex_by_confidence@1', ?, NULL, NULL, NULL, NULL)`,
    ).run('aj_legacy_mutex', JSON.stringify([factId, 'f_legacy_other']), '2026-10-01T00:00:00.000Z');

    const open = listOpenAdjudicationsForFact(db, factId);
    expect(open.find((r) => r.id === 'aj_legacy_mutex')?.decidedBy).toBe('mutex_by_confidence@1');
    expect(favoredFactId(open.find((r) => r.id === 'aj_legacy_mutex')!)).toBeNull();

    // 刷新 legacy stored[0]：若按位置猜 favored 会误写 upheld
    upsertValue(db, 'open', { confidence: 0.9 });
    expect(getAdjudication(db, 'aj_legacy_mutex')!.outcome).toBeNull();

    // 被 single-valued 新值失效：同样不写 overturned
    const third = upsertValue(db, 'broken', {
      cardinality: 'single-valued',
      validAt: '2026-11-05T00:00:00.000Z',
    });
    expect(third.conflict.invalidated).toContain(factId);
    expect(getAdjudication(db, 'aj_legacy_mutex')!.outcome).toBeNull();
  });

  it('AC-3：temporal_invalidate 的 favored=[1]；refresh 新值 → upheld，旧值刷新不动', () => {
    const db = freshDb();
    const oldF = upsertValue(db, 'v1', { cardinality: 'set', validAt: '2026-10-01T00:00:00.000Z' });
    const newF = upsertValue(db, 'v2', { cardinality: 'set', validAt: '2026-10-02T00:00:00.000Z' });
    expect(newF.outcome).toBe('coexist');

    const adjId = openAdjudication(db, {
      kind: 'temporal_invalidate',
      factIds: [oldF.factId, newF.factId],
      decidedBy: 'test_rule@1',
      decidedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(getAdjudication(db, adjId)!.outcome).toBeNull();

    // 非 favored（旧值）被刷新：证据不足，保持 open
    upsertValue(db, 'v1', { validAt: '2026-10-01T00:00:00.000Z' });
    expect(getAdjudication(db, adjId)!.outcome).toBeNull();

    // favored（新值）被再次观测 → upheld
    upsertValue(db, 'v2', { validAt: '2026-10-02T00:00:00.000Z' });
    const row = getAdjudication(db, adjId)!;
    expect(row.outcome).toBe('upheld');
    expect(row.outcomeEvidence).toBe(newF.factId);
  });

  it('case C（复活）不写 outcome：当前实现固定既有行为（design 允许不改）', () => {
    const db = freshDb();
    const oldF = upsertValue(db, 'v1', { cardinality: 'set', validAt: '2026-10-01T00:00:00.000Z' });
    const newF = upsertValue(db, 'v2', { cardinality: 'set', validAt: '2026-10-02T00:00:00.000Z' });
    // favored=旧值：仅用于固定"复活不写"的行为，不涉及读取期 winner 语义
    const adjId = openAdjudication(db, {
      kind: 'temporal_invalidate',
      factIds: [newF.factId, oldF.factId],
      decidedBy: 'test_rule@1',
    });
    // 手工失效旧行（绕过 conflict policy，让裁决保持 open）
    invalidate(db, oldF.factId, { validTo: '2026-10-05T00:00:00.000Z', supersededBy: newF.factId });

    const revived = upsertValue(db, 'v1', { cardinality: 'set', validAt: '2026-10-06T00:00:00.000Z' });
    expect(revived.outcome).toBe('recreated');
    expect(revived.factId).not.toBe(oldF.factId);
    expect(getAdjudication(db, adjId)!.outcome).toBeNull();
  });

  it('AC-3：temporal_invalidate 的 favored 被第三值失效 → overturned', () => {
    const db = freshDb();
    const oldF = upsertValue(db, 'v1', { cardinality: 'set', validAt: '2026-10-01T00:00:00.000Z' });
    const newF = upsertValue(db, 'v2', { cardinality: 'set', validAt: '2026-10-02T00:00:00.000Z' });
    const adjId = openAdjudication(db, {
      kind: 'temporal_invalidate',
      factIds: [oldF.factId, newF.factId],
      decidedBy: 'test_rule@1',
      decidedAt: '2026-10-02T00:00:00.000Z',
    });

    const third = upsertValue(db, 'v3', {
      cardinality: 'single-valued',
      validAt: '2026-11-05T00:00:00.000Z',
    });
    expect(third.conflict.invalidated).toEqual(expect.arrayContaining([oldF.factId, newF.factId]));

    const row = getAdjudication(db, adjId)!;
    expect(row.outcome).toBe('overturned');
    expect(row.outcomeEvidence).toBe(third.factId);
    expect(row.outcomeAt).toBe('2026-11-05T00:00:00.000Z');
  });

  it('AC-4：openAdjudicationOnce 落库保留传入顺序、仍按集合去重', () => {
    const db = freshDb();
    expect(
      openAdjudicationOnce(db, { kind: 'mutex_win', factIds: ['f_b', 'f_a'], decidedBy: 'mutex_by_confidence@2' }),
    ).toBe(true);

    const rows = listOpenAdjudicationsForFact(db, 'f_b');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.factIds).toEqual(['f_b', 'f_a']);
    expect(rows[0]!.decidedBy).toBe('mutex_by_confidence@2');

    // 反向再开：集合键相同 → 去重，不新增，且原序不被改写
    expect(
      openAdjudicationOnce(db, { kind: 'mutex_win', factIds: ['f_a', 'f_b'], decidedBy: 'mutex_by_confidence@2' }),
    ).toBe(false);
    expect(countAdjudications(db)).toBe(1);
    expect(listOpenAdjudicationsForFact(db, 'f_a')[0]!.factIds).toEqual(['f_b', 'f_a']);
  });

  it('AC-4：findMutexWin 兼容原序与历史排序两种存储', () => {
    const db = freshDb();
    // 新一代存储：原序 [winner, loser]，decidedBy 为 @2
    openAdjudication(db, {
      kind: 'mutex_win',
      factIds: ['f_win', 'f_lose'],
      decidedBy: 'mutex_by_confidence@2',
      decidedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(findMutexWin(db, ['f_win', 'f_lose'])).not.toBeNull();
    expect(findMutexWin(db, ['f_lose', 'f_win'])).not.toBeNull();

    // 历史存储：排序后的 JSON（I-49 之前 openAdjudicationOnce 的落库口径）
    db.prepare(
      `INSERT INTO adjudication (id, kind, fact_ids, decided_by, decided_at, outcome, outcome_at,
                                 outcome_evidence, query_id)
       VALUES (?, 'mutex_win', ?, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run('aj_legacy_sorted', JSON.stringify(['f_c', 'f_d']), 'legacy_mutex@1', '2026-10-01T00:00:00.000Z');
    expect(findMutexWin(db, ['f_d', 'f_c'])).toMatchObject({ decidedBy: 'legacy_mutex@1' });

    // 非 mutex_win 不算互斥裁决
    openAdjudication(db, {
      kind: 'temporal_invalidate',
      factIds: ['f_c', 'f_e'],
      decidedBy: 'single_valued_supersede@1',
      decidedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(findMutexWin(db, ['f_c', 'f_e'])).toBeNull();
  });

  it('listOpenAdjudicationsForFact 只取 open，且 fact id 按字面量匹配（LIKE 元字符转义）', () => {
    const db = freshDb();
    const id = openAdjudication(db, {
      kind: 'temporal_invalidate',
      factIds: ['f_a_b', 'f_zz'],
      decidedBy: 'test_rule@1',
    });

    // 不同 fact id，_ 不能被当成通配符
    openAdjudication(db, {
      kind: 'temporal_invalidate',
      factIds: ['f_aXb', 'f_zz'],
      decidedBy: 'test_rule@1',
    });
    expect(listOpenAdjudicationsForFact(db, 'f_a_b').map((r) => r.id)).toEqual([id]);

    // 已 resolved 不再算 open
    resolveAdjudication(db, id, 'upheld', 'f_zz', '2026-11-01T00:00:00.000Z');
    expect(listOpenAdjudicationsForFact(db, 'f_a_b')).toEqual([]);
  });

  it('favoredFactId 按 kind 取位；mutex_win 仅 @2 有序版本可信；dependency_hold 无 favored', () => {
    // @2 = 落库保留 winner/loser 原序，favored 可信
    expect(favoredFactId({ kind: 'mutex_win', factIds: ['w', 'l'], decidedBy: 'mutex_by_confidence@2' })).toBe('w');
    // @1/legacy 顺序已丢 → 不猜
    expect(favoredFactId({ kind: 'mutex_win', factIds: ['w', 'l'], decidedBy: 'mutex_by_confidence@1' })).toBeNull();
    expect(favoredFactId({ kind: 'mutex_win', factIds: ['w', 'l'], decidedBy: 'legacy_rule@0' })).toBeNull();
    // 未提供 decidedBy（旧单测直调口径）保持原行为
    expect(favoredFactId({ kind: 'mutex_win', factIds: ['w', 'l'] })).toBe('w');
    expect(favoredFactId({ kind: 'mutex_win', factIds: [] })).toBeNull();
    // temporal_invalidate 与版本无关，favored 恒为 [1]
    expect(favoredFactId({ kind: 'temporal_invalidate', factIds: ['old', 'new'], decidedBy: 'x@1' })).toBe('new');
    expect(favoredFactId({ kind: 'dependency_hold', factIds: ['a', 'b'] })).toBeNull();

    const db = freshDb();
    const created = upsertValue(db, 'open', { cardinality: 'set' });
    const adjId = openAdjudication(db, {
      kind: 'dependency_hold',
      factIds: [created.factId],
      decidedBy: 'dep_rule@1',
    });
    upsertValue(db, 'open', { cardinality: 'set' });
    expect(getAdjudication(db, adjId)!.outcome).toBeNull();
  });
});
