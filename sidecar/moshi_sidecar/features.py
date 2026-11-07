"""P3-02：`moshi-subgraph/2` → 模型输入张量（详设 §4.5 / §7.2）。

Node 侧（`src/domain/subgraph.ts`）已把 16 维边特征 `edge_attr` 算好并写进
payload；本模块**只做**节点 522 维拼接、embedding L2 重归一、padding 与 mask，
不再重写 16 维规则（决策 D-153：16 维唯一权威在 TS）。

形状契约（详设 §7.2 契约测试）：

- `x`          `(1, 64, 522)` float32
- `mask`       `(1, 64)` float32（1 = 真实节点，0 = padding）
- `edge_index` `(2, 192)` int64
- `edge_mask`  `(1, 192)` float32
- `edge_attr`  `(1, 192, 16)` float32

节点 522 维布局与 TS 侧 `domain/subgraph.ts` 的 `NODE_FEAT_DIM` 同源：
`[0,512)` embedding（L2 归一）；`[512,515)` ftype one-hot；`[515]` confidence；
`[516]` importance；`[517,521)` epistemic one-hot（`disputed` 归入 `active`）；
`[521]` `log1p(degree)/log1p(64)` clamp 到 1。缺 embedding → 零向量 +
confidence 折半。
"""

from __future__ import annotations

import numpy as np

EMBED_DIM = 512
NODE_FEAT_DIM = EMBED_DIM + 10  # 522
MAX_NODES = 64
MAX_EDGES = 192
EDGE_FEAT_DIM = 16

FTYPE_ORDER = ("semantic", "episodic", "conditional")
EPISTEMIC_ORDER = ("active", "archived", "invalidated", "pruned")

FTYPE_START = EMBED_DIM  # [512,515)
CONFIDENCE_IDX = EMBED_DIM + 3  # 515
IMPORTANCE_IDX = EMBED_DIM + 4  # 516
EPISTEMIC_START = EMBED_DIM + 5  # [517,521)
DEGREE_IDX = NODE_FEAT_DIM - 1  # 521
_DEGREE_DIVISOR = float(np.log1p(MAX_NODES))

DEFAULT_SCHEMA = "moshi-subgraph/2"


class FeatureError(ValueError):
    """子图 payload 不满足张量化契约。P3-04 映射为 `E_INPUT_SHAPE`。"""


def _finite_array(value: object, shape: tuple[int, ...], field: str) -> np.ndarray:
    arr = np.asarray(value, dtype=np.float32)
    if arr.shape != shape:
        raise FeatureError(f"{field} 形状应为 {shape}，实际 {arr.shape}")
    if not np.all(np.isfinite(arr)):
        raise FeatureError(f"{field} 含非有限数值")
    return arr


def _l2_normalize(vector: np.ndarray) -> np.ndarray:
    """L2 重归一；零向量原样返回（缺 embedding 路径不应除零）。"""
    norm = float(np.linalg.norm(vector))
    if norm == 0.0:
        return vector
    return vector / norm


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, float(value)))


def _payload_nodes(payload: dict) -> list:
    nodes = payload.get("nodes")
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= MAX_NODES:
        raise FeatureError(f"nodes 必须是 1–{MAX_NODES} 条的数组")
    return nodes


def _payload_edges(payload: dict) -> list:
    edges = payload.get("edges")
    if not isinstance(edges, list) or len(edges) > MAX_EDGES:
        raise FeatureError(f"edges 必须是 0–{MAX_EDGES} 条的数组")
    return edges


def build_node_features(payload: dict) -> np.ndarray:
    """逐节点拼接 522 维，返回 `(N, 522)` float32（不含 padding）。"""
    nodes = _payload_nodes(payload)
    x = np.zeros((len(nodes), NODE_FEAT_DIM), dtype=np.float32)

    for i, node in enumerate(nodes):
        embedding = node.get("embedding")
        confidence_scale = 1.0
        if embedding is None:
            # 缺失 embedding：向量保持 0，confidence 折半
            confidence_scale = 0.5
        else:
            vector = _finite_array(embedding, (EMBED_DIM,), f"nodes[{i}].embedding")
            x[i, :EMBED_DIM] = _l2_normalize(vector)

        ftype = node.get("ftype")
        if ftype not in FTYPE_ORDER:
            raise FeatureError(f"nodes[{i}].ftype 未知：{ftype!r}")
        x[i, FTYPE_START + FTYPE_ORDER.index(ftype)] = 1.0

        x[i, CONFIDENCE_IDX] = _clamp01(node.get("confidence", 0.0)) * confidence_scale
        x[i, IMPORTANCE_IDX] = _clamp01(node.get("importance", 0.0))

        status = node.get("epistemic_status")
        if status == "disputed":
            status = "active"
        if status not in EPISTEMIC_ORDER:
            raise FeatureError(f"nodes[{i}].epistemic_status 未知：{node.get('epistemic_status')!r}")
        x[i, EPISTEMIC_START + EPISTEMIC_ORDER.index(status)] = 1.0

        degree = node.get("degree", 0)
        if not isinstance(degree, (int, np.integer)) or degree < 0:
            raise FeatureError(f"nodes[{i}].degree 必须是非负整数")
        x[i, DEGREE_IDX] = min(1.0, float(np.log1p(degree)) / _DEGREE_DIVISOR)

    return x


def build_edge_attr(payload: dict) -> np.ndarray:
    """逐边取 Node 算好的 16 维特征，返回 `(E, 16)` float32（不含 padding）。"""
    edges = _payload_edges(payload)
    rows = np.zeros((len(edges), EDGE_FEAT_DIM), dtype=np.float32)
    for j, edge in enumerate(edges):
        rows[j] = _finite_array(edge.get("edge_attr"), (EDGE_FEAT_DIM,), f"edges[{j}].edge_attr")
    return rows


def build_query_vector(payload: dict) -> np.ndarray | None:
    """查询向量 L2 重归一；`null`（纯结构模式）返回 None。"""
    value = payload.get("query_vector")
    if value is None:
        return None
    vector = _finite_array(value, (EMBED_DIM,), "query_vector")
    return _l2_normalize(vector)


def build_batch(payload: dict) -> dict:
    """把子图 padding/掩码成模型输入形状（见模块 docstring）。"""
    schema = payload.get("schema")
    if schema != DEFAULT_SCHEMA:
        raise FeatureError(f"schema 必须是 {DEFAULT_SCHEMA!r}，实际 {schema!r}")

    nodes = _payload_nodes(payload)
    edges = _payload_edges(payload)
    n_nodes, n_edges = len(nodes), len(edges)

    x = np.zeros((1, MAX_NODES, NODE_FEAT_DIM), dtype=np.float32)
    x[0, :n_nodes, :] = build_node_features(payload)

    mask = np.zeros((1, MAX_NODES), dtype=np.float32)
    mask[0, :n_nodes] = 1.0

    edge_index = np.zeros((2, MAX_EDGES), dtype=np.int64)
    edge_mask = np.zeros((1, MAX_EDGES), dtype=np.float32)
    edge_attr = np.zeros((1, MAX_EDGES, EDGE_FEAT_DIM), dtype=np.float32)
    edge_attr[0, :n_edges, :] = build_edge_attr(payload)

    for j, edge in enumerate(edges):
        src, dst = edge.get("src"), edge.get("dst")
        if not isinstance(src, int) or not isinstance(dst, int):
            raise FeatureError(f"edges[{j}] 的 src/dst 必须是整数下标")
        if not (0 <= src < n_nodes and 0 <= dst < n_nodes):
            raise FeatureError(f"edges[{j}] 下标越界：{src}->{dst}")
        edge_index[0, j] = src
        edge_index[1, j] = dst
        edge_mask[0, j] = 1.0

    return {
        "x": x,
        "mask": mask,
        "edge_index": edge_index,
        "edge_mask": edge_mask,
        "edge_attr": edge_attr,
        "query_vector": build_query_vector(payload),
    }
