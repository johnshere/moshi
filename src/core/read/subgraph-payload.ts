/**
 * `Subgraph` → `moshi-subgraph/2` payload（P3-07；导出与读取链共用）。
 *
 * 两处调用方：
 * - `core/lifecycle/train-export.ts`：训练样本导出；
 * - `core/read/search.ts`：查询时给 `/score` 打分（shadow/on）。
 *
 * 放在 core/read 而不是两边各写一份：节点特征（embedding/degree）与边特征字段
 * 一旦漂移，训练和推理吃的就不是同一种输入，模型会静默失准。
 */
import { buildSubgraphPayload, type MoshiSubgraphPayload } from '../../domain/subgraph.js';
import { getFact } from '../../infra/sqlite/factRepo.js';
import { getVec } from '../../infra/vec/index.js';
import type { Db } from '../../infra/sqlite/db.js';
import type { Subgraph } from './subgraph.js';

export interface PayloadBridgeResult {
  payload: MoshiSubgraphPayload;
  /** 子图里查不到 fact 行的节点（并发删除）——调用方决定是跳过还是报错 */
  missing: string[];
}

/**
 * `queryVector` 为 null 时 payload 的 `query_vector` 也是 null（模型跳过交叉注意力）。
 * 缺 embedding 的节点用 null（Python 侧零向量 + confidence 折半，P3-02 的口径）。
 */
export function buildPayloadFromSubgraph(
  db: Db,
  sub: Subgraph,
  queryVector: readonly number[] | null,
  options?: { selfAttn?: boolean; crossAttn?: boolean },
): PayloadBridgeResult {
  const missing: string[] = [];
  const nodes = [];
  for (const n of sub.nodes) {
    const fact = getFact(db, n.fact_id);
    if (fact === null) {
      missing.push(n.fact_id);
      continue;
    }
    const vec = getVec(db, n.fact_id);
    nodes.push({
      factId: n.fact_id,
      embedding: vec === null ? null : Array.from(vec),
      ftype: fact.ftype,
      confidence: fact.confidence,
      importance: fact.importance,
      epistemicStatus: fact.epistemicStatus,
      degree: fact.degree,
    });
  }

  // 边引用被跳过的节点时，`buildSubgraphPayload` 会按"边引用不存在的 factId"报错；
  // 正常不会发生（子图刚构建），真发生说明并发删了事实——由调用方决定降级。
  const kept = new Set(nodes.map((n) => n.factId));
  const edges = sub.edges
    .filter((e) => kept.has(e.src) && kept.has(e.dst))
    .map((e) => ({
      srcFactId: e.src,
      dstFactId: e.dst,
      etype: e.etype,
      weight: e.weight,
      confidence: e.confidence,
      hop: e.hop,
    }));

  return {
    payload: buildSubgraphPayload({
      queryVector,
      nodes,
      edges,
      ...(options === undefined ? {} : { options }),
    }),
    missing,
  };
}
