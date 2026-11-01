/**
 * 事实仓储（详设 §3.3 第 3 条：生命周期字段只经专用方法）。
 *
 * 这一层是 K2 正交化的最后一道门：
 * - 业务代码**拿不到**通用的 query/exec，只能调这里列出的意图化方法；
 * - `strength` / `pool` / `access_count` / `last_access_at` 各自只有一个写入口；
 * - 改 `confidence` 必须同时写 `audit`（I10），两者在同一事务里。
 */
import { MoshiError } from '../../domain/errors.js';
import type { Epistemic, Pool } from '../../domain/enums.js';
import type { Fact } from '../../domain/types.js';
import { nowIso } from '../../domain/time.js';
import { appendAudit } from './auditRepo.js';
import type { Db } from './db.js';
import { rowToFact } from './mappers.js';

export interface ConfidenceChange {
  value: number;
  source: Fact['confidenceSource'];
  reason: string;
  ts?: string;
}

export function getFact(db: Db, id: string): Fact | null {
  const row = db.prepare('SELECT * FROM fact WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : rowToFact(row);
}

export function findByIdentity(
  db: Db,
  canonicalKey: string,
  scope: string,
  valueHash: string,
): Fact | null {
  // 唯一索引只约束「活跃行」，同一身份键可能有多条历史行；
  // 优先返回活跃的，其次最近的——否则情形 B/C 的判定会读到错误的那一行。
  const row = db
    .prepare(
      `SELECT * FROM fact
        WHERE canonical_key = ? AND scope = ? AND value_hash = ?
        ORDER BY (valid_to IS NULL) DESC, valid_at DESC
        LIMIT 1`,
    )
    .get(canonicalKey, scope, valueHash) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToFact(row);
}

/** 同一身份键下的全部取值（D 情形的判据：不同 value_hash） */
export function listByIdentityKey(db: Db, canonicalKey: string, scope: string): Fact[] {
  const rows = db
    .prepare('SELECT * FROM fact WHERE canonical_key = ? AND scope = ? ORDER BY valid_at DESC')
    .all(canonicalKey, scope) as Record<string, unknown>[];
  return rows.map(rowToFact);
}

export function insertFact(db: Db, fact: Fact): void {
  db.prepare(
    `INSERT INTO fact (
       id, content, ftype, confidence, confidence_source, strength, importance, pool,
       epistemic_status, attrs, canonical_key, value_hash, scope, superseded_by,
       valid_at, valid_to, recorded_at, community_id, degree, access_count,
       last_access_at, last_decay_at, source_episode, span_start, span_end,
       created_at, updated_at
     ) VALUES (
       @id, @content, @ftype, @confidence, @confidence_source, @strength, @importance, @pool,
       @epistemic_status, @attrs, @canonical_key, @value_hash, @scope, @superseded_by,
       @valid_at, @valid_to, @recorded_at, @community_id, 0, 0,
       NULL, @last_decay_at, @source_episode, @span_start, @span_end,
       @created_at, @updated_at
     )`,
  ).run({
    id: fact.id,
    content: fact.content,
    ftype: fact.ftype,
    confidence: fact.confidence,
    confidence_source: fact.confidenceSource,
    strength: fact.strength,
    importance: fact.importance,
    pool: fact.pool,
    epistemic_status: fact.epistemicStatus,
    attrs: JSON.stringify(fact.attrs),
    canonical_key: fact.canonicalKey,
    value_hash: fact.valueHash,
    scope: fact.scope,
    superseded_by: fact.supersededBy,
    valid_at: fact.validAt,
    valid_to: fact.validTo,
    recorded_at: fact.recordedAt,
    community_id: fact.communityId,
    last_decay_at: fact.lastDecayAt,
    source_episode: fact.sourceEpisode,
    span_start: fact.span?.[0] ?? null,
    span_end: fact.span?.[1] ?? null,
    created_at: fact.createdAt,
    updated_at: fact.updatedAt,
  });
}

/**
 * 置信变更的唯一入口。**必须**写审计——这是 I10 的落地点。
 * 内容（content / attrs.frozen）改不了，能改的只有认知状态量，而认知状态量必须留痕。
 */
export function setConfidence(db: Db, id: string, change: ConfidenceChange): void {
  const tx = db.transaction(() => {
    const before = db.prepare('SELECT confidence, confidence_source FROM fact WHERE id = ?').get(id) as
      | { confidence: number; confidence_source: string }
      | undefined;
    if (before === undefined) throw new MoshiError('E_NOT_FOUND', `fact 不存在：${id}`, { id });

    const ts = change.ts ?? nowIso();
    db.prepare(
      'UPDATE fact SET confidence = ?, confidence_source = ?, updated_at = ? WHERE id = ?',
    ).run(change.value, change.source, ts, id);

    appendAudit(db, {
      tbl: 'fact',
      rowId: id,
      field: 'confidence',
      before: { confidence: before.confidence, confidence_source: before.confidence_source },
      after: { confidence: change.value, confidence_source: change.source },
      source: change.source,
      reason: change.reason,
      ts,
    });
  });
  tx();
}

/** 生命周期：强度。只允许衰减/重算调用，不对外暴露批量更新 */
export function setStrength(db: Db, id: string, strength: number, ts: string = nowIso()): void {
  db.prepare('UPDATE fact SET strength = ?, last_decay_at = ?, updated_at = ? WHERE id = ?').run(
    strength,
    ts,
    ts,
    id,
  );
}

export function setPool(db: Db, id: string, pool: Pool, ts: string = nowIso()): void {
  db.prepare('UPDATE fact SET pool = ?, updated_at = ? WHERE id = ?').run(pool, ts, id);
}

export function setImportance(db: Db, id: string, importance: number, ts: string = nowIso()): void {
  db.prepare('UPDATE fact SET importance = ?, updated_at = ? WHERE id = ?').run(
    importance,
    ts,
    id,
  );
}

/** 生命周期：访问计数。读通路调用，不写 audit（高频且无认知含义） */
export function touchAccess(db: Db, ids: readonly string[], ts: string = nowIso()): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    'UPDATE fact SET access_count = access_count + 1, last_access_at = ? WHERE id = ?',
  );
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(ts, id);
  });
  tx();
}

/** 追加式失效：只收口，不删、不复活 */
export function invalidate(
  db: Db,
  id: string,
  opts: { validTo: string; supersededBy?: string | null; status?: Epistemic },
): void {
  const current = db.prepare('SELECT valid_at, valid_to FROM fact WHERE id = ?').get(id) as
    | { valid_at: string; valid_to: string | null }
    | undefined;
  if (current === undefined) throw new MoshiError('E_NOT_FOUND', `fact 不存在：${id}`, { id });
  if (current.valid_to !== null) {
    throw new MoshiError('E_IMMUTABLE', `fact 已失效，不能重复收口：${id}`, { id });
  }
  if (!(opts.validTo > current.valid_at)) {
    throw new MoshiError('E_INPUT', `valid_to 必须晚于 valid_at：${opts.validTo} <= ${current.valid_at}`, {
      id,
      validTo: opts.validTo,
      validAt: current.valid_at,
    });
  }
  db.prepare(
    'UPDATE fact SET valid_to = ?, superseded_by = ?, epistemic_status = ?, updated_at = ? WHERE id = ?',
  ).run(opts.validTo, opts.supersededBy ?? null, opts.status ?? 'invalidated', nowIso(), id);
}

export function setEpistemicStatus(db: Db, id: string, status: Epistemic): void {
  db.prepare('UPDATE fact SET epistemic_status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowIso(),
    id,
  );
}

export function setCommunity(db: Db, id: string, communityId: number | null): void {
  db.prepare('UPDATE fact SET community_id = ? WHERE id = ?').run(communityId, id);
}

/** 情形 B 的"刷新"：不动 content/frozen，只推进 recorded_at 与访问计数 */
export function refreshRecordedAt(db: Db, id: string, ts: string = nowIso()): void {
  db.prepare('UPDATE fact SET recorded_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id);
}

export function countFacts(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number };
  return row.n;
}
