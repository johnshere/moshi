/**
 * 视图查询封装（详设 §2.6）。
 *
 * 只暴露"该走哪个视图"，不暴露 SQL——视图定义在迁移里，
 * 改视图要新建迁移文件，不能在这里拼字符串绕过。
 */
import type { Db } from './db.js';

export interface DegreeRow {
  fact_id: string;
  degree: number;
}

/** 与 `fact.degree` 对账用：触发器维护的存储列 vs 实时计算 */
export function degreeMismatches(db: Db): { fact_id: string; stored: number; computed: number }[] {
  return db
    .prepare(
      `SELECT f.id AS fact_id, f.degree AS stored, v.degree AS computed
         FROM fact f JOIN v_fact_degree v ON v.fact_id = f.id
        WHERE f.degree <> v.degree`,
    )
    .all() as { fact_id: string; stored: number; computed: number }[];
}

export function orphanRatio(db: Db): { ratio: number; total: number } {
  const row = db.prepare('SELECT ratio, total FROM v_orphan_ratio').get() as
    | { ratio: number | null; total: number }
    | undefined;
  return { ratio: row?.ratio ?? 0, total: row?.total ?? 0 };
}

export function activeFactCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM v_active_fact').get() as { n: number };
  return row.n;
}

/** 重建 degree 存储列（doctor 的修复路径） */
export function rebuildDegree(db: Db): number {
  const info = db
    .prepare(
      `UPDATE fact SET degree = (
         SELECT COUNT(*) FROM edge e
          WHERE e.valid_to IS NULL AND (e.src = fact.id OR e.dst = fact.id)
       )
       WHERE degree <> (
         SELECT COUNT(*) FROM edge e
          WHERE e.valid_to IS NULL AND (e.src = fact.id OR e.dst = fact.id)
       )`,
    )
    .run();
  return info.changes;
}
