/**
 * 训练样本导出（详设 §7.4；台账 P3-06 前置）。
 *
 * 训练脚本在 Python 侧，但**子图组装与 16 维边特征只有 TS 一份权威**（D-153）。
 * 因此导出走：`training_sample` → `buildSubgraph` → `buildSubgraphPayload`（`moshi-subgraph/2`）
 * → JSONL，每条一行 `{sample_id, label_kind, label, …, payload}`；
 * Python 训练脚本只消费 payload，不碰 SQLite、不重算特征。
 *
 * `query_vector` 在库里有 `query_log.query_text` 但没有向量：导出时可用 sidecar
 * `/encode` 现场补（`queryVectors` 注入）。补不上的样本 `query_vector=null`，
 * 模型侧会跳过交叉注意力（`model.py` 支持 None），不会污染其它样本。
 */
import { SUBGRAPH_SEED_LIMIT } from '../../domain/subgraph.js';
import type { MoshiSubgraphPayload } from '../../domain/subgraph.js';
import { buildPayloadFromSubgraph } from '../read/subgraph-payload.js';
import type { LabelKind, SampleSource } from '../../domain/enums.js';
import { getFact } from '../../infra/sqlite/factRepo.js';
import { favoredFactId, getAdjudication } from '../../infra/sqlite/adjudicationRepo.js';
import type { Db } from '../../infra/sqlite/db.js';
import {
  getQueryText,
  listSamples,
  type SampleFilter,
  type TrainingSampleRow,
} from '../../infra/sqlite/trainingSampleRepo.js';
import { buildSubgraph } from '../read/subgraph.js';

export interface SamplePayloadRecord {
  sample_id: string;
  query_id: string | null;
  label_kind: LabelKind;
  label: number;
  weight: number;
  source: SampleSource;
  created_at: string;
  /**
   * 标签挂在哪个节点上（训练时 BCE 只算这一个节点）：
   * - adjudication 样本 = 规则当时押注的 favored fact（`favoredFactId`，mutex 取 winner、
   *   temporal_invalidate 取新值、dependency_hold 无 favored → null）；
   * - feedback 样本 = 单条 `fact_id`。
   * 为 null 时训练侧跳过该样本的监督（子图仍可用于结构学习）。
   */
  focus_fact_id: string | null;
  payload: MoshiSubgraphPayload;
}

export interface ExportSkips {
  /** 样本引用的 fact 已全部被清（purge/剪枝）→ 组不出子图 */
  noNodes: number;
  /** `buildSubgraphPayload` 判定非法（正常不该出现；出现即数据损坏） */
  invalid: number;
}

export interface ExportStats {
  scanned: number;
  exported: number;
  skipped: ExportSkips;
  /** 有 query_id 且成功从 query_log 取到 text 的样本数 */
  queryWithText: number;
  /** 实际补上向量的样本数（未传 `queryVectors` 时为 0） */
  queryWithVector: number;
}

export interface ExportResult {
  records: SamplePayloadRecord[];
  stats: ExportStats;
}

export interface ExportOptions extends SampleFilter {
  limit?: number;
  /** 注入编码器（CLI 用 sidecar 的 `encode`）；不传则 query_vector 全为 null */
  queryVectors?: (texts: string[]) => Promise<number[][] | null>;
}

export async function exportTrainingPayloads(db: Db, opts: ExportOptions = {}): Promise<ExportResult> {
  const all = listSamples(db, opts);
  const rows = opts.limit === undefined ? all : all.slice(0, opts.limit);

  // ── 1) 先把用得到的 query 文本收齐，一次编码（避免逐条起请求）──
  const queryText = new Map<string, string>();
  for (const row of rows) {
    if (row.queryId === null || queryText.has(row.queryId)) continue;
    const text = getQueryText(db, row.queryId);
    if (text !== null) queryText.set(row.queryId, text);
  }
  const vectors = new Map<string, number[]>();
  if (opts.queryVectors !== undefined && queryText.size > 0) {
    const ids = [...queryText.keys()];
    const encoded = await opts.queryVectors(ids.map((id) => queryText.get(id)!));
    if (encoded !== null && encoded.length === ids.length) {
      ids.forEach((id, i) => vectors.set(id, encoded[i]!));
    }
  }

  // ── 2) 逐条组子图 → payload ──
  const stats: ExportStats = {
    scanned: rows.length,
    exported: 0,
    skipped: { noNodes: 0, invalid: 0 },
    queryWithText: rows.filter((r) => r.queryId !== null && queryText.has(r.queryId)).length,
    queryWithVector: 0,
  };
  const records: SamplePayloadRecord[] = [];

  for (const row of rows) {
    const nodeIds = row.factIds.filter((id) => getFact(db, id) !== null);
    if (nodeIds.length === 0) {
      stats.skipped.noNodes += 1;
      continue;
    }
    // 种子上限显式传入，与查询读路径共用同一常量（禁止吃默认值造成口径漂移）。
    const subgraph = buildSubgraph(db, nodeIds, { seedLimit: SUBGRAPH_SEED_LIMIT });
    let payload: MoshiSubgraphPayload;
    try {
      const bridged = buildPayloadFromSubgraph(
        db,
        subgraph,
        row.queryId === null ? null : (vectors.get(row.queryId) ?? null),
      );
      if (bridged.missing.length > 0) {
        // 子图刚查过 degree 却查不到 fact：并发删除，按非法样本跳过
        stats.skipped.invalid += 1;
        continue;
      }
      payload = bridged.payload;
    } catch {
      stats.skipped.invalid += 1;
      continue;
    }
    if (payload.query_vector !== null) stats.queryWithVector += 1;
    records.push(toRecord(row, payload, focusOf(db, row)));
  }

  stats.exported = records.length;
  return { records, stats };
}

/**
 * 标签锚点。
 *
 * `adjudication` 的 favored 只有在**有序标记版本**（`mutex_by_confidence@2`）下才敢取
 * `factIds[0]`——这套规则在 `adjudicationRepo.favoredFactId` 里已有唯一实现，这里直接复用，
 * 不在 Python 侧再写一遍（写第二份必然漂移）。
 */
function focusOf(db: Db, row: TrainingSampleRow): string | null {
  const PREFIX = 'ts_adj_';
  if (row.source === 'adjudication' && row.id.startsWith(PREFIX)) {
    const adj = getAdjudication(db, row.id.slice(PREFIX.length));
    return adj === null ? null : favoredFactId(adj);
  }
  return row.factIds[0] ?? null;
}

function toRecord(
  row: TrainingSampleRow,
  payload: MoshiSubgraphPayload,
  focusFactId: string | null,
): SamplePayloadRecord {
  return {
    sample_id: row.id,
    query_id: row.queryId,
    label_kind: row.labelKind,
    label: row.label,
    weight: row.weight,
    source: row.source,
    created_at: row.createdAt,
    focus_fact_id: focusFactId,
    payload,
  };
}

/** JSONL 序列化：一行一条，末尾换行（Python `for line in fh` 直接可用） */
export function toJsonl(records: readonly SamplePayloadRecord[]): string {
  if (records.length === 0) return '';
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}
