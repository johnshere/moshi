/**
 * `layout` 表读写（P2-01 / 详设 §4.3 / §10.4）。
 *
 * 布局的所有 SQL 都收在这个文件里，原因不是洁癖：`tools/check-lifecycle.ts` 在
 * `src/core` 与 `src/app` 里禁止出现 `db.prepare/exec/pragma/transaction`，
 * 生命周期纪律靠"SQL 全在 infra"这条线成立。layout job 只调函数，不碰 SQL。
 *
 * 读的边界与详设一致：输入是 **active / disputed** 的事实 + **活跃边**
 * （`edge.valid_to IS NULL`）。archived / invalidated / pruned 不该占坐标——
 * 它们在图上不显示，给它们算位置只会挤压真实节点。
 */
import type { Db } from './db.js';
import { setMeta } from './metaRepo.js';
import { withTransaction } from './tx.js';

export interface LayoutFactRef {
  id: string;
  communityId: number | null;
}

export interface LayoutEdgeRef {
  source: string;
  target: string;
}

export interface LayoutSnapshot {
  facts: LayoutFactRef[];
  edges: LayoutEdgeRef[];
}

export interface LayoutCoordRow {
  id: string;
  x: number;
  y: number;
  z: number;
}

/** 读出来的行比写进去的多两个审计列（版本 / 计算时间） */
export interface LayoutRow extends LayoutCoordRow {
  version: number;
  computedAt: string;
}

/** 参与布局的事实：只取图上可见的两态（与 `isFeatureEligible` 同一口径） */
export function listLayoutFacts(db: Db): LayoutFactRef[] {
  const rows = db
    .prepare(
      `SELECT id, community_id FROM fact
        WHERE epistemic_status IN ('active','disputed')
        ORDER BY id`,
    )
    .all() as { id: string; community_id: number | null }[];
  return rows.map((r) => ({ id: r.id, communityId: r.community_id }));
}

/**
 * 参与布局的边：活跃边，**同一对事实只保留一条**。
 *
 * 两条事实间可能同时存在 `depends_on` 与 `co_occur`（唯一索引只约束同一 etype），
 * 力导向里同一对被算两次弹簧等于悄悄把 linkStrength 翻倍。布局关心的是"这两个
 * 节点连着"，不关心连了几种理由。
 */
export function listLayoutEdges(db: Db): LayoutEdgeRef[] {
  return db
    .prepare(
      `SELECT DISTINCT src AS source, dst AS target FROM edge
        WHERE valid_to IS NULL
        ORDER BY src, dst`,
    )
    .all() as LayoutEdgeRef[];
}

export function loadLayoutSnapshot(db: Db): LayoutSnapshot {
  return { facts: listLayoutFacts(db), edges: listLayoutEdges(db) };
}

export function listLayoutCoords(db: Db): LayoutRow[] {
  return db
    .prepare(
      `SELECT fact_id AS id, x, y, z, layout_version AS version, computed_at AS computedAt
         FROM layout ORDER BY fact_id`,
    )
    .all() as LayoutRow[];
}

export function maxLayoutVersion(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(layout_version), 0) AS v FROM layout').get() as {
    v: number;
  };
  return row.v;
}

/** 有新事实还没坐标时 > 0：daemon 的节流触发靠它做一次廉价脏检查 */
export function countUnlaidFacts(db: Db): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fact f
         LEFT JOIN layout l ON l.fact_id = f.id
        WHERE f.epistemic_status IN ('active','disputed') AND l.fact_id IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * 一次 job 的全部写入：同版本、同时间戳、单事务。
 *
 * `layout_version` 除了写行，还同步进 `meta`——DDL 在 001_init.sql 里预置了
 * `('layout_version','0')`，那条键是"整个库的布局代数"，后续增量/投影判新鲜度读它，
 * 而不是每次 `MAX(layout_version)` 扫表。
 */
export function writeLayout(
  db: Db,
  rows: readonly LayoutCoordRow[],
  version: number,
  computedAt: string,
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO layout (fact_id, x, y, z, layout_version, computed_at)
     VALUES (@factId, @x, @y, @z, @version, @computedAt)
     ON CONFLICT(fact_id) DO UPDATE SET
       x = excluded.x, y = excluded.y, z = excluded.z,
       layout_version = excluded.layout_version,
       computed_at = excluded.computed_at`,
  );
  withTransaction(db, () => {
    for (const r of rows) {
      stmt.run({
        factId: r.id,
        x: r.x,
        y: r.y,
        z: r.z,
        version,
        computedAt,
      });
    }
    setMeta(db, 'layout_version', String(version));
  });
}
