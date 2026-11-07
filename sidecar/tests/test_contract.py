"""P3-00 / P3-01 契约测试（详设 §4.5、§7.2）。

P3-00（边特征）：`edge_attr` 形状 `(1, 192, 16)`、padding 行全 0、16 维逐维布局；
fixture `tests/fixtures/edge-features.json` 同时被 TS 单测
`tests/unit/edgeFeatures.test.ts` 校验。

P3-01（子图节点契约）：读取 `tests/fixtures/subgraph-contract.json` 的正式
`moshi-subgraph/1` payload，用**测试内参考实现**拼出 522 维：
`[0,512)` embedding（缺失 → 零向量 + confidence 折半）、`[512,515)` ftype one-hot、
`[515]` confidence、`[516]` importance、`[517,521)` epistemic one-hot
（`disputed` 归入 `active`）、`[521]` `log1p(degree)/log1p(64)` clamp 到 1。
再 padding/掩码成 `x (1,64,522)`、`mask (1,64)`、`edge_index (2,192)`、
`edge_mask (1,192)`。

本文件**不依赖** `sidecar/moshi_sidecar/features.py` / `model.py`（P3-02/P3-03 才落地），
也不 skip、不空断言；522 维参考实现只放在本测试文件内，不创建正式 `features.py`。
"""

import copy
import json
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
EDGE_FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "edge-features.json"
SUBGRAPH_FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "subgraph-contract.json"

# ── P3-00 边特征契约 ──────────────────────────────────────────────────────────
EDGE_DIM = 16
MAX_EDGES = 192
RESERVED_FROM = 10
REAL_EDGE_COUNT = 2

# ── P3-01 子图节点契约 ────────────────────────────────────────────────────────
EMBED_DIM = 512
NODE_FEAT_DIM = EMBED_DIM + 10  # 522
MAX_NODES = 64
SUBGRAPH_NODE_COUNT = 3
SUBGRAPH_EDGE_COUNT = 2

FTYPE_ORDER = ["semantic", "episodic", "conditional"]
EPISTEMIC_ORDER = ["active", "archived", "invalidated", "pruned"]

# 522 维布局中的标量/one-hot 起点（详见模块 docstring）
FTYPE_START = EMBED_DIM  # [512,515)
CONFIDENCE_IDX = EMBED_DIM + 3  # 515
IMPORTANCE_IDX = EMBED_DIM + 4  # 516
EPISTEMIC_START = EMBED_DIM + 5  # [517,521)
DEGREE_IDX = NODE_FEAT_DIM - 1  # 521


# ── fixture 读取 ─────────────────────────────────────────────────────────────


def load_fixture() -> dict:
    """P3-00 边特征 fixture（保留既有名称，5 个边契约用例继续使用）。"""
    assert EDGE_FIXTURE_PATH.is_file(), f"契约 fixture 不存在：{EDGE_FIXTURE_PATH}"
    with EDGE_FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_subgraph_fixture() -> dict:
    """P3-01 子图契约 fixture（顶层含测试专用 `node_feat_dim`）。"""
    assert SUBGRAPH_FIXTURE_PATH.is_file(), f"契约 fixture 不存在：{SUBGRAPH_FIXTURE_PATH}"
    with SUBGRAPH_FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


# ── P3-00 参考实现与用例（原样保留）──────────────────────────────────────────


def build_padded_edge_attr(fixture: dict) -> np.ndarray:
    """按契约把逐边 16 维行 padding 成 `(1, 192, 16)`。

    P3-00 阶段 Node 尚未产出子图 JSON，这里用 fixture 的逐边行构造；
    端到端 payload 由 P3-01 的节点契约覆盖，本函数的形状/padding 断言不变。
    """
    rows = np.asarray([edge["expected"] for edge in fixture["edges"]], dtype=np.float32)
    assert rows.ndim == 2 and rows.shape[1] == EDGE_DIM, f"逐边特征应为 (*, 16)，实际 {rows.shape}"
    edge_attr = np.zeros((1, MAX_EDGES, EDGE_DIM), dtype=np.float32)
    edge_attr[0, : rows.shape[0], :] = rows
    return edge_attr


def test_fixture_declares_the_contract():
    fixture = load_fixture()
    assert fixture["schema"] == "moshi-edge-features/1"
    assert fixture["dim"] == EDGE_DIM
    assert fixture["max_edges"] == MAX_EDGES
    assert len(fixture["edges"]) == REAL_EDGE_COUNT
    for edge in fixture["edges"]:
        assert set(edge["input"].keys()) == {"etype", "weight", "confidence", "hop", "direction"}
        assert len(edge["expected"]) == EDGE_DIM


def test_edge_attr_shape_is_1x192x16():
    fixture = load_fixture()
    edge_attr = build_padded_edge_attr(fixture)
    assert edge_attr.shape == (1, MAX_EDGES, EDGE_DIM)
    assert edge_attr.dtype == np.float32


def test_padding_rows_are_all_zero():
    fixture = load_fixture()
    edge_attr = build_padded_edge_attr(fixture)
    real = len(fixture["edges"])
    padding = edge_attr[0, real:, :]
    assert padding.shape == (MAX_EDGES - real, EDGE_DIM)
    assert np.all(padding == 0), "padding 边必须全 0"
    assert np.count_nonzero(padding) == 0


def test_real_rows_match_fixture_and_are_not_padding():
    fixture = load_fixture()
    edge_attr = build_padded_edge_attr(fixture)
    expected = np.asarray([edge["expected"] for edge in fixture["edges"]], dtype=np.float32)
    assert np.array_equal(edge_attr[0, :REAL_EDGE_COUNT, :], expected)
    # fixture 必须是非平凡样例：真实边行不能全 0，否则 padding 断言可能空转
    for row in expected:
        assert np.count_nonzero(row) > 0
    assert np.count_nonzero(edge_attr[0, :REAL_EDGE_COUNT, :]) > 0


def test_sixteen_dim_layout():
    fixture = load_fixture()
    edge_attr = build_padded_edge_attr(fixture)
    for row in edge_attr[0, :REAL_EDGE_COUNT, :]:
        # 0–5：etype one-hot，恰好一位为 1
        assert np.sum(row[:6]) == 1
        assert set(np.unique(row[:6])).issubset({0.0, 1.0})
        # 6 weight / 7 confidence：clamp 到 [0,1]
        assert 0.0 <= row[6] <= 1.0
        assert 0.0 <= row[7] <= 1.0
        # 8 hop 归一化：0 / 0.5 / 1
        assert row[8] in (0.0, 0.5, 1.0)
        # 9 方向：+1 / -1 / 0
        assert row[9] in (-1.0, 0.0, 1.0)
        # 10–15：保留位恒 0
        assert np.all(row[RESERVED_FROM:] == 0)


# ── P3-01 522 维参考实现（仅测试内，不建 features.py）─────────────────────────


def build_node_features(payload: dict) -> np.ndarray:
    """逐节点拼接 522 维，返回 `(N, 522)` float32。"""
    nodes = payload["nodes"]
    x = np.zeros((len(nodes), NODE_FEAT_DIM), dtype=np.float32)
    for i, node in enumerate(nodes):
        embedding = node["embedding"]
        confidence_scale = 1.0
        if embedding is None:
            # 缺失 embedding：向量保持 0，confidence 折半
            confidence_scale = 0.5
        else:
            vector = np.asarray(embedding, dtype=np.float32)
            assert vector.shape == (EMBED_DIM,), f"节点 {i} embedding 应为 {EMBED_DIM} 维"
            x[i, :EMBED_DIM] = vector

        ftype_idx = FTYPE_ORDER.index(node["ftype"])
        x[i, FTYPE_START + ftype_idx] = 1.0
        x[i, CONFIDENCE_IDX] = node["confidence"] * confidence_scale
        x[i, IMPORTANCE_IDX] = node["importance"]

        status = "active" if node["epistemic_status"] == "disputed" else node["epistemic_status"]
        x[i, EPISTEMIC_START + EPISTEMIC_ORDER.index(status)] = 1.0

        x[i, DEGREE_IDX] = min(1.0, np.log1p(node["degree"]) / np.log1p(MAX_NODES))
    return x


def build_node_batch(payload: dict) -> dict:
    """把参考 522 维 padding/掩码成 sidecar 输入形状。"""
    nodes = payload["nodes"]
    edges = payload["edges"]
    n_nodes = len(nodes)
    assert 1 <= n_nodes <= MAX_NODES
    assert len(edges) <= MAX_EDGES

    features = build_node_features(payload)
    x = np.zeros((1, MAX_NODES, NODE_FEAT_DIM), dtype=np.float32)
    x[0, :n_nodes, :] = features

    mask = np.zeros((1, MAX_NODES), dtype=np.float32)
    mask[0, :n_nodes] = 1.0

    edge_index = np.zeros((2, MAX_EDGES), dtype=np.int64)
    edge_mask = np.zeros((1, MAX_EDGES), dtype=np.float32)
    for j, edge in enumerate(edges):
        src, dst = edge["src"], edge["dst"]
        assert 0 <= src < n_nodes and 0 <= dst < n_nodes, f"边 {j} 下标越界：{src}->{dst}"
        edge_index[0, j] = src
        edge_index[1, j] = dst
        edge_mask[0, j] = 1.0

    return {"x": x, "mask": mask, "edge_index": edge_index, "edge_mask": edge_mask}


# ── P3-01 用例 ───────────────────────────────────────────────────────────────


def test_subgraph_fixture_declares_node_contract():
    doc = load_subgraph_fixture()
    payload = doc["payload"]
    assert doc["schema"] == "moshi-subgraph/1"
    assert payload["schema"] == "moshi-subgraph/1"
    assert doc["node_feat_dim"] == NODE_FEAT_DIM == 522
    # 测试元数据不能污染正式 payload
    assert "node_feat_dim" not in payload

    assert len(payload["nodes"]) == SUBGRAPH_NODE_COUNT == 3
    assert len(payload["edges"]) == SUBGRAPH_EDGE_COUNT == 2
    assert payload["query_vector"] is None
    assert payload["options"] == {"self_attn": False, "cross_attn": True}

    for node in payload["nodes"]:
        assert set(node.keys()) == {
            "fact_id",
            "embedding",
            "ftype",
            "confidence",
            "importance",
            "epistemic_status",
            "degree",
        }
        assert isinstance(node["fact_id"], str) and node["fact_id"]
        assert len(node["embedding"]) == EMBED_DIM
        assert node["ftype"] in FTYPE_ORDER
        assert 0.0 <= node["confidence"] <= 1.0
        assert 0.0 <= node["importance"] <= 1.0
        assert node["epistemic_status"] in ["active", "archived", "invalidated", "pruned", "disputed"]
        assert isinstance(node["degree"], int) and node["degree"] >= 0

    for edge in payload["edges"]:
        assert set(edge.keys()) == {"src", "dst", "etype", "weight", "confidence"}
        assert 0 <= edge["src"] < SUBGRAPH_NODE_COUNT
        assert 0 <= edge["dst"] < SUBGRAPH_NODE_COUNT
        assert 0.0 <= edge["weight"] <= 1.0
        assert 0.0 <= edge["confidence"] <= 1.0


def test_node_feature_layout():
    payload = load_subgraph_fixture()["payload"]
    x = build_node_features(payload)
    assert x.shape == (SUBGRAPH_NODE_COUNT, NODE_FEAT_DIM)
    assert x.shape[1] == 522
    assert x.dtype == np.float32

    for i, node in enumerate(payload["nodes"]):
        row = x[i]
        # [0,512) embedding 透传（fixture 已 L2 归一化）
        assert np.allclose(row[:EMBED_DIM], np.asarray(node["embedding"], dtype=np.float32))
        # [512,515) ftype one-hot
        ftype = row[FTYPE_START : FTYPE_START + len(FTYPE_ORDER)]
        assert np.count_nonzero(ftype) == 1
        assert ftype[FTYPE_ORDER.index(node["ftype"])] == 1.0
        # [515] confidence / [516] importance
        assert np.isclose(row[CONFIDENCE_IDX], node["confidence"])
        assert np.isclose(row[IMPORTANCE_IDX], node["importance"])
        # [517,521) epistemic one-hot（disputed→active）
        status = "active" if node["epistemic_status"] == "disputed" else node["epistemic_status"]
        epistemic = row[EPISTEMIC_START : EPISTEMIC_START + len(EPISTEMIC_ORDER)]
        assert np.count_nonzero(epistemic) == 1
        assert epistemic[EPISTEMIC_ORDER.index(status)] == 1.0
        # [521] degree 归一化
        expected_degree = min(1.0, np.log1p(node["degree"]) / np.log1p(MAX_NODES))
        assert np.isclose(row[DEGREE_IDX], expected_degree)


def test_node_batch_shapes_and_masks():
    payload = load_subgraph_fixture()["payload"]
    batch = build_node_batch(payload)

    assert batch["x"].shape == (1, MAX_NODES, NODE_FEAT_DIM)
    assert batch["x"].shape == (1, 64, 522)
    assert batch["x"].dtype == np.float32
    assert batch["mask"].shape == (1, MAX_NODES)
    assert int(batch["mask"].sum()) == SUBGRAPH_NODE_COUNT == 3
    assert set(np.unique(batch["mask"])).issubset({0.0, 1.0})

    assert batch["edge_index"].shape == (2, MAX_EDGES)
    assert batch["edge_index"].shape == (2, 192)
    assert batch["edge_mask"].shape == (1, MAX_EDGES)
    assert int(batch["edge_mask"].sum()) == SUBGRAPH_EDGE_COUNT == 2
    assert set(np.unique(batch["edge_mask"])).issubset({0.0, 1.0})


def test_node_padding_rows_are_all_zero():
    payload = load_subgraph_fixture()["payload"]
    batch = build_node_batch(payload)
    x = batch["x"]

    assert np.all(x[0, SUBGRAPH_NODE_COUNT:, :] == 0), "节点 padding 行必须全 0"
    assert np.count_nonzero(x[0, SUBGRAPH_NODE_COUNT:, :]) == 0
    assert np.all(batch["mask"][0, SUBGRAPH_NODE_COUNT:] == 0)
    # 真实节点行不能全 0，否则 padding 断言可能空转
    for i in range(SUBGRAPH_NODE_COUNT):
        assert np.count_nonzero(x[0, i, :]) > 0


def test_edge_padding_columns_are_all_zero_and_real_edges_valid():
    payload = load_subgraph_fixture()["payload"]
    batch = build_node_batch(payload)
    edge_index = batch["edge_index"]
    edge_mask = batch["edge_mask"]

    assert np.all(edge_index[:, SUBGRAPH_EDGE_COUNT:] == 0), "边 padding 列必须全 0"
    assert np.count_nonzero(edge_index[:, SUBGRAPH_EDGE_COUNT:]) == 0
    assert np.all(edge_mask[0, SUBGRAPH_EDGE_COUNT:] == 0)

    real = edge_index[:, :SUBGRAPH_EDGE_COUNT]
    assert np.all(real >= 0)
    assert np.all(real < SUBGRAPH_NODE_COUNT), "真实边下标必须指向有效节点"
    expected = np.asarray([[edge["src"], edge["dst"]] for edge in payload["edges"]], dtype=np.int64).T
    assert np.array_equal(real, expected)
    assert np.array_equal(edge_mask[0, :SUBGRAPH_EDGE_COUNT], np.ones(SUBGRAPH_EDGE_COUNT, dtype=np.float32))


def test_missing_embedding_uses_zero_vector_and_halved_confidence():
    payload = copy.deepcopy(load_subgraph_fixture()["payload"])
    original_confidence = payload["nodes"][1]["confidence"]
    payload["nodes"][1]["embedding"] = None

    x = build_node_features(payload)
    assert np.all(x[1, :EMBED_DIM] == 0), "缺失 embedding 必须是零向量"
    assert np.isclose(x[1, CONFIDENCE_IDX], original_confidence * 0.5)
    # 其它节点不受影响（未缺失 embedding 的 confidence 不折半）
    assert np.isclose(x[0, CONFIDENCE_IDX], payload["nodes"][0]["confidence"])
    assert np.isclose(x[1, IMPORTANCE_IDX], payload["nodes"][1]["importance"])
    # batch 也接受缺失 embedding
    batch = build_node_batch(payload)
    assert np.all(batch["x"][0, 1, :EMBED_DIM] == 0)


def test_disputed_epistemic_status_maps_to_active():
    payload = load_subgraph_fixture()["payload"]
    disputed = [i for i, node in enumerate(payload["nodes"]) if node["epistemic_status"] == "disputed"]
    assert disputed, "fixture 必须包含 disputed 节点，否则映射断言空转"

    x = build_node_features(payload)
    for i in disputed:
        epistemic = x[i, EPISTEMIC_START : EPISTEMIC_START + len(EPISTEMIC_ORDER)]
        assert np.array_equal(epistemic, np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float32))


def test_degree_normalization_clamps_to_one():
    payload = copy.deepcopy(load_subgraph_fixture()["payload"])
    payload["nodes"][1]["degree"] = 10**6
    x = build_node_features(payload)
    assert x[1, DEGREE_IDX] == 1.0

    # degree=0 节点归一到 0（fixture 第三个节点）
    zeros = [i for i, node in enumerate(payload["nodes"]) if node["degree"] == 0]
    assert zeros
    for i in zeros:
        assert x[i, DEGREE_IDX] == 0.0


def test_fixture_embeddings_are_l2_normalized():
    payload = load_subgraph_fixture()["payload"]
    for node in payload["nodes"]:
        norm = np.linalg.norm(np.asarray(node["embedding"], dtype=np.float64))
        assert np.isclose(norm, 1.0, atol=1e-6), f"{node['fact_id']} embedding 不是单位向量"
