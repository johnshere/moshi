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
 * 与详设 §8.3.1 的 SQL 同义，两点差异：
 * - `GROUP BY canonical_key, scope`：`canonical_key` 由 scope 参与哈希，理论上同 key 必同 scope，
 *   但写出来能让 `scope` 这一列有定义（SQLite 对 GROUP BY 的裸列不保证取哪一行）。
 * - 不在这里过滤「已被提炼过」：幂等键是源 id 集合的指纹，必须先把 id 取回来才算得出。
 */
export function listEpisodicGroups(db: Db, minCount: number): ConsolidationGroup[] {
  const rows = db
    .prepare(
      `SELECT canonical_key AS ck, scope AS sc, group_concat(id) AS ids
         FROM fact
        WHERE ftype = 'episodic' AND epistemic_status IN ('active','disputed')
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
