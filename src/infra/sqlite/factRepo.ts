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
import { appendAudit } from './auditRepo.js';
import type { Db } from './db.js';
import { syncFtsRow } from './ftsRepo.js';
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
  // FTS 同步（详设 §6.4.2）：同一事务内写 fact_fts。content 不可变，只有 insert 路径
  syncFtsRow(db, fact.id, fact.content);
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
