/**
 * 实体与别名仓储（详设 §5.5 / §2.9）。
 *
 * 消解失败时也必须有实体——`canonical_key` 禁止 NULL（D5），
 * 所以这里提供 `ensureProvisional()`：etype='unknown'，等消解完成后只改别名，不动事实。
 */
import type { AliasSource, EntityType } from '../../domain/enums.js';
import { MoshiError } from '../../domain/errors.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Alias, Entity } from '../../domain/types.js';
import type { Db } from './db.js';
import { rowToAlias, rowToEntity } from './mappers.js';

export function getEntity(db: Db, id: string): Entity | null {
  const row = db.prepare('SELECT * FROM entity WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : rowToEntity(row);
}

export function findByCanonical(
  db: Db,
  canonicalName: string,
  etype: EntityType,
  scope = 'global',
): Entity | null {
  const row = db
    .prepare('SELECT * FROM entity WHERE canonical_name = ? AND etype = ? AND scope = ?')
    .get(canonicalName, etype, scope) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToEntity(row);
}

export function insertEntity(
  db: Db,
  input: { id?: string; canonicalName: string; etype: EntityType; scope?: string; ts?: string },
): Entity {
  const id = input.id ?? newId('entity');
  const ts = input.ts ?? nowIso();
  db.prepare(
    `INSERT INTO entity (id, canonical_name, etype, scope, alias_count, first_seen_at, merged_into)
     VALUES (?, ?, ?, ?, 0, ?, NULL)`,
  ).run(id, input.canonicalName, input.etype, input.scope ?? 'global', ts);
  return getEntity(db, id) as Entity;
}

/** 规则消解失败时的兜底：一定给出实体，key 才不会为空 */
export function ensureProvisional(db: Db, rawName: string, ts: string = nowIso()): Entity {
  const existing = findByCanonical(db, rawName, 'unknown');
  if (existing !== null) return existing;
  return insertEntity(db, { canonicalName: rawName, etype: 'unknown', ts });
}

export function addAlias(
  db: Db,
  input: { alias: string; entityId: string; source: AliasSource; confidence?: number; ts?: string },
): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO alias (alias, entity_id, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.alias, input.entityId, input.source, input.confidence ?? 1.0, input.ts ?? nowIso());
  if (info.changes > 0) {
    // 重算而不是 +1：+1 在回滚/重复插入后会漂移（详设 §5.5）
    db.prepare(
      'UPDATE entity SET alias_count = (SELECT COUNT(*) FROM alias WHERE entity_id = ?) WHERE id = ?',
    ).run(input.entityId, input.entityId);
  }
  return info.changes > 0;
}

/** 别名反查：消解的第一步永远是"这个字符串我见过吗" */
export function resolveAlias(db: Db, alias: string): Entity[] {
  const rows = db
    .prepare(
      `SELECT e.* FROM entity e
         JOIN alias a ON a.entity_id = e.id
        WHERE a.alias = ? AND e.merged_into IS NULL
        ORDER BY a.confidence DESC, e.first_seen_at ASC`,
    )
    .all(alias) as Record<string, unknown>[];
  return rows.map(rowToEntity);
}

/**
 * 别名正查（带置信度与实体类型，按 confidence 降序）。
 * 与 `resolveAlias` 的区别：查询串识别要的是"这个形态值多少分、是哪类实体"，
 * 消解只要实体本身。不排除 merged loser，由调用方按场景决定。
 */
export function searchAliases(
  db: Db,
  alias: string,
): { entityId: string; name: string; etype: EntityType; confidence: number }[] {
  const rows = db
    .prepare(
      `SELECT a.entity_id, a.confidence, e.canonical_name AS name, e.etype
         FROM alias a JOIN entity e ON e.id = a.entity_id
        WHERE a.alias = ?
        ORDER BY a.confidence DESC`,
    )
    .all(alias) as { entity_id: string; confidence: number; name: string; etype: string }[];
  return rows.map((r) => ({
    entityId: r.entity_id,
    name: r.name,
    etype: r.etype as EntityType,
    confidence: r.confidence,
  }));
}

export function aliasesOf(db: Db, entityId: string): Alias[] {
  const rows = db
    .prepare('SELECT * FROM alias WHERE entity_id = ? ORDER BY created_at ASC')
    .all(entityId) as Record<string, unknown>[];
  return rows.map(rowToAlias);
}

/**
 * 合并的**第一步**：标记 loser。真正的重算（canonical_key / 别名 / 冲突）见 P0-11 与详设 §2.9。
 * 这里只做不可逆动作的前半段，调用方必须放在同一事务里。
 */
export function markMerged(db: Db, loserId: string, winnerId: string): void {
  const loser = getEntity(db, loserId);
  const winner = getEntity(db, winnerId);
  if (loser === null || winner === null) {
    throw new MoshiError('E_NOT_FOUND', '合并的实体不存在', { loserId, winnerId });
  }
  if (loser.mergedInto !== null || winner.mergedInto !== null) {
    throw new MoshiError('E_CONFLICT_IDENTITY', '实体已合并过，不能重复合并', { loserId, winnerId });
  }
  if (loser.etype !== winner.etype) {
    throw new MoshiError('E_CONFLICT_IDENTITY', `etype 不同禁止合并：${loser.etype} vs ${winner.etype}`, {
      loserId,
      winnerId,
    });
  }
  db.prepare('UPDATE entity SET merged_into = ? WHERE id = ?').run(winnerId, loserId);
}

export interface EntitySearchHit {
  entity_id: string;
  canonical_name: string;
  etype: EntityType;
  /** 该实体作为 subject 的**活跃**事实数（epistemic_status='active'） */
  fact_count: number;
}

/**
 * LIKE 通配符转义：用户输入里的 `%` / `_` / `\` 一律按字面量匹配。
 * 不转义时 `q=%` 会命中全库实体（`q=a_b` 还会把 `aXb` 当成命中）。
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 实体搜索（P2-19A-02 `GET /api/search` 的数据源之一）。
 *
 * 匹配口径：canonical_name 或任一名别（alias.alias）的**子串**命中；合并 loser
 * （merged_into 非空）不出现。排序按活跃事实数降序、同数按 id 升序（两次调用逐行一致）。
 * 活跃事实的关联键是 `fact.attrs.frozen.subject.entity_id`（详设 §2.2，entity 表没有外键列）。
 */
export function searchEntitiesByName(db: Db, q: string, limit = 10): EntitySearchHit[] {
  const pattern = `%${escapeLike(q)}%`;
  return db
    .prepare(
      `SELECT e.id AS entity_id, e.canonical_name, e.etype, COUNT(f.id) AS fact_count
         FROM entity e
         LEFT JOIN fact f
           ON json_extract(f.attrs, '$.frozen.subject.entity_id') = e.id
          AND f.epistemic_status = 'active'
        WHERE e.merged_into IS NULL
          AND (e.canonical_name LIKE ? ESCAPE '\\'
               OR EXISTS (
                 SELECT 1 FROM alias a
                  WHERE a.entity_id = e.id AND a.alias LIKE ? ESCAPE '\\'
               ))
        GROUP BY e.id
        ORDER BY fact_count DESC, e.id ASC
        LIMIT ?`,
    )
    .all(pattern, pattern, limit) as EntitySearchHit[];
}

export function countEntities(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM entity').get() as { n: number };
  return row.n;
}

// ── 实体合并（P2-19A-09） ─────────────────────────────────────────────────
//
// `fact.attrs.frozen` 不可变（I2），实体归属只存在于 frozen 的
// `subject.entity_id`，没有独立列。所以合并的事实侧改判 = 重算
// `canonical_key`（它不和 frozen 绑触发器），frozen 里的 entity_id 作为
// 写入期来源保留；实体行靠 `merged_into` 表达归并。所有 SQL 留在 infra，
// core 只做决策与事务编排。

export interface EntityFactForMerge {
  factId: string;
  canonicalKey: string;
  valueHash: string;
  scope: string;
  predicate: string;
  value: unknown;
  validTo: string | null;
  epistemicStatus: string;
}

/** 某实体名下（frozen.subject.entity_id）的全部事实，按 valid_at 升序 */
export function listEntityFactsForMerge(db: Db, entityId: string): EntityFactForMerge[] {
  const rows = db
    .prepare(
      `SELECT id, canonical_key, value_hash, scope, valid_to, epistemic_status,
              json_extract(attrs, '$.frozen.predicate') AS predicate,
              json_extract(attrs, '$.frozen.value') AS value
         FROM fact
        WHERE json_extract(attrs, '$.frozen.subject.entity_id') = ?
        ORDER BY valid_at ASC, id ASC`,
    )
    .all(entityId) as Record<string, unknown>[];
  return rows.map((row) => ({
    factId: String(row['id']),
    canonicalKey: String(row['canonical_key']),
    valueHash: String(row['value_hash']),
    scope: String(row['scope']),
    predicate: String(row['predicate']),
    value: row['value'],
    validTo: (row['valid_to'] as string | null) ?? null,
    epistemicStatus: String(row['epistemic_status']),
  }));
}

/** 直接挂在实体下（不看 merged_into 链）的活跃事实数：预览用 */
export function countActiveFactsForEntity(db: Db, entityId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fact
        WHERE json_extract(attrs, '$.frozen.subject.entity_id') = ?
          AND epistemic_status = 'active'
          AND valid_to IS NULL`,
    )
    .get(entityId) as { n: number };
  return row.n;
}

/** 与该实体事实相连的活跃边数（两端任一命中）：预览的 will_move.edges */
export function countActiveEdgesForEntity(db: Db, entityId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM edge e
        WHERE e.valid_to IS NULL
          AND (EXISTS (SELECT 1 FROM fact f WHERE f.id = e.src
                        AND json_extract(f.attrs, '$.frozen.subject.entity_id') = ?)
            OR EXISTS (SELECT 1 FROM fact f WHERE f.id = e.dst
                        AND json_extract(f.attrs, '$.frozen.subject.entity_id') = ?))`,
    )
    .get(entityId, entityId) as { n: number };
  return row.n;
}

export function countAliasesForEntity(db: Db, entityId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM alias WHERE entity_id = ?').get(entityId) as {
    n: number;
  };
  return row.n;
}

/** 合并时只改 canonical_key；frozen/content 由触发器保护，不碰 */
export function updateFactCanonicalKey(db: Db, factId: string, key: string, ts: string): void {
  db.prepare('UPDATE fact SET canonical_key = ?, updated_at = ? WHERE id = ?').run(key, ts, factId);
}

/**
 * 完全重复（同 canonical_key + scope + value_hash）且对方已有活跃行：
 * 不物理删除，按生命周期收口——写 valid_to + superseded_by 指向保留行。
 */
export function closeFactAsDuplicate(
  db: Db,
  factId: string,
  supersededBy: string,
  ts: string,
): void {
  db.prepare(
    'UPDATE fact SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND valid_to IS NULL',
  ).run(ts, supersededBy, ts, factId);
}

/**
 * 别名改指：先 INSERT OR IGNORE 搬到新实体（PK 是 alias+entity_id，同名别名可在两边，
 * 搬到目标后 loser 侧删除），再重算两侧 alias_count（详设 §5.5：重算而不是 +1）。
 */
export function moveAliasesToEntity(db: Db, fromId: string, toId: string): number {
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO alias (alias, entity_id, source, confidence, created_at)
       SELECT alias, ?, source, confidence, created_at FROM alias WHERE entity_id = ?`,
    )
    .run(toId, fromId);
  db.prepare('DELETE FROM alias WHERE entity_id = ?').run(fromId);
  refreshAliasCount(db, fromId);
  refreshAliasCount(db, toId);
  return inserted.changes;
}

export function refreshAliasCount(db: Db, entityId: string): number {
  const row = db
    .prepare(
      `UPDATE entity
          SET alias_count = (SELECT COUNT(*) FROM alias WHERE entity_id = ?)
        WHERE id = ?
        RETURNING alias_count`,
    )
    .get(entityId, entityId) as { alias_count: number } | undefined;
  return row?.alias_count ?? 0;
}

export interface EntityListRow {
  entity_id: string;
  canonical_name: string;
  etype: EntityType;
  fact_count: number;
  alias_count: number;
}

/**
 * 实体列表 + **归并后**事实数：沿 merged_into 把 loser 的事实算到根实体头上。
 * 只改 canonical_key 而不改 frozen 的话（本实现如此），直接按 frozen id COUNT
 * 会把合并后的事实仍算给 loser；这里用递归 CTE 从根往下收。
 */
export function listEntitiesAggregated(db: Db, q: string, limit = 20): EntityListRow[] {
  const pattern = `%${escapeLike(q)}%`;
  return db
    .prepare(
      `WITH RECURSIVE roots(id, root) AS (
         SELECT id, id FROM entity WHERE merged_into IS NULL
         UNION ALL
         SELECT e.id, r.root FROM entity e JOIN roots r ON e.merged_into = r.id
       ),
       counts AS (
         SELECT ch.root AS root, COUNT(f.id) AS n
           FROM roots ch
           LEFT JOIN fact f
             ON json_extract(f.attrs, '$.frozen.subject.entity_id') = ch.id
            AND f.epistemic_status = 'active'
            AND f.valid_to IS NULL
          GROUP BY ch.root
       )
       SELECT e.id AS entity_id, e.canonical_name, e.etype,
              COALESCE(c.n, 0) AS fact_count,
              (SELECT COUNT(*) FROM alias a WHERE a.entity_id = e.id) AS alias_count
         FROM entity e
         LEFT JOIN counts c ON c.root = e.id
        WHERE e.merged_into IS NULL
          AND (e.canonical_name LIKE ? ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM alias a
                           WHERE a.entity_id = e.id AND a.alias LIKE ? ESCAPE '\\'))
        ORDER BY fact_count DESC, e.id ASC
        LIMIT ?`,
    )
    .all(pattern, pattern, limit) as EntityListRow[];
}
