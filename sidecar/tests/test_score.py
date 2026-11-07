"""P3-04 `/score` 端点单测（详设 §4.6 / §7.1）。

不拉起管道进程：直接调 `dispatch()`。模型路径用未训练的 `MoshiScorer`
注入，或临时写一个 `.pt` 验证权重加载链路。
"""

import json
from pathlib import Path

import pytest
import torch

from moshi_sidecar.features import FeatureError
from moshi_sidecar.model import MoshiScorer
from moshi_sidecar.server import ModelUnavailable, State, _error_code, dispatch

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "subgraph-contract.json"


def load_payload() -> dict:
    with FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)["payload"]


def make_state(data_dir: str | None = None) -> State:
    torch.manual_seed(42)
    state = State("bge-small-zh-v1.5", 512, data_dir)
    state.scorer = MoshiScorer().eval()
    state.model_version = "test-v1"
    return state


def test_score_returns_one_entry_per_node():
    state = make_state()
    payload = load_payload()
    res = dispatch(state, "/score", payload)

    assert len(res["scores"]) == len(payload["nodes"]) == 3
    assert [s["fact_id"] for s in res["scores"]] == [n["fact_id"] for n in payload["nodes"]]
    for entry in res["scores"]:
        assert -0.15 - 1e-6 <= entry["delta"] <= 0.15 + 1e-6
        assert 0.0 <= entry["overturn_prob"] <= 1.0
    assert res["model_version"] == "test-v1"
    assert res["ms"] >= 0.0


def test_score_is_deterministic_in_eval_mode():
    state = make_state()
    payload = load_payload()
    a = dispatch(state, "/score", payload)
    b = dispatch(state, "/score", payload)
    assert [s["delta"] for s in a["scores"]] == [s["delta"] for s in b["scores"]]
    assert [s["overturn_prob"] for s in a["scores"]] == [s["overturn_prob"] for s in b["scores"]]


def test_score_rejects_bad_input_shape():
    state = make_state()
    payload = load_payload()
    payload["nodes"][0]["embedding"] = [0.1] * 511
    with pytest.raises(ValueError, match="embedding"):
        dispatch(state, "/score", payload)


def test_error_code_mapping():
    assert _error_code(FeatureError("bad shape")) == "E_INPUT_SHAPE"
    assert _error_code(ModelUnavailable("no weights")) == "E_MODEL_NOT_LOADED"


def test_score_without_weights_reports_model_unavailable(tmp_path):
    state = State("bge-small-zh-v1.5", 512, str(tmp_path))
    with pytest.raises(ModelUnavailable, match="未找到打分权重"):
        dispatch(state, "/score", load_payload())


def test_score_loads_weights_from_data_dir(tmp_path):
    models = tmp_path / "models"
    models.mkdir()
    torch.manual_seed(7)
    model = MoshiScorer()
    torch.save(
        {
            "state_dict": model.state_dict(),
            "config": {},
            "meta": {"model_version": "gat-test-7"},
        },
        models / "gat-v1.pt",
    )

    state = State("bge-small-zh-v1.5", 512, str(tmp_path))
    res = dispatch(state, "/score", load_payload())
    assert res["model_version"] == "gat-test-7"
    assert len(res["scores"]) == 3


def test_cross_attn_false_ignores_query_vector():
    """P4-02 消融：cross_attn=false 时丢掉查询向量，打分与开时不同。"""
    state = make_state()
    payload = load_payload()
    payload["query_vector"] = [0.1] * 512
    on = dispatch(state, "/score", payload)
    off = dispatch(
        state,
        "/score",
        {**payload, "options": {"self_attn": False, "cross_attn": False}},
    )
    assert [s["delta"] for s in on["scores"]] != [s["delta"] for s in off["scores"]]


def test_unload_drops_scorer():
    state = make_state()
    assert state.scorer is not None
    state.unload()
    assert state.scorer is None
    assert state.model_version is None
