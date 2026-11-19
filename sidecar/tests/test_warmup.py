"""w6：启动 / 重载预热——就绪即稳态。

不加载真 BGE（编码器用假对象），但打分器走真 `torch_geometric` 前向，
验证「预热把 encode 和最小子图 score 都跑过一遍」且失败不阻塞就绪。
"""

from pathlib import Path

import pytest
import torch

from moshi_sidecar.features import build_batch
from moshi_sidecar.model import MoshiScorer
from moshi_sidecar.server import WARMUP_PAYLOAD, ModelUnavailable, State, dispatch

REPO_ROOT = Path(__file__).resolve().parents[2]


class FakeEncoder:
    """记录 load/encode 调用；不碰 sentence_transformers 权重。"""

    def __init__(self) -> None:
        self.loads = 0
        self.encodes: list[list[str]] = []
        self.unloads = 0

    def load(self) -> None:
        self.loads += 1

    def loaded(self) -> bool:
        return True

    def encode(self, texts: list[str]) -> list[list[float]]:
        self.encodes.append(list(texts))
        return [[0.0] * 512 for _ in texts]

    def unload(self) -> None:
        self.unloads += 1


def write_weights(tmp_path: Path) -> None:
    models = tmp_path / "models"
    models.mkdir()
    torch.manual_seed(11)
    model = MoshiScorer()
    torch.save(
        {
            "state_dict": model.state_dict(),
            "config": {},
            "meta": {"model_version": "warm-test"},
        },
        models / "gat-v1.pt",
    )


def make_state(tmp_path: Path) -> State:
    state = State("bge-small-zh-v1.5", 512, str(tmp_path))
    state.encoder = FakeEncoder()
    return state


def test_warmup_payload_is_valid_minimum_subgraph():
    """预热用的是最小合法子图：1 节点 / 0 边 / 无 embedding 与 query。"""
    batch = build_batch(WARMUP_PAYLOAD)
    assert batch["x"].shape == (1, 64, 522)
    assert batch["mask"][0, 0] == 1.0
    assert batch["query_vector"] is None


def test_warmup_runs_encoder_and_scorer(tmp_path):
    write_weights(tmp_path)
    state = make_state(tmp_path)

    state.warmup()

    # 编码器：load 一次 + 首帧 encode 一次
    assert state.encoder.loads == 1
    assert state.encoder.encodes == [["warmup"]]
    # 打分器：权重已 load、首帧前向已跑完（model_version 由权重 meta 写入）
    assert state.scorer is not None
    assert state.model_version == "warm-test"
    assert state.model_error is None


def test_warmup_failure_does_not_raise(tmp_path):
    """权重缺失：打分预热失败但不抛、不阻塞就绪。"""
    state = make_state(tmp_path)

    state.warmup()

    assert state.scorer is None
    assert state.encoder.loads == 1
    # 权重缺失时 /score 仍按既有降级路径报错
    with pytest.raises(ModelUnavailable):
        dispatch(state, "/score", WARMUP_PAYLOAD)


def test_warmup_survives_encoder_failure(tmp_path):
    """编码器预热失败：记进 model_error，流程继续（打分器照常预热）。"""
    write_weights(tmp_path)
    state = make_state(tmp_path)

    class BoomEncoder(FakeEncoder):
        def load(self) -> None:
            raise RuntimeError("模型文件缺失")

    state.encoder = BoomEncoder()
    state.warmup()  # 不抛

    assert "模型文件缺失" in (state.model_error or "")
    assert state.scorer is not None  # 打分预热不依赖编码器产物


def test_reload_warms_up_again(tmp_path):
    write_weights(tmp_path)
    state = make_state(tmp_path)
    state.warmup()
    assert state.encoder.loads == 1

    # /reload：卸载编码器后必须再预热一遍，否则下一次真实调用又付冷启
    assert dispatch(state, "/reload", {}) == {"ok": True}

    assert state.encoder.loads == 2
    assert state.encoder.encodes == [["warmup"], ["warmup"]]
    assert state.encoder.unloads == 1
    assert state.scorer is not None
