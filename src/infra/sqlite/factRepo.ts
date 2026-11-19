/**
 * 事实仓储（详设 §3.3 第 3 条：生命周期字段只经专用方法）。
 *
 * 这一层是 K2 正交化的最后一道门：
 * - 业务代码**拿不到**通用的 query/exec，只能调这里列出的意图化方法；
 * - `strength` / `pool` / `access_count` / `last_access_at` 各自只有一个写入口；
 * - 改 `confidence` 必须同时写 `audit`（I10），两者在同一事务里。
 */
import { MoshiError } from '../../domain/errors.js';
import type { Epistemic, Ftype, Pool } from '../../domain/enums.js';
import type { Fact } from '../../domain/types.js';
import { nowIso } from '../../domain/time.js';
import { applyStrength as computeStrength, VALIDATE_FLOOR, type StrengthEvent } from '../../core/lifecycle/strength.js';
import { appendAudit } from './auditRepo.js';
import type { Db } from './db.js';
import { syncFtsRow } from './ftsRepo.js';
import { rowToFact } from './mappers.js';
import { withTransaction } from './tx.js';

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

/**
 * 同一身份键当前是否已有活跃行（复检的"已被重新观测到"判据）。
 *
 * 口径是 `canonical_key + scope` 而不是再加 `value_hash`：身份唯一索引
 * `(canonical_key, scope, value_hash) WHERE valid_to IS NULL` 只约束"同值"，
 * 而"同身份已有活跃取值"就已经说明旧行被取代（详设 §2.8 情形 C/D）——
 * 再复活旧行会让同一身份同时有两个有效取值，违反"单一身份单一活跃事实"。
 */
export function hasActiveByIdentity(db: Db, canonicalKey: string, scope: string): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS hit FROM fact WHERE canonical_key = ? AND scope = ? AND valid_to IS NULL LIMIT 1',
    )
    .get(canonicalKey, scope);
  return row !== undefined;
}

/**
 * 已失效（`valid_to` 非空）的事实行，按 id 升序取前 `limit` 条。
 *
 * `limit <= 0` = 不限（SQLite 的 `LIMIT -1`）。`afterId` 供分批扫描用游标翻页，
 * 不用 OFFSET：翻页期间有行被复活时，OFFSET 会整段漂移、漏扫。
 */
export function listExpiredFacts(db: Db, limit: number, afterId = ''): Fact[] {
  const rows = db
    .prepare('SELECT * FROM fact WHERE valid_to IS NOT NULL AND id > ? ORDER BY id ASC LIMIT ?')
    .all(afterId, limit <= 0 ? -1 : limit) as Record<string, unknown>[];
  return rows.map(rowToFact);
}

/**
 * 按主体名找当前有效事实（P2-23 直写解析边目标用）。
 *
 * `to_key` 允许写成主体名（`subject` 的字面值），而 canonical_key 带着谓词与取值摘要，
 * 调用方未必知道。同名主体可能有多条事实，按 recorded_at 倒序取前几条，由调用方挑。
 */
export function findActiveBySubjectName(
  db: Db,
  name: string,
  scope = 'global',
  limit = 8,
): Fact[] {
  const rows = db
    .prepare(
      `SELECT * FROM fact
       WHERE valid_to IS NULL AND scope = ?
         AND json_extract(attrs, '$.frozen.subject.name') = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT ?`,
    )
    .all(scope, name, limit) as Record<string, unknown>[];
  return rows.map(rowToFact);
}

export function insertFact(db: Db, fact: Fact): void {
  db.prepare(
    `INSERT INTO fact (
       id, content, ftype, retention_class, volatility, admission_reason, ttl_seconds,
       source_kind, recheck_kind, expired_at,
       confidence, confidence_source, strength, importance, pool,
       epistemic_status, attrs, canonical_key, value_hash, scope, superseded_by,
       valid_at, valid_to, recorded_at, community_id, degree, access_count,
       last_access_at, last_decay_at, source_episode, span_start, span_end,
       created_at, updated_at
     ) VALUES (
       @id, @content, @ftype, @retention_class, @volatility, @admission_reason, @ttl_seconds,
       @source_kind, @recheck_kind, @expired_at,
       @confidence, @confidence_source, @strength, @importance, @pool,
       @epistemic_status, @attrs, @canonical_key, @value_hash, @scope, @superseded_by,
       @valid_at, @valid_to, @recorded_at, @community_id, 0, 0,
       NULL, @last_decay_at, @source_episode, @span_start, @span_end,
       @created_at, @updated_at
     )`,
  ).run({
    id: fact.id,
    content: fact.content,
    ftype: fact.ftype,
    retention_class: fact.retentionClass,
    volatility: fact.volatility,
    admission_reason: fact.admissionReason,
    ttl_seconds: fact.ttlSeconds,
    // V-05 的两列是 NOT NULL DEFAULT；`Fact` 上它们可选（兼容旧调用方/测试字面量），
    // 这里按 DDL 默认值兜底，避免把"未分类"写成 NULL。
    source_kind: fact.sourceKind ?? 'observation',
    recheck_kind: fact.recheckKind ?? 'none',
    expired_at: fact.expiredAt,
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
  // FTS 同步（详设 §6.4.2）：同一事务内写 fact_fts。content 不可变，只有 insert 路径
  syncFtsRow(db, fact.id, fact.content);
}

/**
 * 置信变更的唯一入口。**必须**写审计——这是 I10 的落地点。
 * 内容（content / attrs.frozen）改不了，能改的只有认知状态量，而认知状态量必须留痕。
 */
export function setConfidence(db: Db, id: string, change: ConfidenceChange): void {
  // 整笔事务交给 withTransaction：撞锁时重试的是这一整笔（含审计行），而不是某条 UPDATE
  withTransaction(db, () => {
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

/**
 * 强度写入阈值（详设 §8.1 实现约束第 1 条）。
 *
 * 变化不足千分之一就当「没变」：惰性衰减在**每次查询**都会算一遍，
 * 不设阈值的话读也写库，WAL 会被无意义的 ±1e-9 打爆。
 * 导出是给 `moshi db rebuild-strength --dry-run` 用的——统计口径必须与写库口径一致。
 */
export const STRENGTH_WRITE_EPS = 1e-3;

/**
 * 事件驱动的强度更新（写入后的那个「算一次」）。
 *
 * 与读路径的惰性衰减共用同一个方程，区别只是事件非 `none`。
 * 值没变就**不写库**——`last_decay_at` 也不动，否则下一次会以为「已经算过了」。
 */
export function applyStrength(
  db: Db,
  id: string,
  event: StrengthEvent,
  now: number = Date.now(),
): { strength: number; changed: boolean } {
  const fact = getFact(db, id);
  if (fact === null) throw new MoshiError('E_NOT_FOUND', `fact 不存在：${id}`, { id });

  const target = computeStrength(fact, event, now);
  if (Math.abs(target - fact.strength) <= STRENGTH_WRITE_EPS) {
    return { strength: fact.strength, changed: false };
  }
  setStrength(db, id, target, new Date(now).toISOString());
  return { strength: target, changed: true };
}

/**
 * 读路径的惰性衰减：按当前时刻把一批事实算一遍，只把真变了的行批量写回。
 *
 * 返回值的 strength 已是「衰减后」的值，供调用方在内存里直接用于融合/裁决——
 * 不落库的行（Δ ≤ 1e-3）保持原值，因为它本来就被约定俗成为「没变」。
 * 不改其他列、不删行：失效事实只是被算成 0，行仍然在。
 */
export function decayFacts(db: Db, facts: readonly Fact[], now: number): Fact[] {
  const writes: { id: string; strength: number }[] = [];
  const out: Fact[] = [];

  for (const fact of facts) {
    const target = computeStrength(fact, { kind: 'none' }, now);
    if (Math.abs(target - fact.strength) > STRENGTH_WRITE_EPS) {
      writes.push({ id: fact.id, strength: target });
      out.push({ ...fact, strength: target });
    } else {
      out.push(fact);
    }
  }

  if (writes.length > 0) {
    const ts = new Date(now).toISOString();
    // 一笔批量回写；撞锁时整笔重来（快照冲突不能只重试某一行）
    withTransaction(db, () => {
      for (const w of writes) setStrength(db, w.id, w.strength, ts);
    });
  }
  return out;
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
  // 访问计数是"加一"语义，重试不会把计数写错（整笔重来）
  withTransaction(db, () => {
    for (const id of ids) stmt.run(ts, id);
  });
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

export interface ReactivateOptions {
  ts?: string;
  /**
   * 复活后的强度下限（概设 §5.5.1「独立验证：s ← max(s, floor)」，floor 初值 0.60）。
   * 失效事实的强度按约定已被算成 0，直接复活会让它以"刚衰减完"的状态回到读路径。
   */
  strengthFloor?: number;
  /** 审计来源；默认 `rule:recheck`，与人工撤销失效区分 */
  source?: string;
  reason?: string | null;
}

/**
 * 复活的唯一写入口：清 `valid_to`、回到 `active`。
 *
 * 与 `invalidate` 互逆，但**不是**写入路径的"情形 C"（详设 §2.8 情形 C 要求插新行 +
 * `supersedes` 边）。本方法只用于**撤销一次失效判定**（概设 §3.6.3 第 4 条：
 * "回滚 = 撤销失效：把 valid_to 清回 NULL 即可"），因此：
 *
 * - 只收口过（`valid_to` 非空）的行能复活，活跃行调用抛 `E_IMMUTABLE`；
 * - 同身份已有活跃行时抛 `E_CONFLICT_IDENTITY`——否则同一身份会有两个有效取值，
 *   且同值时会直接撞 `idx_fact_identity`；
 * - `content` / `attrs` / `canonical_key` 一个字节都不动；`superseded_by` 保留
 *   （取代链是历史事实，由 audit 与 `supersedes` 边承载），审计行必写。
 */
export function reactivate(db: Db, id: string, opts: ReactivateOptions = {}): void {
  const ts = opts.ts ?? nowIso();
  const floor = opts.strengthFloor ?? VALIDATE_FLOOR;
  const source = opts.source ?? 'rule:recheck';

  withTransaction(db, () => {
    const before = db
      .prepare(
        `SELECT canonical_key, scope, valid_to, epistemic_status, strength
           FROM fact WHERE id = ?`,
      )
      .get(id) as
      | {
          canonical_key: string;
          scope: string;
          valid_to: string | null;
          epistemic_status: string;
          strength: number;
        }
      | undefined;
    if (before === undefined) throw new MoshiError('E_NOT_FOUND', `fact 不存在：${id}`, { id });
    if (before.valid_to === null) {
      throw new MoshiError('E_IMMUTABLE', `fact 未失效，不能复活：${id}`, { id });
    }
    if (hasActiveByIdentity(db, before.canonical_key, before.scope)) {
      throw new MoshiError('E_CONFLICT_IDENTITY', `同身份已有活跃事实，不能复活旧行：${id}`, {
        id,
        canonicalKey: before.canonical_key,
      });
    }

    const strength = Math.max(before.strength, floor);
    db.prepare(
      `UPDATE fact
          SET valid_to = NULL, epistemic_status = 'active', strength = ?,
              expired_at = NULL, last_decay_at = ?, updated_at = ?
        WHERE id = ? AND valid_to IS NOT NULL`,
    ).run(strength, ts, ts, id);

    appendAudit(db, {
      tbl: 'fact',
      rowId: id,
      field: 'valid_to',
      before: {
        valid_to: before.valid_to,
        epistemic_status: before.epistemic_status,
        strength: before.strength,
      },
      after: { valid_to: null, epistemic_status: 'active', strength },
      source,
      reason: opts.reason ?? null,
      ts,
    });
  });
}

/**
 * 复检"待审"标记：写进 `attrs.ext.recheck`（`ext` 是 schema 预留的 JSON 扩展槽，
 * 详设 §2.1），不新增列、不改枚举，普通读路径完全看不见它。
 *
 * 只写 `ext` 而不写 `attrs` 顶层，是因为 `parseAttrs`（mappers.ts:52-62）只回传
 * `{frozen, ext}`——顶层自定义键读不回来，等于标记写丢。
 *
 * 待审 ≠ 剪枝：概设 §5.5.1 第 3 条与详设 §8.3.4 都要求淘汰只出候选清单、
 * **不自动删**，所以这里只留标记与审计。
 */
export function markRecheckPending(db: Db, id: string, opts: { reason: string; ts?: string }): void {
  const ts = opts.ts ?? nowIso();
  withTransaction(db, () => {
    const row = db.prepare('SELECT attrs FROM fact WHERE id = ?').get(id) as
      | { attrs: string | null }
      | undefined;
    if (row === undefined) throw new MoshiError('E_NOT_FOUND', `fact 不存在：${id}`, { id });
    const attrs = row.attrs === null ? {} : (JSON.parse(row.attrs) as Record<string, unknown>);
    const ext = (attrs['ext'] ?? {}) as Record<string, unknown>;
    const before = ext['recheck'] ?? null;
    const after = { verdict: 'pending_review', reason: opts.reason, at: ts };
    ext['recheck'] = after;
    attrs['ext'] = ext;
    db.prepare('UPDATE fact SET attrs = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(attrs),
      ts,
      id,
    );
    appendAudit(db, {
      tbl: 'fact',
      rowId: id,
      field: 'attrs.ext.recheck',
      before,
      after,
      source: 'rule:recheck',
      reason: opts.reason,
      ts,
    });
  });
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

// ── 边抽取的候选查询（P2-22 / 详设 §5.12.6）──
//
// 规则留在 `core/write/edges.ts`，SQL 只能待在这一层：
// `lint:lifecycle` 禁止 core 直接持有 db 句柄（概设 §1.6 第 3 条）。

export interface FactRef {
  id: string;
  validAt: string;
}

/** 同 subject 实体、`valid_at` 落在 [from,to] 内的其他活跃事实（共现候选，近的优先） */
export function listCoOccurCandidates(
  db: Db,
  opts: { id: string; entityId: string; from: string; to: string; at: string },
): FactRef[] {
  const rows = db
    .prepare(
      `SELECT id, valid_at FROM fact
        WHERE id <> ? AND valid_to IS NULL
          AND json_extract(attrs,'$.frozen.subject.entity_id') = ?
          AND valid_at >= ? AND valid_at <= ?
        ORDER BY ABS(strftime('%s', valid_at) - strftime('%s', ?)), id
        LIMIT 50`,
    )
    .all(opts.id, opts.entityId, opts.from, opts.to, opts.at) as { id: string; valid_at: string }[];
  return rows.map((r) => ({ id: r.id, validAt: r.valid_at }));
}

/** 同实体 + 同谓词、已收口的旧事实（取代候选，新的在前） */
export function listSupersedeCandidates(
  db: Db,
  opts: { id: string; entityId: string; predicate: string; before: string },
): FactRef[] {
  const rows = db
    .prepare(
      `SELECT id, valid_at FROM fact
        WHERE id <> ? AND valid_to IS NOT NULL AND valid_at < ?
          AND json_extract(attrs,'$.frozen.subject.entity_id') = ?
          AND json_extract(attrs,'$.frozen.predicate') = ?
        ORDER BY valid_at DESC, id
        LIMIT 20`,
    )
    .all(opts.id, opts.before, opts.entityId, opts.predicate) as {
    id: string;
    valid_at: string;
  }[];
  return rows.map((r) => ({ id: r.id, validAt: r.valid_at }));
}

/** 同 episode 的工具观测事实，按 `valid_at` 升序（工具序列候选） */
export function listEpisodeToolFacts(db: Db, episodeId: string, excludeId: string): FactRef[] {
  const rows = db
    .prepare(
      `SELECT id, valid_at FROM fact
        WHERE source_episode = ? AND id <> ? AND valid_to IS NULL
          AND confidence_source = 'tool_obs'
        ORDER BY valid_at, id`,
    )
    .all(episodeId, excludeId) as { id: string; valid_at: string }[];
  return rows.map((r) => ({ id: r.id, validAt: r.valid_at }));
}

/** 同 episode 里带 subject 名的事实（过程步骤按 step 名解析） */
export function listEpisodeFactNames(
  db: Db,
  episodeId: string,
  excludeId: string,
): { id: string; name: string }[] {
  const rows = db
    .prepare(
      `SELECT id, json_extract(attrs,'$.frozen.subject.name') AS name FROM fact
        WHERE source_episode = ? AND id <> ? AND valid_to IS NULL`,
    )
    .all(episodeId, excludeId) as { id: string; name: string | null }[];
  return rows.filter(
    (r): r is { id: string; name: string } => typeof r.name === 'string' && r.name.length > 0,
  );
}

/** 会话摘要窗口（详设 §8.2）：`created_at ∈ [from,to]` 的新观测数 */
export function countCreatedBetween(db: Db, from: string, to: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM fact WHERE created_at >= ? AND created_at <= ?')
    .get(from, to) as { n: number };
  return row.n;
}

/** 窗口内被标记失效/清理的事实数（"失效"口径按 updated_at 落窗） */
export function countInvalidatedBetween(db: Db, from: string, to: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fact
        WHERE epistemic_status IN ('invalidated','pruned') AND updated_at >= ? AND updated_at <= ?`,
    )
    .get(from, to) as { n: number };
  return row.n;
}

/** 窗口内涉及的主体实体数（会话摘要第 1 行的"涉及 K 个实体"） */
export function countDistinctSubjectsBetween(db: Db, from: string, to: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT json_extract(attrs, '$.frozen.subject.entity_id')) AS n
         FROM fact WHERE created_at >= ? AND created_at <= ?`,
    )
    .get(from, to) as { n: number };
  return row.n;
}

/**
 * keyset 游标：排序键 + 上一页最后一行的键值。
 *
 * 为什么把 `sort` 塞进游标而不是两个平行字段：排序键与游标键必须成对出现——
 * 时间序按 `(valid_at DESC, id DESC)` 走"更早"，重要度序按 `(importance DESC, id ASC)`
 * 走"更轻"，两种条件的方向相反。写成一个判别联合，调用方不可能只改排序却忘了改游标。
 */
export type SearchCursor =
  | { sort: 'time'; validAt: string; id: string }
  | { sort: 'importance'; importance: number; id: string };

export interface SearchOptions {
  /** 关键词；对 content / canonical_key 做 LIKE。空则只按时间与生命周期排序 */
  q?: string;
  ftype?: readonly Ftype[];
  scope?: string;
  /** 默认只看 active */
  status?: readonly Epistemic[];
  /** true 则连已失效的历史行一起返回（详设 §4.1.1 的 `include_history`） */
  includeHistory?: boolean;
  /**
   * 精确匹配 `canonical_key`（概设 §8.1 深链 `/ui/memories?canonical_key=<k>`）。
   * 与 `q` 的 LIKE 语义不同：这里只认全等，供 UI 从实体一跳定位到唯一身份键。
   */
  canonicalKey?: string;
  /** `strength` 下限（含端点，0..1）：概设 §8.1 的 strength 分层筛选 */
  strengthMin?: number;
  /** `strength` 上限（含端点，0..1） */
  strengthMax?: number;
  /** 证据池筛选（详设 §1.4：utility / value_floor），与 `status` 是 AND 关系 */
  pool?: Pool;
  from?: string;
  to?: string;
  /**
   * 游标分页（keyset）：只取"严格排在游标之后"的行。
   * 排序键必须与游标键一致（`cursor.sort`）——若排序与游标不一致，翻页会错乱。
   */
  cursor?: SearchCursor;
  /**
   * 排序键。`strength`（默认）适合召回场景；`time` / `importance` 用于列表的游标分页，
   * 游标键必须与之一致（见 `SearchCursor`），否则翻页会错乱
   * （比如按 strength 排序但按时间过滤，会把上一页的行又捞回来）。
   */
  sort?: 'strength' | 'time' | 'importance';
  limit: number;
}

/** LIKE 里的元字符要转义，否则用户搜 `100%` 会变成通配 */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 把筛选条件拼成 WHERE 子句；`searchFacts` 与 `countMatching` 共用，避免口径分叉 */
function buildWhere(opts: Omit<SearchOptions, 'limit'>): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.q !== undefined && opts.q.trim() !== '') {
    where.push("(content LIKE ? ESCAPE '\\' OR canonical_key LIKE ? ESCAPE '\\')");
    const pat = `%${likeEscape(opts.q.trim())}%`;
    params.push(pat, pat);
  }
  if (opts.scope !== undefined) {
    where.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.canonicalKey !== undefined) {
    where.push('canonical_key = ?');
    params.push(opts.canonicalKey);
  }
  if (opts.strengthMin !== undefined) {
    where.push('strength >= ?');
    params.push(opts.strengthMin);
  }
  if (opts.strengthMax !== undefined) {
    where.push('strength <= ?');
    params.push(opts.strengthMax);
  }
  if (opts.pool !== undefined) {
    where.push('pool = ?');
    params.push(opts.pool);
  }
  if (opts.ftype !== undefined && opts.ftype.length > 0) {
    where.push(`ftype IN (${opts.ftype.map(() => '?').join(',')})`);
    params.push(...opts.ftype);
  }
  const status = opts.status ?? (opts.includeHistory === true ? null : (['active'] as const));
  if (status !== null) {
    where.push(`epistemic_status IN (${status.map(() => '?').join(',')})`);
    params.push(...status);
  }
  if (opts.from !== undefined) {
    where.push('valid_at >= ?');
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    where.push('valid_at <= ?');
    params.push(opts.to);
  }
  // keyset 游标：必须下沉到 SQL——先 LIMIT 再内存过滤会把第二页的数据挡在查询结果之外。
  // 两种排序的越界方向相反：时间序"更早"（valid_at < / id <），重要度序是 DESC + id ASC，
  // 所以"更轻"要按 importance < 或（同分）id >。
  if (opts.cursor !== undefined) {
    if (opts.cursor.sort === 'importance') {
      where.push('(importance < ? OR (importance = ? AND id > ?))');
      params.push(opts.cursor.importance, opts.cursor.importance, opts.cursor.id);
    } else {
      where.push('(valid_at < ? OR (valid_at = ? AND id < ?))');
      params.push(opts.cursor.validAt, opts.cursor.validAt, opts.cursor.id);
    }
  }

  return { sql: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * 符号检索（Phase 0 的兜底召回，详设 §6.7 第 1 步的最小版本）。
 *
 * 为什么放在 infra：`core`/`app` 里不许出现裸 SQL（`tools/check-lifecycle.ts` 会拦）。
 * Phase 1 会在这里之上加向量 / BM25 / PPR 三路，但"关键词直查"这一路始终保留——
 * 它是**唯一不依赖模型**的通路，冷启动与 sidecar 崩溃时全靠它。
 */
export function searchFacts(db: Db, opts: SearchOptions): Fact[] {
  // 排序键与游标键不一致 = 分页必然错乱（同一条会重复出现或被跳过），
  // 这类 bug 在 UI 上表现为"滚动时行号乱跳"，很难回溯，所以在入口直接炸。
  // HTTP 层（`routes/facts.ts` 的 decodeCursor）已经先一步返 400
  // `detail.reason="cursor_sort_mismatch"`，这里是 infra 兜底：绕过 HTTP 直接调
  // searchFacts 的调用方（评测脚本、将来的 CLI）同样不能带着不一致的键进来。
  if (
    opts.cursor !== undefined &&
    (opts.sort === 'time' || opts.sort === 'importance') &&
    opts.cursor.sort !== opts.sort
  ) {
    throw new MoshiError('E_INPUT', '游标键与排序键不一致', {
      sort: opts.sort,
      cursorSort: opts.cursor.sort,
    });
  }
  const { sql, params } = buildWhere(opts);
  const orderBy =
    opts.sort === 'time'
      ? 'valid_at DESC, id DESC'
      : opts.sort === 'importance'
        ? 'importance DESC, id ASC'
        : 'strength DESC, confidence DESC, valid_at DESC';
  const rows = db
    .prepare(`SELECT * FROM fact${sql}` + ` ORDER BY ${orderBy} LIMIT ?`)
    .all(...params, opts.limit) as Record<string, unknown>[];
  return rows.map(rowToFact);
}

/**
 * 按 id 批量取（详设 §6.5：融合要拿三路召回的**并集**候选）。
 * 返回顺序不保证——调用方自己按通道序排（融合只用集合，排序在 fuse 层）。
 */
export function listByIds(db: Db, ids: readonly string[]): Fact[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM fact WHERE id IN (${ph})`).all(...ids) as Record<string, unknown>[];
  return rows.map((r) => rowToFact(r));
}

/** 命中总数：用来判断"是否还有更多"，不必把行拉回来 */
export function countMatching(db: Db, opts: Omit<SearchOptions, 'limit'>): number {
  const { sql, params } = buildWhere(opts);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM fact${sql}`).get(...params) as { n: number };
  return row.n;
}

/**
 * 按 rowid 分页扫全表（`moshi db rebuild-strength` 用，详设 §8.1 末段「一次遍历全表」）。
 *
 * 用 keyset（`rowid > ?`）而不是 OFFSET：重算期间自己会写库，但写强度不改 rowid，
 * 所以翻页既不跳行也不重复；OFFSET 在大库上还会越翻越慢。
 */
export function listFactsPage(
  db: Db,
  afterRowid: number,
  limit: number,
): { rowid: number; fact: Fact }[] {
  const rows = db
    .prepare('SELECT rowid AS rid, * FROM fact WHERE rowid > ? ORDER BY rowid LIMIT ?')
    .all(afterRowid, limit) as (Record<string, unknown> & { rid: number })[];
  return rows.map((r) => ({ rowid: r.rid, fact: rowToFact(r) }));
}

/**
 * 检查器溯源档的展示用摘要（详设 §10.5 溯源档：依赖链 / 冲突对 / supersedes 链）。
 * 只带渲染需要的最小字段，不拖整行 Fact。
 */
export interface FactDigest {
  id: string;
  content: string;
  validAt: string;
  validTo: string | null;
}

/**
 * 依赖链：depends_on 边 `src → dst` = src 依赖 dst（dst 是上游/前提，
 * 见 `core/write/edges.ts` 规则「步骤 b 依赖步骤 a：先做的在 dst」）。
 *
 * - 上游 = 我依赖的：从 `src = id` 出发沿 dst 方向展开；
 * - 下游 = 依赖我的：从 `dst = id` 出发沿 src 方向展开。
 *
 * 各展开 `hops` 层（详设 §10.5：上下游各 3 跳），BFS 去重（不含自己），
 * 每层按边 weight 降序截断到 `perHopLimit`——依赖链是"看因果"，不是全图遍历，
 * 无限展开会把一个事实的检查器拉成整库。
 */
export function traceDepends(
  db: Db,
  id: string,
  opts: { hops?: number; perHopLimit?: number } = {},
): { upstream: FactDigest[]; downstream: FactDigest[] } {
  const hops = Math.max(0, Math.min(opts.hops ?? 3, 5));
  const perHopLimit = Math.max(1, Math.min(opts.perHopLimit ?? 20, 50));

  const digests = (rows: { id: string; content: string; valid_at: string; valid_to: string | null }[]): FactDigest[] =>
    rows.map((r) => ({ id: r.id, content: r.content, validAt: r.valid_at, validTo: r.valid_to }));

  // 上游：src = frontier 的元素 → dst（我依赖的）
  const upstream: FactDigest[] = [];
  const upstreamSeen = new Set<string>([id]);
  let upFrontier: string[] = [id];
  for (let hop = 0; hop < hops && upFrontier.length > 0; hop += 1) {
    const ph = upFrontier.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT f.id, f.content, f.valid_at, f.valid_to
           FROM edge e JOIN fact f ON f.id = e.dst
          WHERE e.src IN (${ph}) AND e.etype = 'depends_on' AND e.valid_to IS NULL
          ORDER BY e.weight DESC, f.id
          LIMIT ?`,
      )
      .all(...upFrontier, perHopLimit) as { id: string; content: string; valid_at: string; valid_to: string | null }[];
    const next: string[] = [];
    for (const r of rows) {
      if (upstreamSeen.has(r.id)) continue;
      upstreamSeen.add(r.id);
      upstream.push(digests([r])[0]!);
      next.push(r.id);
    }
    upFrontier = next;
  }

  // 下游：dst = frontier 的元素 → src（依赖我的）
  const downstream: FactDigest[] = [];
  const downSeen = new Set<string>([id]);
  let downFrontier: string[] = [id];
  for (let hop = 0; hop < hops && downFrontier.length > 0; hop += 1) {
    const ph = downFrontier.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT f.id, f.content, f.valid_at, f.valid_to
           FROM edge e JOIN fact f ON f.id = e.src
          WHERE e.dst IN (${ph}) AND e.etype = 'depends_on' AND e.valid_to IS NULL
          ORDER BY e.weight DESC, f.id
          LIMIT ?`,
      )
      .all(...downFrontier, perHopLimit) as { id: string; content: string; valid_at: string; valid_to: string | null }[];
    const next: string[] = [];
    for (const r of rows) {
      if (downSeen.has(r.id)) continue;
      downSeen.add(r.id);
      downstream.push(digests([r])[0]!);
      next.push(r.id);
    }
    downFrontier = next;
  }

  return { upstream, downstream };
}

/**
 * 冲突对：与 `id` 之间有活跃 `mutually_exclusive` 边的事实（详设 §10.5 溯源档）。
 * 冲突是成对的，取对侧事实。边的 src/dst 谁是 id 都行，用 CASE 归一。
 */
export function listConflicts(db: Db, id: string, limit = 20): FactDigest[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.content, f.valid_at, f.valid_to
         FROM edge e JOIN fact f ON f.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
        WHERE (e.src = ? OR e.dst = ?) AND e.etype = 'mutually_exclusive' AND e.valid_to IS NULL
        ORDER BY e.weight DESC, f.id
        LIMIT ?`,
    )
    .all(id, id, id, limit) as { id: string; content: string; valid_at: string; valid_to: string | null }[];
  return rows.map((r) => ({ id: r.id, content: r.content, validAt: r.valid_at, validTo: r.valid_to }));
}

/**
 * 反向 supersedes 链：`superseded_by = id` 的事实 = "我取代了谁"（详设 §10.5 溯源档）。
 * 被取代的旧事实是收口行（valid_to 非空），但列表里要如实带状态，前端按状态上色。
 */
export function listSuperseding(db: Db, id: string, limit = 50): FactDigest[] {
  const rows = db
    .prepare(
      `SELECT id, content, valid_at, valid_to FROM fact
        WHERE superseded_by = ?
        ORDER BY valid_at DESC, id
        LIMIT ?`,
    )
    .all(id, limit) as { id: string; content: string; valid_at: string; valid_to: string | null }[];
  return rows.map((r) => ({ id: r.id, content: r.content, validAt: r.valid_at, validTo: r.valid_to }));
}

/**
 * 作用域清单（V-02）：当前可见事实按 scope 分组，`global` 排最前。
 * 只读、只走 `idx_fact_scope_community` 的 scope 前缀；给 UI 的项目切换器用。
 */
export function listScopes(db: Db): { scope: string; factCount: number }[] {
  const rows = db
    .prepare(
      `SELECT scope, COUNT(*) AS n
         FROM fact
        WHERE epistemic_status IN ('active','disputed')
        GROUP BY scope
        ORDER BY scope = 'global' DESC, scope`,
    )
    .all() as { scope: string; n: number }[];
  return rows.map((r) => ({ scope: r.scope, factCount: r.n }));
}
