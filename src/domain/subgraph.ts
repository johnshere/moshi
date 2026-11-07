/**
 * 子图 JSON 契约（`moshi-subgraph/2`，详设 §4.5 / §7.2，P3-01 / P3-02）。
 *
 * 本模块把「节点 / 边 / 查询向量」组装成发给 Python sidecar 的正式 payload：
 * - 边端点 `src`/`dst` 转成 `nodes` 数组下标（不是 fact_id）；
 * - 边特征 `edge_attr`（16 维）由本模块调 `domain/edgeFeatures.ts` 算好写在
 *   每条边上——16 维规则只有 TS 一份权威，Python 侧只校验与 padding（P3-02，
 *   D-153）；
 * - `confidence` / `importance` / `weight` 统一 clamp 到 `[0,1]`；
 * - 纯函数、不读 DB、不读 `fact_vec`、不做 L2 归一化（Node 侧只透传，
 *   Python 侧归一化）。
 *
 * `/2` 相对 `/1` 的唯一改动：`edges[]` 增加 `edge_attr`。节点 522 维规则不变。
 *
 * 正式 payload **不包含** `node_feat_dim`：522 维由两侧 `EMBED_DIM + 10` 派生；
 * 契约 fixture 顶层的 `node_feat_dim` 只是测试元数据。
 *
 * 形状契约：节点 padding 到 64、边 padding 到 192 是 Python 侧（`(1,64,522)` /
 * `(2,192)`）的事；本模块只校验并组装真实节点/边，不补 padding 行。
 */
import { EDGE_PAD_MAX, edgeFeatures } from './edgeFeatures.js';
import { EMBED_DIM } from './embedding.js';
import { EPISTEMIC, ETYPE, FTYPE, isOneOf, type Epistemic, type Etype, type Ftype } from './enums.js';
import { MoshiError } from './errors.js';

/** payload 版本；拼接顺序或字段语义改动即升版本。 */
export const SUBGRAPH_SCHEMA = 'moshi-subgraph/2';

/** 节点特征总维度（详设 §4.5）：512 维 embedding + 10 维标量/one-hot。 */
export const NODE_FEAT_DIM = EMBED_DIM + 10;

/** 子图节点上限（详设 §6.6）。 */
export const MAX_NODES = 64;

/** 子图边上限（详设 §6.6）；与边特征 padding 上限同源。 */
export const MAX_EDGES = EDGE_PAD_MAX;

export interface SubgraphNodeInput {
  readonly factId: string;
  /** `null` 表示缺 embedding（Python 侧零向量 + confidence 折半）。 */
  readonly embedding: readonly number[] | null;
  readonly ftype: Ftype;
  readonly confidence: number;
  readonly importance: number;
  readonly epistemicStatus: Epistemic;
  readonly degree: number;
}

export interface SubgraphEdgeInput {
  readonly srcFactId: string;
  readonly dstFactId: string;
  readonly etype: Etype;
  readonly weight: number;
  readonly confidence: number;
  /** BFS 层数（1 跳 / 2 跳）；由 `core/read/subgraph.ts` 提供（D-155）。 */
  readonly hop: 1 | 2;
}

export interface SubgraphPayloadNode {
  readonly fact_id: string;
  readonly embedding: number[] | null;
  readonly ftype: Ftype;
  readonly confidence: number;
  readonly importance: number;
  readonly epistemic_status: Epistemic;
  readonly degree: number;
}

export interface SubgraphPayloadEdge {
  /** `nodes` 数组下标。 */
  readonly src: number;
  /** `nodes` 数组下标。 */
  readonly dst: number;
  readonly etype: Etype;
  readonly weight: number;
  readonly confidence: number;
  /** 16 维边特征（`domain/edgeFeatures.ts` 唯一权威，D-153）。 */
  readonly edge_attr: number[];
}

export interface SubgraphPayloadOptions {
  readonly self_attn: boolean;
  readonly cross_attn: boolean;
}

export interface MoshiSubgraphPayload {
  readonly schema: typeof SUBGRAPH_SCHEMA;
  readonly query_vector: number[] | null;
  readonly nodes: SubgraphPayloadNode[];
  readonly edges: SubgraphPayloadEdge[];
  readonly options: SubgraphPayloadOptions;
}

export interface BuildSubgraphPayloadInput {
  readonly queryVector: readonly number[] | null;
  readonly nodes: readonly SubgraphNodeInput[];
  readonly edges: readonly SubgraphEdgeInput[];
  readonly options?: {
    readonly selfAttn?: boolean;
    readonly crossAttn?: boolean;
  };
}

function inputError(field: string, message: string, detail: Record<string, unknown> = {}): MoshiError {
  return new MoshiError('E_INPUT', `buildSubgraphPayload: ${message}`, { field, ...detail });
}

function validateEmbedding(value: unknown, field: string): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw inputError(field, `${field} 必须是 null 或 ${EMBED_DIM} 维有限数数组`);
  }
  if (value.length !== EMBED_DIM) {
    throw inputError(field, `${field} 长度必须是 ${EMBED_DIM}（实际 ${value.length}）`, {
      length: value.length,
    });
  }
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const n: unknown = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw inputError(`${field}[${i}]`, `${field}[${i}] 必须是有限数值`, { index: i, value: String(n) });
    }
    out.push(n);
  }
  return out;
}

function validateClamped01(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw inputError(field, `${field} 必须是有限数值`, { value: String(value) });
  }
  return Math.min(1, Math.max(0, value));
}

function validateDegree(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw inputError(field, `${field} 必须是非负整数`, { value: String(value) });
  }
  return value;
}

function validateFactId(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw inputError(field, `${field} 必须是非空字符串`);
  }
  return value;
}

function readBoolOption(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw inputError(field, `${field} 必须是布尔值`, { value: String(value) });
  }
  return value;
}

/** 无向边类型：`direction` 恒为 0（D-154）。其余 etype 视为有向。 */
const UNDIRECTED_ETYPE: ReadonlySet<Etype> = new Set<Etype>(['logic', 'mutually_exclusive', 'co_occur']);

function validateHop(value: unknown, field: string): 1 | 2 {
  if (value !== 1 && value !== 2) {
    throw inputError(field, `${field} 只能是 1 或 2`, { value: String(value) });
  }
  return value;
}

/** 详设 §4.5 第 9 维：`dst` 下标前进 +1、逆序 −1、无向 0（D-154）。 */
function directionOf(etype: Etype, src: number, dst: number): 1 | -1 | 0 {
  if (UNDIRECTED_ETYPE.has(etype)) return 0;
  if (dst > src) return 1;
  if (dst < src) return -1;
  return 0;
}

/**
 * 组装 `moshi-subgraph/2` payload。
 *
 * @throws MoshiError `E_INPUT`——节点/边数量越界、factId 空或重复、embedding /
 *         queryVector 非法、confidence/importance/weight 非有限数、degree 非法、
 *         hop 非 1/2、ftype/epistemicStatus/etype 未知、边引用不存在的 factId。
 */
export function buildSubgraphPayload(input: BuildSubgraphPayloadInput): MoshiSubgraphPayload {
  const { nodes, edges } = input;

  if (!Array.isArray(nodes)) {
    throw inputError('nodes', 'nodes 必须是数组');
  }
  if (nodes.length < 1 || nodes.length > MAX_NODES) {
    throw inputError('nodes', `nodes 数量必须在 1–${MAX_NODES}（实际 ${nodes.length}）`, {
      count: nodes.length,
    });
  }
  if (!Array.isArray(edges)) {
    throw inputError('edges', 'edges 必须是数组');
  }
  if (edges.length > MAX_EDGES) {
    throw inputError('edges', `edges 数量不能超过 ${MAX_EDGES}（实际 ${edges.length}）`, {
      count: edges.length,
    });
  }

  const queryVector = validateEmbedding(input.queryVector, 'queryVector');

  const optionsInput = input.options;
  if (optionsInput !== undefined && (optionsInput === null || typeof optionsInput !== 'object')) {
    throw inputError('options', 'options 必须是对象');
  }
  const selfAttn = readBoolOption(optionsInput?.selfAttn, 'options.selfAttn', false);
  const crossAttn = readBoolOption(optionsInput?.crossAttn, 'options.crossAttn', true);

  const index = new Map<string, number>();
  const payloadNodes: SubgraphPayloadNode[] = nodes.map((node, i) => {
    if (node === null || typeof node !== 'object') {
      throw inputError(`nodes[${i}]`, `nodes[${i}] 必须是对象`);
    }
    const field = `nodes[${i}]`;
    const factId = validateFactId(node.factId, `${field}.factId`);
    if (index.has(factId)) {
      throw inputError(`${field}.factId`, `重复 factId "${factId}"`, { factId });
    }
    if (!isOneOf(FTYPE, node.ftype)) {
      throw inputError(`${field}.ftype`, `未知 ftype "${String(node.ftype)}"`, {
        ftype: String(node.ftype),
      });
    }
    if (!isOneOf(EPISTEMIC, node.epistemicStatus)) {
      throw inputError(
        `${field}.epistemicStatus`,
        `未知 epistemicStatus "${String(node.epistemicStatus)}"`,
        { epistemicStatus: String(node.epistemicStatus) },
      );
    }
    const payloadNode: SubgraphPayloadNode = {
      fact_id: factId,
      embedding: validateEmbedding(node.embedding, `${field}.embedding`),
      ftype: node.ftype,
      confidence: validateClamped01(node.confidence, `${field}.confidence`),
      importance: validateClamped01(node.importance, `${field}.importance`),
      epistemic_status: node.epistemicStatus,
      degree: validateDegree(node.degree, `${field}.degree`),
    };
    index.set(factId, i);
    return payloadNode;
  });

  const payloadEdges: SubgraphPayloadEdge[] = edges.map((edge, j) => {
    if (edge === null || typeof edge !== 'object') {
      throw inputError(`edges[${j}]`, `edges[${j}] 必须是对象`);
    }
    const field = `edges[${j}]`;
    const srcFactId = validateFactId(edge.srcFactId, `${field}.srcFactId`);
    const dstFactId = validateFactId(edge.dstFactId, `${field}.dstFactId`);
    const src = index.get(srcFactId);
    if (src === undefined) {
      throw inputError(`${field}.srcFactId`, `边 srcFactId "${srcFactId}" 不在节点集合内`, {
        factId: srcFactId,
      });
    }
    const dst = index.get(dstFactId);
    if (dst === undefined) {
      throw inputError(`${field}.dstFactId`, `边 dstFactId "${dstFactId}" 不在节点集合内`, {
        factId: dstFactId,
      });
    }
    if (!isOneOf(ETYPE, edge.etype)) {
      throw inputError(`${field}.etype`, `未知 etype "${String(edge.etype)}"`, {
        etype: String(edge.etype),
      });
    }
    const weight = validateClamped01(edge.weight, `${field}.weight`);
    const confidence = validateClamped01(edge.confidence, `${field}.confidence`);
    const hop = validateHop(edge.hop, `${field}.hop`);
    return {
      src,
      dst,
      etype: edge.etype,
      weight,
      confidence,
      edge_attr: edgeFeatures({
        etype: edge.etype,
        weight,
        confidence,
        hop,
        direction: directionOf(edge.etype, src, dst),
      }),
    };
  });

  return {
    schema: SUBGRAPH_SCHEMA,
    query_vector: queryVector,
    nodes: payloadNodes,
    edges: payloadEdges,
    options: { self_attn: selfAttn, cross_attn: crossAttn },
  };
}
