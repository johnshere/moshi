"""P3-02 特征张量化与 padding 单测（详设 §4.5 / §7.2）。

契约 fixture 与 TS 单测 / `test_contract.py` 共用同一份
`tests/fixtures/subgraph-contract.json`（`moshi-subgraph/2`）。
"""

import copy
import json
from pathlib import Path

import numpy as np
import pytest

from moshi_sidecar import features as F

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "subgraph-contract.json"


def load_payload() -> dict:
    with FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)["payload"]


# ── 常量契约 ────────────────────────────────────────────────────────────────


def test_constants_match_contract():
    assert F.EMBED_DIM == 512
    assert F.NODE_FEAT_DIM == F.EMBED_DIM + 10 == 522
    assert F.MAX_NODES == 64
    assert F.MAX_EDGES == 192
    assert F.EDGE_FEAT_DIM == 16
    assert F.DEFAULT_SCHEMA == "moshi-subgraph/2"


# ── 形状与掩码 ──────────────────────────────────────────────────────────────


def test_batch_shapes_and_masks():
    batch = F.build_batch(load_payload())

    assert batch["x"].shape == (1, 64, 522)
    assert batch["x"].dtype == np.float32
    assert batch["mask"].shape == (1, 64)
    assert int(batch["mask"].sum()) == 3

    assert batch["edge_index"].shape == (2, 192)
    assert batch["edge_index"].dtype == np.int64
    assert batch["edge_mask"].shape == (1, 192)
    assert int(batch["edge_mask"].sum()) == 2

    assert batch["edge_attr"].shape == (1, 192, 16)
    assert batch["edge_attr"].dtype == np.float32


def test_padding_rows_are_all_zero():
    batch = F.build_batch(load_payload())

    assert np.count_nonzero(batch["x"][0, 3:, :]) == 0
    assert np.all(batch["mask"][0, 3:] == 0)
    assert np.count_nonzero(batch["edge_index"][:, 2:]) == 0
    assert np.all(batch["edge_mask"][0, 2:] == 0)
    assert np.count_nonzero(batch["edge_attr"][0, 2:, :]) == 0


def test_real_nodes_are_not_padding():
    batch = F.build_batch(load_payload())
    for i in range(3):
        assert np.count_nonzero(batch["x"][0, i, :]) > 0


# ── 节点特征规则 ────────────────────────────────────────────────────────────


def test_node_layout_on_fixture():
    payload = load_payload()
    x = F.build_node_features(payload)

    assert x.shape == (3, 522)
    for i, node in enumerate(payload["nodes"]):
        assert np.allclose(x[i, :512], node["embedding"])
        assert x[i, F.FTYPE_START + F.FTYPE_ORDER.index(node["ftype"])] == 1.0
        assert np.isclose(x[i, F.CONFIDENCE_IDX], node["confidence"])
        assert np.isclose(x[i, F.IMPORTANCE_IDX], node["importance"])
        expected_degree = min(1.0, np.log1p(node["degree"]) / np.log1p(64))
        assert np.isclose(x[i, F.DEGREE_IDX], expected_degree)


def test_procedural_ftype_folds_into_semantic_slot():
    """V-05 新增的 `procedural` 不在详设 §7.2 的三桶里，暂归 semantic（522 维不变）。"""
    payload = copy.deepcopy(load_payload())
    payload["nodes"][0]["ftype"] = "procedural"

    x = F.build_node_features(payload)

    assert x.shape == (3, 522)
    assert x[0, F.FTYPE_START + F.FTYPE_ORDER.index("semantic")] == 1.0
    assert np.count_nonzero(x[0, F.FTYPE_START : F.FTYPE_START + len(F.FTYPE_ORDER)]) == 1


def test_missing_embedding_is_zero_vector_and_halves_confidence():
    payload = copy.deepcopy(load_payload())
    original = payload["nodes"][1]["confidence"]
    payload["nodes"][1]["embedding"] = None

    x = F.build_node_features(payload)
    assert np.all(x[1, :512] == 0)
    assert np.isclose(x[1, F.CONFIDENCE_IDX], original * 0.5)
    # 未缺失的节点不折半
    assert np.isclose(x[0, F.CONFIDENCE_IDX], payload["nodes"][0]["confidence"])


def test_disputed_maps_to_active():
    payload = load_payload()
    x = F.build_node_features(payload)
    row = x[2, F.EPISTEMIC_START : F.EPISTEMIC_START + 4]
    assert np.array_equal(row, np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32))


def test_degree_above_64_clamps_to_one():
    payload = copy.deepcopy(load_payload())
    payload["nodes"][1]["degree"] = 65
    x = F.build_node_features(payload)
    assert x[1, F.DEGREE_IDX] == 1.0


def test_embedding_is_re_normalized():
    payload = copy.deepcopy(load_payload())
    payload["nodes"][0]["embedding"] = [3.0, 4.0] + [0.0] * 510

    x = F.build_node_features(payload)
    vector = x[0, :512]
    assert np.isclose(np.linalg.norm(vector), 1.0, atol=1e-6)
    assert np.isclose(vector[0], 0.6, atol=1e-6)
    assert np.isclose(vector[1], 0.8, atol=1e-6)


def test_query_vector_is_re_normalized_or_none():
    payload = load_payload()
    assert F.build_batch(payload)["query_vector"] is None

    payload["query_vector"] = [0.0, 2.0] + [0.0] * 510
    query = F.build_batch(payload)["query_vector"]
    assert query.shape == (512,)
    assert np.isclose(np.linalg.norm(query), 1.0, atol=1e-6)


# ── 边特征：只透传 Node 的 edge_attr ────────────────────────────────────────


def test_edge_attr_is_passed_through_from_payload():
    payload = load_payload()
    rows = F.build_edge_attr(payload)
    expected = np.asarray([edge["edge_attr"] for edge in payload["edges"]], dtype=np.float32)
    assert np.array_equal(rows, expected)

    batch = F.build_batch(payload)
    assert np.array_equal(batch["edge_attr"][0, :2, :], expected)


def test_edge_index_matches_payload():
    payload = load_payload()
    batch = F.build_batch(payload)
    expected = np.asarray([[e["src"], e["dst"]] for e in payload["edges"]], dtype=np.int64).T
    assert np.array_equal(batch["edge_index"][:, :2], expected)


# ── 非法输入 ────────────────────────────────────────────────────────────────


def test_rejects_wrong_schema():
    payload = copy.deepcopy(load_payload())
    payload["schema"] = "moshi-subgraph/1"
    with pytest.raises(F.FeatureError, match="schema"):
        F.build_batch(payload)


def test_rejects_bad_embedding_shape():
    payload = copy.deepcopy(load_payload())
    payload["nodes"][0]["embedding"] = [0.1] * 511
    with pytest.raises(F.FeatureError, match="embedding"):
        F.build_node_features(payload)


def test_rejects_bad_edge_attr_shape():
    payload = copy.deepcopy(load_payload())
    payload["edges"][0]["edge_attr"] = [0.0] * 15
    with pytest.raises(F.FeatureError, match="edge_attr"):
        F.build_edge_attr(payload)


def test_rejects_edge_index_out_of_range():
    payload = copy.deepcopy(load_payload())
    payload["edges"][0]["dst"] = 3
    with pytest.raises(F.FeatureError, match="越界"):
        F.build_batch(payload)


def test_rejects_unknown_ftype_and_status():
    payload = copy.deepcopy(load_payload())
    payload["nodes"][0]["ftype"] = "unknown"
    with pytest.raises(F.FeatureError, match="ftype"):
        F.build_node_features(payload)

    payload = copy.deepcopy(load_payload())
    payload["nodes"][0]["epistemic_status"] = "unknown"
    with pytest.raises(F.FeatureError, match="epistemic_status"):
        F.build_node_features(payload)
