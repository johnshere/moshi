"""P3-00 边特征契约骨架（详设 §4.5、P3-00 设计/验收 AC-3）。

P3-00 只钉契约字段：`edge_attr` 形状 `(1, 192, 16)`、padding 行全 0、
16 维逐维布局。本文件**不依赖** `features.py` / `model.py`（二者尚不存在，
P3-01/P3-02 才落地），也不 skip、不空断言。

Node 侧的真实子图 JSON → Python 端到端契约由 P3-01 在本骨架之上扩展；
当前 fixture `tests/fixtures/edge-features.json` 同时被 TS 单测
`tests/unit/edgeFeatures.test.ts` 校验，保证两侧对 16 维的逐维理解一致。
"""

import json
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "edge-features.json"

EDGE_DIM = 16
MAX_EDGES = 192
RESERVED_FROM = 10
REAL_EDGE_COUNT = 2


def load_fixture() -> dict:
    assert FIXTURE_PATH.is_file(), f"契约 fixture 不存在：{FIXTURE_PATH}"
    with FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def build_padded_edge_attr(fixture: dict) -> np.ndarray:
    """按契约把逐边 16 维行 padding 成 `(1, 192, 16)`。

    P3-00 阶段 Node 尚未产出子图 JSON，这里用 fixture 的逐边行构造；
    P3-01 会改为直接取 Node 侧 payload，但本函数的形状/padding 断言不变。
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
