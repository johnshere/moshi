/**
 * 巩固（P2-09 情景→语义）的只读检索（详设 §8.3.1）。
 *
 * 这里只做「哪一组该被提炼」的判定查询；写动作复用 `factRepo` / `edgeRepo` 的入口
 * （`insertFact` / `invalidate` / `insertEdge`），本文件不写库。
 */
import type { Fact } from '../../domain/types.js';
import type { Db } from './db.js';
import { rowToFact } from './mappers.js';

export interface ConsolidationGroup {
  canonicalKey: string;
  /** `canonical_key` 里已含 scope；单独带出来是为了建要点时不用再猜 */
  scope: string;
  /** 组内源事实 id（未排序，调用方自己排） */
  ids: string[];
}

/**
 * 找出可提炼的组：同一 `canonical_key` 下 ≥ `minCount` 条 episodic 且仍在有效期内。
 *
 * 与详设 §8.3.1 的 SQL 同义，三点差异：
 * - 只取 `active`：`disputed` 是「互斥落败但未失效」，不是已验证观测；概设风险表要求
 *   巩固只发生在 ≥3 条**已验证**观测上，把它洗成 active 结论正是要防的伪结论。
 * - `GROUP BY canonical_key, scope`：`canonical_key` 由 scope 参与哈希，理论上同 key 必同 scope，
 *   但写出来能让 `scope` 这一列有定义（SQLite 对 GROUP BY 的裸列不保证取哪一行）。
 * - 不在这里过滤「已被提炼过」：幂等键是源 id 集合的指纹，必须先把 id 取回来才算得出。
 */
export function listEpisodicGroups(db: Db, minCount: number): ConsolidationGroup[] {
  const rows = db
    .prepare(
      `SELECT canonical_key AS ck, scope AS sc, group_concat(id) AS ids
         FROM fact
        WHERE ftype = 'episodic' AND epistemic_status = 'active'
        GROUP BY canonical_key, scope
       HAVING COUNT(*) >= ?
        ORDER BY canonical_key`,
    )
    .all(minCount) as { ck: string; sc: string; ids: string }[];
  return rows.map((r) => ({ canonicalKey: r.ck, scope: r.sc, ids: r.ids.split(',') }));
}

/**
 * 该 key 下仍然活跃的**已提炼要点**（`confidence_source = 'derived'`）。
 *
 * 两个用途：命中了同一指纹 → 幂等跳过；没命中 → 新要点落库后收口旧要点，
 * 免得同一组的每一次新观测都留一个"过期结论"。
 */
export function listActiveDerivedFacts(db: Db, canonicalKey: string, scope: string): Fact[] {
  const rows = db
    .prepare(
      `SELECT * FROM fact
        WHERE canonical_key = ? AND scope = ? AND valid_to IS NULL AND confidence_source = 'derived'
        ORDER BY valid_at DESC`,
    )
    .all(canonicalKey, scope) as Record<string, unknown>[];
  return rows.map((r) => rowToFact(r));
}

/** 所有仍活跃的巩固产出（带 `ext.derived_from` 指纹，排除其它来源的 derived 行） */
export function listAllActiveDerivedPoints(db: Db): Fact[] {
  const rows = db
    .prepare(
      `SELECT * FROM fact
        WHERE valid_to IS NULL AND confidence_source = 'derived'
          AND json_extract(attrs, '$.ext.derived_from') IS NOT NULL
        ORDER BY id`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => rowToFact(r));
}

/**
 * 人工否决墓碑：同 key、同源集合指纹、已收口且没有继任点，且失效不是自动对账写的。
 *
 * `superseded_by IS NULL` 把"人工失效"（批量 / 单条 PATCH / memory_correct）与
 * "巩固因源集合变化收口"（`superseded_by = 新要点`）分开；反向对账同样会写 NULL，
 * 所以再用 audit 的来源排除它——否则源恢复后永远无法重新产出结论。
 * `epistemic_status = 'invalidated'` 再排掉 archive/prune 等也会写 `valid_to` 的
 * 收口路径：它们不是人工否决，不能被墓碑永久压住。
 */
export function hasHumanRejectedDerived(
  db: Db,
  canonicalKey: string,
  scope: string,
  fingerprint: string,
  reconcileSource: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit
         FROM fact f
        WHERE f.canonical_key = ? AND f.scope = ? AND f.confidence_source = 'derived'
          AND f.valid_to IS NOT NULL AND f.superseded_by IS NULL
          AND f.epistemic_status = 'invalidated'
          AND json_extract(f.attrs, '$.ext.derived_from') = ?
          AND NOT EXISTS (
            SELECT 1 FROM audit a
             WHERE a.tbl = 'fact' AND a.row_id = f.id AND a.source = ?
          )
        LIMIT 1`,
    )
    .get(canonicalKey, scope, fingerprint, reconcileSource) as { hit: number } | undefined;
  return row !== undefined;
}

/** 指向这些源事实的活跃派生点（失效入口的定向对账用） */
export function listActiveDerivedPointsForSources(db: Db, sourceIds: readonly string[]): Fact[] {
  if (sourceIds.length === 0) return [];
  const ph = sourceIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT f.*
         FROM fact f
         JOIN edge e ON e.src = f.id AND e.etype = 'derived_from' AND e.valid_to IS NULL
        WHERE e.dst IN (${ph})
          AND f.valid_to IS NULL AND f.confidence_source = 'derived'
          AND json_extract(f.attrs, '$.ext.derived_from') IS NOT NULL
        ORDER BY f.id`,
    )
    .all(...sourceIds) as Record<string, unknown>[];
  return rows.map((r) => rowToFact(r));
}

/** 派生点当前仍然 active 的 episodic 源数量（反向对账的判定口径） */
export function countActiveConsolidationSources(db: Db, pointId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM edge e
         JOIN fact s ON s.id = e.dst
        WHERE e.src = ? AND e.etype = 'derived_from' AND e.valid_to IS NULL
          AND s.valid_to IS NULL AND s.epistemic_status = 'active' AND s.ftype = 'episodic'`,
    )
    .get(pointId) as { n: number };
  return row.n;
}
