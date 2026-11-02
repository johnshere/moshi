/**
 * 图谱视图的读模型（P2-02 / 详设 §10.3）。
 *
 * 和 `layoutRepo.ts` 同一条纪律：SQL 全在 infra，`app` 层只调函数
 * （`tools/check-lifecycle.ts` 会在 `src/app` 里禁掉 `db.prepare`）。
 *
 * 三个口径，都是有意为之：
 * 1. **只读图上可见的两态**：`epistemic_status IN ('active','disputed')`——与
 *    `layoutRepo.listLayoutFacts` / `isFeatureEligible` 完全一致，不然画出来的节点集
 *    会和布局参与集不一致。
 * 2. **只读活跃边**：`edge.valid_to IS NULL`。
 * 3. **没有 layout 的节点不返回**，只在 meta 里报个数（见 `nodesWithoutLayout`）：
 *    给它们塞原点会在 (0,0,0) 堆出一个假的"超级节点"，比缺失更误导；
 *    缺坐标是 layout job 的债，不该由渲染层兜。
 *
 * 分页：`ORDER BY f.importance DESC, f.id ASC`（重要节点先出图，同分按 id 定序保证
 * 稳定），cursor 就是上一页最后一行的 `(importance, id)`。边只取两端都在本页里的，
 * 用一次物化的 CTE 传 id 数组（`json_each` 逐行重解析会慢到秒级，见下面 edges 的注释）。
 * `hasMore` 一律看「最后一行之后还有没有行」，不看「本页是否装满」（P2-02 返工 H2）。
 */
import type { Db } from './db.js';

export interface GraphNodeRow {
  id: string;
  x: number;
  y: number;
  z: number;
  ftype: string;
  importance: number;
  strength: number;
  communityId: number | null;
  label: string;
  accessCount: number;
}

export interface GraphEdgeRow {
  src: string;
  dst: string;
  etype: string;
  confidence: number;
}

export interface GraphCursor {
  importance: number;
  id: string;
}

export interface GraphPageQuery {
  limit: number;
  cursor?: GraphCursor;
}

export interface GraphPage {
  nodes: GraphNodeRow[];
  edges: GraphEdgeRow[];
  /** 图上有坐标的可见事实总数（不是全库事实数） */
  totalNodes: number;
  /** 两端都在可见且有坐标的节点集里的活跃边总数 */
  totalEdges: number;
  /** 可见但没有 layout 坐标的事实数 */
  nodesWithoutLayout: number;
  /** 当前 layout 代数，前端可以据此判断要不要刷新 */
  layoutVersion: number;
  /** 还有没有下一页 */
  hasMore: boolean;
}

const VISIBLE = "f.epistemic_status IN ('active','disputed')";

const NODE_COLUMNS = `
  f.id AS id, l.x AS x, l.y AS y, l.z AS z,
  f.ftype AS ftype, f.importance AS importance, f.strength AS strength,
  f.community_id AS communityId,
  substr(replace(replace(f.content, char(10), ' '), char(13), ' '), 1, 48) AS label,
  f.access_count AS accessCount`;

export function loadGraphPage(db: Db, query: GraphPageQuery): GraphPage {
  const limit = Math.max(1, Math.floor(query.limit));
  const cursor = query.cursor;

  const rows =
    cursor === undefined
      ? (db
          .prepare(
            `SELECT ${NODE_COLUMNS}
               FROM fact f
               JOIN layout l ON l.fact_id = f.id
              WHERE ${VISIBLE}
              ORDER BY f.importance DESC, f.id ASC
              LIMIT ?`,
          )
          .all(limit) as GraphNodeRow[])
      : (db
          .prepare(
            `SELECT ${NODE_COLUMNS}
               FROM fact f
               JOIN layout l ON l.fact_id = f.id
              WHERE ${VISIBLE}
                AND (f.importance < ? OR (f.importance = ? AND f.id > ?))
              ORDER BY f.importance DESC, f.id ASC
              LIMIT ?`,
          )
          .all(cursor.importance, cursor.importance, cursor.id, limit) as GraphNodeRow[]);

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fact f JOIN layout l ON l.fact_id = f.id WHERE ${VISIBLE}`,
    )
    .get() as { n: number };

  const missing = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fact f LEFT JOIN layout l ON l.fact_id = f.id
        WHERE ${VISIBLE} AND l.fact_id IS NULL`,
    )
    .get() as { n: number };

  const layoutVersionRow = db
    .prepare('SELECT COALESCE(MAX(layout_version), 0) AS v FROM layout')
    .get() as { v: number };

  const ids = rows.map((r) => r.id);
  // 边：只取两端都在本页里的。
  //
  // 这里必须用 `AS MATERIALIZED` 的 CTE，不能写 `e.src IN (SELECT value FROM json_each(?))`：
  // 后者在 SQLite 里会被当成逐行的相关子查询，`json_each` 对 edge 的每一行都重新解析一次
  // 5000 元素的 JSON 数组（实测 limit=5000 时 15k 边 × 5k id ≈ 7 秒）。MATERIALIZED 强制
  // 一次性物化成 5000 行的临时表，JOIN 再走 `idx_edge_src` / `idx_edge_dst`（P2-02 返工 H1）。
  const edges =
    ids.length === 0
      ? []
      : (db
          .prepare(
            `WITH page(id) AS MATERIALIZED (SELECT value FROM json_each(?))
             SELECT e.src AS src, e.dst AS dst, e.etype AS etype, e.confidence AS confidence
               FROM page s
               JOIN edge e ON e.src = s.id
               JOIN page d ON d.id = e.dst
              WHERE e.valid_to IS NULL
              ORDER BY e.src, e.dst, e.etype`,
          )
          .all(JSON.stringify(ids)) as GraphEdgeRow[]);

  const totalEdgesRow = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM edge e
         JOIN fact fs ON fs.id = e.src AND fs.epistemic_status IN ('active','disputed')
         JOIN fact fd ON fd.id = e.dst AND fd.epistemic_status IN ('active','disputed')
         JOIN layout ls ON ls.fact_id = e.src
         JOIN layout ld ON ld.fact_id = e.dst
        WHERE e.valid_to IS NULL`,
    )
    .get() as { n: number };

  const hasMore = hasMoreAfter(db, rows[rows.length - 1]);

  return {
    nodes: rows,
    edges,
    totalNodes: total.n,
    totalEdges: totalEdgesRow.n,
    nodesWithoutLayout: missing.n,
    layoutVersion: layoutVersionRow.v,
    hasMore,
  };
}

/**
 * 还有没有下一页：**看最后一行之后还有没有行**，而不是看 `本页条数 === limit`。
 *
 * 前者在「总数正好是 limit 的整数倍」时不会误报（P2-02 返工 H2：limit=1000 第 5 页
 * 正好是最后一页，旧口径 `rows.length === limit && total > limit` 仍说 truncated=true
 * 并给出 cursor，第 6 页却 0 条）；空页也恒 false。
 *
 * `LIMIT 1` + 与主查询同序的条件，命中即停，代价只有几毫秒。
 */
function hasMoreAfter(db: Db, last: GraphNodeRow | undefined): boolean {
  if (last === undefined) return false;
  const row = db
    .prepare(
      `SELECT 1 AS more
         FROM fact f
         JOIN layout l ON l.fact_id = f.id
        WHERE ${VISIBLE}
          AND (f.importance < ? OR (f.importance = ? AND f.id > ?))
        LIMIT 1`,
    )
    .get(last.importance, last.importance, last.id);
  return row !== undefined;
}
