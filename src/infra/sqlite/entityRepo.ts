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
