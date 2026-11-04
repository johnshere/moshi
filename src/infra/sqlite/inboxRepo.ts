/**
 * 待办队列 + 批量失效/剪枝仓储（P2-07 / P2-13 / 详设 §10.6、§8.3.4、概设 §8.3）。
 *
 * 这一层只做三件事：
 * 1. 三个队列的**只读**查询（SQL 逐字照抄详设 §10.6，prune 另加 §8.3.4 的 60 天闲置条件）；
 * 2. 批量失效/剪枝的**影响面预览**（facts/edges/topics/invalidated_by_cascade）；
 * 3. 批量失效与撤销、批量剪枝与撤销的写入（单事务 + 逐条 audit）。
 *    - 失效语义是「追加式收口」：只清 `valid_to`、只改 `epistemic_status`，**不删行、不碰 edge**；
 *    - 剪枝语义是「软删」：只改 `epistemic_status='pruned'`，`valid_to` 与 strength 都不动，
 *      行永远保留（物理删除是另一条隐私 purge 路径，不在本文件）。
 *
 * 为什么不给 edge 收口：本路径（UI 批量动作）不建 `supersedes` 边，
 * 而 `edge` 有 `trg_edge_no_reopen`（失效后不可复活），一旦在这里关了边，
 * 30 秒撤销就再也回不去。撤销语义是「清 valid_to / 还原 epistemic_status」，所以边必须原样留着。
 */
import type { Epistemic } from '../../domain/enums.js';
import { MoshiError } from '../../domain/errors.js';
import { nowIso } from '../../domain/time.js';
import { appendAudit } from './auditRepo.js';
import type { Db } from './db.js';
import * as factRepo from './factRepo.js';
import { withTransaction } from './tx.js';

/** 单批最多 200 条：与 REST `limit` 上限同一口径，防止一次把全库收口 */
export const MAX_BATCH_IDS = 200;

/** 消解确认队列的相似度区间（详设 §10.6：0.60–0.92 的灰色地带） */
export const RESOLVE_MIN_SIM = 0.6;
export const RESOLVE_MAX_SIM = 0.92;
/** 低置信阈值（below = 需要人裁决） */
export const LOW_CONF_THRESHOLD = 0.45;
/** 淘汰候选阈值（低于它算"快忘了"） */
export const PRUNE_STRENGTH_THRESHOLD = 0.15;
/**
 * 淘汰候选的闲置期（天）：`last_access_at` 早于 N 天前（或从未访问）才算"该忘"。
 * 详设 §8.3.4 原句是 `date('now','-60 day')`，这里把它提成常量，SQL 用绑定参数，
 * 避免 60 在两个地方各写一遍。
 */
export const PRUNE_IDLE_DAYS = 60;

/** `valid_to IS NULL` 的活跃口径：三队列与影响面共用，避免各处 `valid_to IS NOT NULL` 写反 */
const ACTIVE = "epistemic_status IN ('active','disputed')";

// ── 1. 三个队列（只读） ──

export interface ResolveQueueRow {
  alias: string;
  entityId: string;
  canonicalName: string;
  confidence: number;
}

/**
 * 消解确认：`alias.source = 'vector'` 且相似度落在 0.60–0.92 的候选。
 * 区间是**闭区间**（SQL 用 BETWEEN，与详设原句一致）：0.60 与 0.92 本身都要进队列。
 */
export function listResolveQueue(
  db: Db,
  opts: { limit: number; minSim?: number; maxSim?: number },
): ResolveQueueRow[] {
  const minSim = opts.minSim ?? RESOLVE_MIN_SIM;
  const maxSim = opts.maxSim ?? RESOLVE_MAX_SIM;
  const rows = db
    .prepare(
      `SELECT a.alias, a.entity_id, e.canonical_name, a.confidence
         FROM alias a JOIN entity e ON e.id = a.entity_id
        WHERE a.source = 'vector' AND a.confidence BETWEEN ? AND ?
        ORDER BY a.confidence DESC LIMIT ?`,
    )
    .all(minSim, maxSim, opts.limit) as {
    alias: string;
    entity_id: string;
    canonical_name: string;
    confidence: number;
  }[];
  return rows.map((r) => ({
    alias: r.alias,
    entityId: r.entity_id,
    canonicalName: r.canonical_name,
    confidence: r.confidence,
  }));
}

export interface LowConfQueueRow {
  id: string;
  content: string;
  confidence: number;
  importance: number;
}

/** 低置信裁决：约束在 `epistemic_status` 里（archived / invalidated / pruned 不该再冒出来） */
export function listLowConfQueue(db: Db, opts: { limit: number }): LowConfQueueRow[] {
  const rows = db
    .prepare(
      `SELECT id, content, confidence, importance FROM fact
        WHERE ${ACTIVE} AND confidence < ?
        ORDER BY importance DESC LIMIT ?`,
    )
    .all(LOW_CONF_THRESHOLD, opts.limit) as {
    id: string;
    content: string;
    confidence: number;
    importance: number;
  }[];
  return rows.map((r) => ({ id: r.id, content: r.content, confidence: r.confidence, importance: r.importance }));
}

export interface PruneQueueRow {
  id: string;
  content: string;
  strength: number;
  lastAccessAt: string | null;
}

/**
 * 淘汰候选（详设 §8.3.4）：strength 低 **且** 60 天没被访问过（从未访问也算）。
 * 只出候选清单，绝不在这里删/改任何行——剪枝必须走用户显式动作。
 */
export function listPruneQueue(db: Db, opts: { limit: number }): PruneQueueRow[] {
  const rows = db
    .prepare(
      `SELECT id, content, strength, last_access_at FROM fact
        WHERE ${ACTIVE} AND valid_to IS NULL AND strength < ?
          AND (last_access_at IS NULL OR last_access_at < date('now', ?))
        ORDER BY strength ASC LIMIT ?`,
    )
    .all(PRUNE_STRENGTH_THRESHOLD, `-${String(PRUNE_IDLE_DAYS)} day`, opts.limit) as {
    id: string;
    content: string;
    strength: number;
    last_access_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    strength: r.strength,
    lastAccessAt: r.last_access_at,
  }));
}

// ── 2. 影响面预览 ──

export interface InvalidatePreview {
  /** ids 中当前仍活跃（valid_to IS NULL）的条数：已失效的跳过，不重复计数 */
  facts: number;
  /** 活跃边里 src 或 dst ∈ ids 的条数 */
  edges: number;
  /** ids 对应活跃事实中 community_id 非空的去重主题数 */
  topics: number;
  /** 连带失效：活跃 depends_on 边里 dst ∈ ids 且 src ∉ ids 的 src 去重数（1 跳） */
  invalidatedByCascade: number;
  /** 预览样例（最多 5 条，按 importance DESC） */
  previewSample: { id: string; content: string }[];
}

/**
 * 影响面预览（详设 §10.6：`invalidated_by_cascade` 必须算）。
 *
 * 方向：`depends_on` 边 `src → dst` = **src 依赖 dst**（dst 是上游/前提，
 * 见 `core/write/edges.ts`）。所以"我会连带影响谁" = 依赖我的人 = `dst ∈ ids` 的 `src`。
 */
export function previewInvalidate(db: Db, ids: readonly string[]): InvalidatePreview {
  assertIds(ids);
  const ph = placeholders(ids.length);
  const count = (sql: string, params: readonly unknown[]): number => {
    const row = db.prepare(sql).get(...params) as { n: number };
    return row.n;
  };
  const facts = count(`SELECT COUNT(*) AS n FROM fact WHERE id IN (${ph}) AND valid_to IS NULL`, ids);
  const edges = count(
    `SELECT COUNT(*) AS n FROM edge WHERE valid_to IS NULL AND (src IN (${ph}) OR dst IN (${ph}))`,
    [...ids, ...ids],
  );
  const topics = count(
    `SELECT COUNT(DISTINCT community_id) AS n FROM fact
      WHERE id IN (${ph}) AND valid_to IS NULL AND community_id IS NOT NULL`,
    ids,
  );
  const invalidatedByCascade = count(
    `SELECT COUNT(DISTINCT src) AS n FROM edge
      WHERE etype = 'depends_on' AND valid_to IS NULL
        AND dst IN (${ph}) AND src NOT IN (${ph})`,
    [...ids, ...ids],
  );
  const sample = db
    .prepare(
      `SELECT id, content FROM fact WHERE id IN (${ph}) AND valid_to IS NULL
        ORDER BY importance DESC, id ASC LIMIT 5`,
    )
    .all(...ids) as { id: string; content: string }[];
  return {
    facts,
    edges,
    topics,
    invalidatedByCascade,
    previewSample: sample.map((r) => ({ id: r.id, content: r.content })),
  };
}

/**
 * 剪枝影响面预览（P2-13）：只统计**真的会被剪掉**的行（active/disputed 且 valid_to IS NULL）。
 *
 * `invalidatedByCascade` 恒为 0：剪枝是软删，不改 dependents 的状态，也不跑
 * `reconcileDerivedForFacts`——否则派生点会被永久 invalidated，30 秒撤销救不回来。
 * 依赖方在读时由 `adjudicate` 按 `pruned` 标 stale_dependency（概设 §4.5 的读侧收口）。
 */
export function previewPrune(db: Db, ids: readonly string[]): InvalidatePreview {
  assertIds(ids);
  const ph = placeholders(ids.length);
  const prunable = `id IN (${ph}) AND valid_to IS NULL AND ${ACTIVE}`;
  const count = (sql: string, params: readonly unknown[]): number => {
    const row = db.prepare(sql).get(...params) as { n: number };
    return row.n;
  };
  const facts = count(`SELECT COUNT(*) AS n FROM fact WHERE ${prunable}`, ids);
  const edges = count(
    `SELECT COUNT(*) AS n FROM edge
      WHERE valid_to IS NULL
        AND (src IN (SELECT id FROM fact WHERE ${prunable})
             OR dst IN (SELECT id FROM fact WHERE ${prunable}))`,
    [...ids, ...ids],
  );
  const topics = count(
    `SELECT COUNT(DISTINCT community_id) AS n FROM fact
      WHERE ${prunable} AND community_id IS NOT NULL`,
    ids,
  );
  const sample = db
    .prepare(
      `SELECT id, content FROM fact WHERE ${prunable}
        ORDER BY importance DESC, id ASC LIMIT 5`,
    )
    .all(...ids) as { id: string; content: string }[];
  return {
    facts,
    edges,
    topics,
    // 剪枝不连锁：见上方注释
    invalidatedByCascade: 0,
    previewSample: sample.map((r) => ({ id: r.id, content: r.content })),
  };
}

// ── 3. 批量失效 / 撤销 ──

/** 撤销所需的最小快照：只记"被我们改掉的那几个字段"，不拖整行 */
export interface InvalidateSnapshot {
  id: string;
  /** 失效前的认知状态（撤销时原样写回） */
  epistemicStatus: Epistemic;
  /** 失效前的替代指针（本路径一般为 null，但撤销必须还原而不是清空） */
  supersededBy: string | null;
  /** 本批写进去的 valid_to：撤销 UPDATE 用它做 CAS，防止误开别人后来收口的行 */
  validTo: string;
}

/**
 * 批量失效（单事务）。
 *
 * - 只处理当前 `valid_to IS NULL` 的行：已失效的跳过（不抛 `E_IMMUTABLE`）；
 * - `valid_to` 统一取一个时刻；若与某行 `valid_at` 撞同一毫秒，顺延 1ms
 *   （`valid_to > valid_at` 是 DB CHECK，也是 `factRepo.invalidate` 的入参校验）；
 * - 每条写 audit（`source='ui_batch_invalidate'`，`reason=op_id`），`before` 记原值；
 * - **不碰 edge**：本路径不建 `supersedes` 边，撤销才回得去。
 */
export function invalidateMany(
  db: Db,
  ids: readonly string[],
  opts: { opId: string },
): InvalidateSnapshot[] {
  assertIds(ids);
  const ph = placeholders(ids.length);
  const rows = db
    .prepare(
      `SELECT id, valid_at, valid_to, epistemic_status, superseded_by FROM fact
        WHERE id IN (${ph}) AND valid_to IS NULL
        ORDER BY id`,
    )
    .all(...ids) as {
    id: string;
    valid_at: string;
    valid_to: string | null;
    epistemic_status: string;
    superseded_by: string | null;
  }[];
  if (rows.length === 0) return [];

  // 同一毫秒内"写入 → 立刻批量失效"是很常见的路径（UI 点两下就到），
  // 撞上 validTo <= valid_at 会让整批 400，所以这里顺延到严格晚于最大 valid_at。
  let validTo = nowIso();
  const maxValidAt = rows.reduce((max, r) => (r.valid_at > max ? r.valid_at : max), rows[0]?.valid_at ?? '');
  if (!(validTo > maxValidAt)) validTo = new Date(Date.parse(maxValidAt) + 1).toISOString();

  return withTransaction(db, () => {
    const snapshots: InvalidateSnapshot[] = [];
    for (const row of rows) {
      const before = {
        valid_to: row.valid_to,
        epistemic_status: row.epistemic_status,
        superseded_by: row.superseded_by,
      };
      // 复用仓储方法：存在性 / 重复收口 / validTo > valid_at 的校验都在那儿
      factRepo.invalidate(db, row.id, { validTo, status: 'invalidated' });
      appendAudit(db, {
        tbl: 'fact',
        rowId: row.id,
        field: 'epistemic_status',
        before,
        after: { valid_to: validTo, epistemic_status: 'invalidated', superseded_by: null },
        source: 'ui_batch_invalidate',
        reason: opts.opId,
      });
      snapshots.push({
        id: row.id,
        epistemicStatus: row.epistemic_status as Epistemic,
        supersededBy: row.superseded_by,
        validTo,
      });
    }
    return snapshots;
  });
}

/**
 * 撤销批量失效（单事务）：逐条 `valid_to=NULL` + 还原 `epistemic_status`/`superseded_by`。
 *
 * `WHERE valid_to = ?` 的 CAS 很关键：撤销窗口 30 秒内，同一行可能先被别的路径收口
 * （例如另一次 batch 或 PATCH），那种行不该被我们"复活"——跳过并计数。
 *
 * `fact.valid_to` 清回 NULL 在 DB 层是允许的：`001_init` 只给 `edge` 上了
 * `trg_edge_no_reopen`，`fact` 没有 reopen 触发器（本路径也不碰 edge）。
 */
export function restoreMany(
  db: Db,
  snapshots: readonly InvalidateSnapshot[],
  opts: { opId: string },
): number {
  if (snapshots.length === 0) return 0;
  const ts = nowIso();
  return withTransaction(db, () => {
    const stmt = db.prepare(
      `UPDATE fact SET valid_to = NULL, epistemic_status = ?, superseded_by = ?, updated_at = ?
        WHERE id = ? AND valid_to = ?`,
    );
    let restored = 0;
    for (const snap of snapshots) {
      const info = stmt.run(snap.epistemicStatus, snap.supersededBy, ts, snap.id, snap.validTo);
      if (info.changes === 0) continue;
      appendAudit(db, {
        tbl: 'fact',
        rowId: snap.id,
        field: 'epistemic_status',
        before: { valid_to: snap.validTo, epistemic_status: 'invalidated' },
        after: { valid_to: null, epistemic_status: snap.epistemicStatus },
        source: 'ui_batch_undo',
        reason: opts.opId,
      });
      restored++;
    }
    return restored;
  });
}

// ── 4. 批量剪枝（软删）/ 撤销 ──

/** 剪枝撤销所需的最小快照：原状态 + 本次写入的 updated_at（CAS 用） */
export interface PruneSnapshot {
  id: string;
  /** 剪枝前的认知状态（active/disputed，撤销时原样写回） */
  epistemicStatus: Epistemic;
  /** 本次剪枝写入的 updated_at：撤销 UPDATE 用它做 CAS，防止误开别处后来改过的行 */
  prunedAt: string;
}

/**
 * 批量剪枝（单事务，软删）：
 * - 只处理 `active/disputed` 且 `valid_to IS NULL` 的行，其余跳过并计数；
 * - 只改 `epistemic_status='pruned'` 与 `updated_at`；
 *   **不动 valid_to、不动 strength**——证据字段保留，读侧按状态收口；
 * - 每条写 audit（`source='ui_batch_prune'`，`reason=op_id`），`before` 记原状态；
 * - 不碰 edge（撤销只还原状态，边必须原样留着）。
 */
export function pruneMany(
  db: Db,
  ids: readonly string[],
  opts: { opId: string },
): PruneSnapshot[] {
  assertIds(ids);
  const ph = placeholders(ids.length);
  const rows = db
    .prepare(
      `SELECT id, epistemic_status FROM fact
        WHERE id IN (${ph}) AND valid_to IS NULL AND ${ACTIVE}
        ORDER BY id`,
    )
    .all(...ids) as { id: string; epistemic_status: string }[];
  if (rows.length === 0) return [];

  const prunedAt = nowIso();
  return withTransaction(db, () => {
    const stmt = db.prepare(
      `UPDATE fact SET epistemic_status = 'pruned', updated_at = ?
        WHERE id = ? AND valid_to IS NULL AND epistemic_status IN ('active','disputed')`,
    );
    const snapshots: PruneSnapshot[] = [];
    for (const row of rows) {
      const info = stmt.run(prunedAt, row.id);
      if (info.changes === 0) continue; // 并发下已被别的路径改掉，跳过
      appendAudit(db, {
        tbl: 'fact',
        rowId: row.id,
        field: 'epistemic_status',
        before: { valid_to: null, epistemic_status: row.epistemic_status },
        after: { valid_to: null, epistemic_status: 'pruned' },
        source: 'ui_batch_prune',
        reason: opts.opId,
      });
      snapshots.push({
        id: row.id,
        epistemicStatus: row.epistemic_status as Epistemic,
        prunedAt,
      });
    }
    return snapshots;
  });
}

/**
 * 撤销批量剪枝（单事务）：把 `epistemic_status` 还原成剪枝前的值。
 *
 * CAS 用 `epistemic_status='pruned' AND updated_at=prunedAt`：窗口内若同一行被别的路径
 * 再次改写（理论上不该发生，因为剪枝后它已不在任何可操作队列里），不擅自"复活"。
 */
export function restorePruned(
  db: Db,
  snapshots: readonly PruneSnapshot[],
  opts: { opId: string },
): number {
  if (snapshots.length === 0) return 0;
  const ts = nowIso();
  return withTransaction(db, () => {
    const stmt = db.prepare(
      `UPDATE fact SET epistemic_status = ?, updated_at = ?
        WHERE id = ? AND epistemic_status = 'pruned' AND updated_at = ?`,
    );
    let restored = 0;
    for (const snap of snapshots) {
      const info = stmt.run(snap.epistemicStatus, ts, snap.id, snap.prunedAt);
      if (info.changes === 0) continue;
      appendAudit(db, {
        tbl: 'fact',
        rowId: snap.id,
        field: 'epistemic_status',
        before: { valid_to: null, epistemic_status: 'pruned' },
        after: { valid_to: null, epistemic_status: snap.epistemicStatus },
        source: 'ui_batch_undo',
        reason: opts.opId,
      });
      restored++;
    }
    return restored;
  });
}

// ── 5. 入参校验辅助 ──

/** ids 里存在、但库里没有的 id（整批拒绝的判据，不静默跳过） */
export function missingIds(db: Db, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const ph = placeholders(ids.length);
  const rows = db.prepare(`SELECT id FROM fact WHERE id IN (${ph})`).all(...ids) as { id: string }[];
  const found = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

function assertIds(ids: readonly string[]): void {
  if (ids.length === 0) {
    throw new MoshiError('E_INPUT', 'ids 不能为空', { reason: 'ids_invalid' });
  }
  if (ids.length > MAX_BATCH_IDS) {
    throw new MoshiError('E_INPUT', `ids 最多 ${MAX_BATCH_IDS} 条，收到 ${ids.length} 条`, {
      reason: 'ids_invalid',
    });
  }
}
