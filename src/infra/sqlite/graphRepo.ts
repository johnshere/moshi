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

/* ------------------------------------------------------------------------------------------------
 * 邻域查询（P2-19A-18）：`GET /api/graph/neighbors/:id`
 *
 * 与 `loadGraphPage` 同一套可见口径（`active` / `disputed` + 活跃边），区别有两点：
 * 1. 这里**不要求 layout 坐标**——邻域是被批量影响预览选中的事实子集，画不画在图上
 *    不影响 `batch/preview` 能不能算；
 * 2. 遍历用 BFS：`depth` 默认 1、上限 2，每层最多 `NEIGHBOR_LAYER_CAP` 个新节点，
 *    超出只置 `truncated` 不报错（图不可能一次全展开）。
 *
 * 顺序全部显式定死：同层按「边权降序、id 升序」，边按 `(src,dst,etype)`——验收脚本
 * 两次调用要逐行一致。
 * ---------------------------------------------------------------------------------------------- */

/** 每层最多带出多少新节点（与卡片一致；测试用它造截断） */
export const NEIGHBOR_LAYER_CAP = 200;
/** 邻域最大深度（卡片：`?depth=1|2`，超出按 400 处理，不静默夹取） */
export const NEIGHBOR_MAX_DEPTH = 2;

export interface GraphNeighborNodeRow {
  id: string;
  label: string;
  /** 卡片契约字段名是 `etype`（承载事实的 `ftype`，与 /api/graph 的 ftype 同值）；另带 ftype 便于前端复用现有编码 */
  etype: string;
  ftype: string;
  degree: number;
  communityId: number | null;
}

export interface GraphNeighborEdgeRow {
  src: string;
  dst: string;
  etype: string;
  weight: number;
}

export interface GraphNeighborhoodQuery {
  id: string;
  /** 1 或 2（默认 1）；调用方负责把非法值挡在 400 */
  depth?: number;
  /** 单层节点上限，默认 {@link NEIGHBOR_LAYER_CAP} */
  perLayerCap?: number;
}

export interface GraphNeighborhood {
  /** false = 根 id 不存在或不在可见集（路由据此回 404） */
  found: boolean;
  nodes: GraphNeighborNodeRow[];
  edges: GraphNeighborEdgeRow[];
  truncated: boolean;
}

const NEIGHBOR_COLUMNS = `
  f.id AS id,
  substr(replace(replace(f.content, char(10), ' '), char(13), ' '), 1, 48) AS label,
  f.ftype AS ftype,
  f.degree AS degree,
  f.community_id AS communityId`;

/** 按 id 批量取可见节点（顺序由调用方重排；IN 用 json_each 一次物化） */
function loadVisibleNodes(db: Db, ids: readonly string[]): GraphNeighborNodeRow[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT ${NEIGHBOR_COLUMNS}
         FROM fact f
        WHERE ${VISIBLE}
          AND f.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as GraphNeighborNodeRow[];
}

interface IncidentEdgeRow {
  src: string;
  dst: string;
  etype: string;
  weight: number;
}

/** 一端落在 frontier 里的所有活跃边（两个方向 UNION，避免 `OR` 把索引废掉） */
function loadIncidentEdges(db: Db, frontier: readonly string[]): IncidentEdgeRow[] {
  if (frontier.length === 0) return [];
  return db
    .prepare(
      `WITH frontier(id) AS MATERIALIZED (SELECT value FROM json_each(?))
       SELECT e.src AS src, e.dst AS dst, e.etype AS etype, e.weight AS weight
         FROM frontier s JOIN edge e ON e.src = s.id
        WHERE e.valid_to IS NULL
       UNION ALL
       SELECT e.src AS src, e.dst AS dst, e.etype AS etype, e.weight AS weight
         FROM frontier s JOIN edge e ON e.dst = s.id
        WHERE e.valid_to IS NULL`,
    )
    .all(JSON.stringify(frontier)) as IncidentEdgeRow[];
}

/** 两端都在给定 id 集里的活跃边（与 /api/graph 的页内边同口径，只是 id 集不是页） */
function loadEdgesWithin(db: Db, ids: readonly string[]): GraphNeighborEdgeRow[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `WITH nodes(id) AS MATERIALIZED (SELECT value FROM json_each(?))
       SELECT e.src AS src, e.dst AS dst, e.etype AS etype, e.weight AS weight
         FROM nodes s
         JOIN edge e ON e.src = s.id
         JOIN nodes d ON d.id = e.dst
        WHERE e.valid_to IS NULL
        ORDER BY e.src, e.dst, e.etype`,
    )
    .all(JSON.stringify(ids)) as GraphNeighborEdgeRow[];
}

export function loadGraphNeighborhood(db: Db, query: GraphNeighborhoodQuery): GraphNeighborhood {
  const rootRows = loadVisibleNodes(db, [query.id]);
  const root = rootRows[0];
  if (root === undefined) {
    return { found: false, nodes: [], edges: [], truncated: false };
  }

  const depth = Math.min(Math.max(Math.floor(query.depth ?? 1), 1), NEIGHBOR_MAX_DEPTH);
  const cap = Math.max(1, Math.floor(query.perLayerCap ?? NEIGHBOR_LAYER_CAP));

  const order: string[] = [root.id];
  const seen = new Set<string>(order);
  let frontier: string[] = [root.id];
  let truncated = false;

  for (let level = 1; level <= depth; level += 1) {
    const incident = loadIncidentEdges(db, frontier);
    const frontierSet = new Set(frontier);
    // 同一个邻居可能有多条边/多个方向：取最大权重，作为「谁先出」的依据
    const weightOf = new Map<string, number>();
    for (const edge of incident) {
      const candidates: { from: string; to: string }[] = [];
      if (frontierSet.has(edge.src)) candidates.push({ from: edge.src, to: edge.dst });
      if (frontierSet.has(edge.dst)) candidates.push({ from: edge.dst, to: edge.src });
      for (const { to } of candidates) {
        if (seen.has(to)) continue;
        const prev = weightOf.get(to);
        if (prev === undefined || edge.weight > prev) weightOf.set(to, edge.weight);
      }
    }
    const ranked = [...weightOf.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const visible = new Map(loadVisibleNodes(db, ranked.map(([id]) => id)).map((row) => [row.id, row]));
    const next: string[] = [];
    for (const [id] of ranked) {
      if (!visible.has(id)) continue; // 归档/剪除的邻居不出现，也不占截断名额
      if (next.length >= cap) {
        truncated = true;
        continue; // 继续扫完只为如实报 truncated（候选集已被 seen 去重，代价可控）
      }
      next.push(id);
      seen.add(id);
      order.push(id);
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const rows = new Map(loadVisibleNodes(db, order).map((row) => [row.id, row]));
  const nodes = order.map((id) => rows.get(id)).filter((row): row is GraphNeighborNodeRow => row !== undefined);

  return { found: true, nodes, edges: loadEdgesWithin(db, order), truncated };
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
