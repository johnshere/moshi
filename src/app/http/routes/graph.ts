/**
 * 图谱数据路由（P2-02 / 详设 §10.3）。
 *
 * 只此一个接口，3D（/ui/graph）和后续 2D 视图共用：
 *   GET /api/graph?limit=1000&cursor=<base64url>
 *
 * 限流是硬规矩（台账 P2-04 的坑）：默认 1000、上限 5000，**不允许一次拉全量**。
 * 边只返回两端都在本页节点里的，所以永远满足 `edges ⊆ nodes × nodes`。
 * 分页用 keyset 游标（base64url 的 `{importance,id}`），与 SQL 的
 * `ORDER BY importance DESC, id ASC` 严格一致。
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../../infra/sqlite/db.js';
import { loadGraphNeighborhood, loadGraphPage } from '../../../infra/sqlite/graphRepo.js';
import type { GraphCursor } from '../../../infra/sqlite/graphRepo.js';
import type {
  GraphEdgeRow,
  GraphNeighborEdgeRow,
  GraphNeighborNodeRow,
  GraphNodeRow,
} from '../../../infra/sqlite/graphRepo.js';

/** 默认页大小：5000 节点上 1000 一屏够看，又不至于一次吐出全部 */
export const DEFAULT_GRAPH_LIMIT = 1000;
/** 上限：前端 `REQUEST_LIMIT` 也是 5000，超过只可能是手搓请求 */
export const MAX_GRAPH_LIMIT = 5000;

interface GraphRoutesOpts {
  db: Db;
}

function decodeCursor(raw: string | undefined): GraphCursor | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      importance: unknown;
      id: unknown;
    };
    if (typeof parsed.importance === 'number' && typeof parsed.id === 'string') {
      return { importance: parsed.importance, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

function encodeCursor(node: GraphNodeRow): string {
  return Buffer.from(JSON.stringify({ importance: node.importance, id: node.id })).toString(
    'base64url',
  );
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_GRAPH_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GRAPH_LIMIT;
  return Math.min(Math.floor(n), MAX_GRAPH_LIMIT);
}

function nodeJson(n: GraphNodeRow): Record<string, unknown> {
  return {
    id: n.id,
    x: n.x,
    y: n.y,
    z: n.z,
    ftype: n.ftype,
    importance: n.importance,
    strength: n.strength,
    community_id: n.communityId,
    label: n.label,
    access_count: n.accessCount,
  };
}

function edgeJson(e: GraphEdgeRow): Record<string, unknown> {
  return { src: e.src, dst: e.dst, etype: e.etype, confidence: e.confidence };
}

/**
 * `?depth=` 只认 `1` / `2`（缺省 1）；空串、数组、`3` 一律 400。
 * 卡片写的是「上限 2」，不是「夹到 2」——静默夹取会让调用方以为拿到的是 3 跳。
 */
function parseDepth(raw: unknown): number | null {
  if (raw === undefined) return 1;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  return null;
}

function neighborNodeJson(n: GraphNeighborNodeRow): Record<string, unknown> {
  return {
    id: n.id,
    label: n.label,
    // 卡片契约字段名是 `etype`（承载事实类型）；同时保留 `ftype`，前端可直接复用
    // /api/graph 节点的编码函数，不必为邻域再写一份映射。
    etype: n.etype,
    ftype: n.ftype,
    degree: n.degree,
    community_id: n.communityId,
  };
}

function neighborEdgeJson(e: GraphNeighborEdgeRow): Record<string, unknown> {
  return { src: e.src, dst: e.dst, etype: e.etype, weight: e.weight };
}

export async function graphRoutes(app: FastifyInstance, opts: GraphRoutesOpts): Promise<void> {
  const db = opts.db;

  app.get('/', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    if (cursor === null) {
      return reply.code(400).send({ error: 'E_BAD_CURSOR', message: 'cursor 无法解析' });
    }

    const page = loadGraphPage(db, cursor === undefined ? { limit } : { limit, cursor });
    const last = page.nodes[page.nodes.length - 1];
    const nextCursor = page.hasMore && last !== undefined ? encodeCursor(last) : null;

    reply.header('cache-control', 'no-store');
    return {
      nodes: page.nodes.map(nodeJson),
      edges: page.edges.map(edgeJson),
      meta: {
        total_nodes: page.totalNodes,
        returned_nodes: page.nodes.length,
        total_edges: page.totalEdges,
        returned_edges: page.edges.length,
        truncated: page.hasMore,
        nodes_without_layout: page.nodesWithoutLayout,
        layout_version: page.layoutVersion,
        limit,
        next_cursor: nextCursor,
      },
    };
  });

  /**
   * `GET /api/graph/neighbors/:id?depth=1|2`（P2-19A-18）。
   *
   * 2D 框选后的「批量影响预览」需要知道选中节点的关联事实——图节点 id 本身就是
   * `fact.id`，所以这条路由主要给外部调用方/脚本补邻域，UI 选中集可直接当 fact id 用。
   * 只读、无新表；可见集与 /api/graph 相同（D-97），不要求 layout 坐标。
   */
  app.get('/neighbors/:id', async (req, reply) => {
    const raw = (req.params as { id?: unknown }).id;
    const id = typeof raw === 'string' ? raw : '';
    const depth = parseDepth((req.query as Record<string, unknown>).depth);
    if (depth === null) {
      return reply
        .code(400)
        .send({ error: 'E_INPUT', message: 'depth 只支持 1 或 2', detail: { reason: 'depth_invalid' } });
    }
    const hood = loadGraphNeighborhood(db, { id, depth });
    if (!hood.found) {
      return reply
        .code(404)
        .send({ error: 'E_NOT_FOUND', message: `节点不存在或不可见：${id}`, detail: { id } });
    }
    reply.header('cache-control', 'no-store');
    return {
      schema: 'moshi-graph/1',
      id,
      depth,
      nodes: hood.nodes.map(neighborNodeJson),
      edges: hood.edges.map(neighborEdgeJson),
      truncated: hood.truncated,
    };
  });
}
