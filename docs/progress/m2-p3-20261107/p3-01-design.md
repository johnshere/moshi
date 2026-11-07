# P3-01 设计：子图契约与契约测试

状态：DESIGN_DONE（2026-11-07）
依据：任务详述 P3-01；详设 §4.5 / §7.2；P3-00 已落地的 16 维边特征契约。
前置：P3-00（`src/domain/edgeFeatures.ts`、`sidecar/tests/test_contract.py` 骨架）。

## 1. 边界

P3-01 **只做子图 JSON 组装 + Node↔Python 契约**：

- `src/domain/subgraph.ts`：把节点/边/查询向量组装成 `moshi-subgraph/1` payload，校验字段与下标；纯函数，不读 DB。
- `tests/fixtures/subgraph-contract.json`：3 节点 2 边的契约样例（含测试专用 `node_feat_dim` 元数据）。
- `sidecar/tests/test_contract.py`：在 P3-00 边契约之上，增加 Node payload 读取、522 维参考拼接、形状/掩码断言。
- `tests/unit/subgraphContract.test.ts`：组装正确性、非法输入、与 fixture 一致性。

**不做**（留给后续节点）：

- 不建 `sidecar/moshi_sidecar/features.py` 正式实现（P3-02）；Python 侧 522 维参考实现只放测试文件内。
- 不建 model、不做训练、不接 `/score`、不读 `fact_vec`/DB。
- 不改 `src/core/read/subgraph.ts` 的 BFS/裁剪逻辑；P3-01 只消费 `SubgraphNode`/`SubgraphEdge` 的语义。
- 不把 `node_feat_dim` 写进正式 payload（它是测试元数据，避免污染 `moshi-subgraph/1`）。

## 2. `moshi-subgraph/1` payload

```jsonc
{
  "schema": "moshi-subgraph/1",
  "query_vector": null,          // 或 512 维 L2 归一化向量
  "nodes": [
    { "fact_id": "f_...", "embedding": [/*512*/], "ftype": "semantic",
      "confidence": 0.95, "importance": 0.6,
      "epistemic_status": "active", "degree": 4 }
  ],
  "edges": [
    { "src": 0, "dst": 1, "etype": "depends_on", "weight": 1.0, "confidence": 0.7 }
  ],
  "options": { "self_attn": false, "cross_attn": true }
}
```

规则：

- `nodes` 1–64 条；`edges` 0–192 条；`src`/`dst` 是 `nodes` 数组下标，不是 fact_id。
- 节点 `embedding` 为 512 维或 `null`；`null` 由 Python 侧用零向量 + confidence 折半（P3-02 正式实现；P3-01 参考实现同规则）。
- `ftype` ∈ `semantic/episodic/conditional`；`epistemic_status` ∈ `active/archived/invalidated/pruned/disputed`，其中 `disputed` 在 522 维 one-hot 中归入 `active`。
- `options.self_attn` 默认 `false`，`options.cross_attn` 默认 `true`。
- 字段顺序不影响契约；JSON 值必须可复现（同一输入两次输出深相等）。
- 正式 payload 不包含 `node_feat_dim`；522 由两侧 `EMBED_DIM + 10` 派生。

## 3. TS API（`src/domain/subgraph.ts`）

```ts
export const SUBGRAPH_SCHEMA = 'moshi-subgraph/1';
export const NODE_FEAT_DIM = EMBED_DIM + 10; // 522
export const MAX_NODES = 64;
export const MAX_EDGES = 192;

export interface SubgraphNodeInput {
  factId: string;
  embedding: readonly number[] | null; // null 或 512
  ftype: Ftype;
  confidence: number;
  importance: number;
  epistemicStatus: Epistemic;
  degree: number;
}

export interface SubgraphEdgeInput {
  srcFactId: string;
  dstFactId: string;
  etype: Etype;
  weight: number;
  confidence: number;
}

export interface MoshiSubgraphPayload { /* schema/query_vector/nodes/edges/options */ }

export function buildSubgraphPayload(input: {
  queryVector: readonly number[] | null;
  nodes: readonly SubgraphNodeInput[];
  edges: readonly SubgraphEdgeInput[];
  options?: { selfAttn?: boolean; crossAttn?: boolean };
}): MoshiSubgraphPayload;
```

校验（统一抛 `MoshiError('E_INPUT')`，文案含字段名）：

- 节点数 1–64、边数 0–192；`factId` 非空且唯一。
- `embedding` 必须为 `null` 或长度 512 的有限数数组；`queryVector` 同理。
- `confidence`/`importance`/`weight` 有限数并 clamp 到 `[0,1]`；`degree` 非负整数。
- `ftype`/`epistemicStatus`/`etype` 必须在枚举内。
- 边的 `srcFactId`/`dstFactId` 必须存在于节点集合；输出下标按输入节点顺序。
- 不做 L2 归一化（Node 侧只透传；Python 侧 P3-02 归一化），但 fixture 用已归一化向量。

## 4. Python 参考契约（`sidecar/tests/test_contract.py`）

只新增测试内参考实现，不创建 `features.py`：

- `EMBED_DIM=512`、`NODE_FEAT_DIM=EMBED_DIM+10`、`MAX_NODES=64`、`MAX_EDGES=192`。
- `FTYPE_ORDER=['semantic','episodic','conditional']`；`EPISTEMIC_ORDER=['active','archived','invalidated','pruned']`。
- `build_node_features(payload) -> np.ndarray`：逐节点拼接 522 维：
  `[0,512)` embedding（缺失零向量 + confidence 折半）；`[512,515)` ftype one-hot；`[515]` confidence；`[516]` importance；`[517,521)` epistemic one-hot（disputed→active）；`[521]` `log1p(degree)/log1p(64)` clamp 到 1。
- padding：x `(1,64,522)`，`mask` `(1,64)`，节点 padding 全 0；`edge_index` `(2,192)`，`edge_mask` `(1,192)`，边 padding 为 0。
- 断言：`x.shape==(1,64,522)`、`mask.sum()==3`、`edge_index.shape==(2,192)`、`edge_mask.sum()==2`、`NODE_FEAT_DIM == fixture['node_feat_dim'] == 522`。
- P3-00 的 5 个边契约用例保留；P3-01 新增节点契约用例，共 ≥8 个。

## 5. fixture

`tests/fixtures/subgraph-contract.json`：

- 顶层 `{ "schema": "moshi-subgraph/1", "node_feat_dim": 522, "payload": {...} }`；`payload` 是正式 payload。
- 3 节点：semantic/active/degree 4、episodic/archived/degree 2、conditional/disputed/degree 0；embedding 为固定 512 维（简单确定性值，L2 归一化后写入）。
- 2 边：`0→1 depends_on weight 1.0 conf 0.7`、`1→2 co_occur weight 1.0 conf 0.9`。
- `query_vector: null`、`options {self_attn:false,cross_attn:true}`。
- 该 fixture 同时被 TS 单测（组装结果深相等）和 Python 契约测试读取。

## 6. 验收命令

- `pnpm exec vitest run tests/unit/subgraphContract.test.ts`
- `sidecar/.venv/Scripts/python.exe -m pytest sidecar/tests/test_contract.py -q`
- `pnpm verify`、`pnpm build`、`git diff --check`
