"""P3-06 训练脚本单测（详设 §7.4）。

只测脚本能自己负责的部分：数据加载、时间切分、λ 策略、AUC、训练可跑通、
导出可被 `MoshiScorer` 加载、同 seed 可复现。
"""

import json
from pathlib import Path

import pytest
import torch

import sys

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "sidecar"))

import train as train_mod  # noqa: E402
from moshi_sidecar.model import MoshiScorer  # noqa: E402

FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "subgraph-contract.json"


def base_payload() -> dict:
    with FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)["payload"]


def write_jsonl(path: Path, n: int, *, kinds=("overturn", "rank")) -> Path:
    payload = base_payload()
    focus = payload["nodes"][0]["fact_id"]
    lines = []
    for i in range(n):
        kind = kinds[i % len(kinds)]
        lines.append(
            json.dumps(
                {
                    "sample_id": f"ts_test_{i:04d}",
                    "query_id": f"q_{i % 4}",
                    "label_kind": kind,
                    "label": float(i % 2) if kind == "overturn" else float(i % 2),
                    "weight": 1.0,
                    "source": "adjudication" if kind == "overturn" else "feedback",
                    "created_at": f"2026-10-{1 + i // 8:02d}T00:00:0{i % 8}.000Z",
                    "focus_fact_id": focus,
                    "payload": payload,
                },
                ensure_ascii=False,
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_load_records_roundtrip(tmp_path):
    path = write_jsonl(tmp_path / "s.jsonl", 4)
    records = train_mod.load_records(path)
    assert len(records) == 4
    assert records[0].label_kind == "overturn"
    assert records[1].label_kind == "rank"
    assert records[0].payload["schema"] == "moshi-subgraph/2"


def test_load_records_rejects_bad_schema(tmp_path):
    payload = base_payload()
    payload["schema"] = "moshi-subgraph/1"
    path = tmp_path / "bad.jsonl"
    path.write_text(
        json.dumps(
            {
                "sample_id": "ts_x",
                "label_kind": "overturn",
                "label": 1.0,
                "created_at": "2026-10-01T00:00:00.000Z",
                "focus_fact_id": payload["nodes"][0]["fact_id"],
                "payload": payload,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="moshi-subgraph/2"):
        train_mod.load_records(path)


def test_split_by_time_has_no_leakage(tmp_path):
    records = train_mod.load_records(write_jsonl(tmp_path / "s.jsonl", 40))
    train_set, val_set, test_set = train_mod.split_by_time(records)
    assert len(train_set) + len(val_set) + len(test_set) == 40
    assert len(val_set) == 4 and len(test_set) == 4
    # 时间有序且三段不交叉
    assert max(r.created_at for r in train_set) <= min(r.created_at for r in val_set)
    assert max(r.created_at for r in val_set) <= min(r.created_at for r in test_set)


def test_split_tiny_dataset_goes_to_train(tmp_path):
    records = train_mod.load_records(write_jsonl(tmp_path / "s.jsonl", 2))
    train_set, val_set, test_set = train_mod.split_by_time(records)
    assert (len(train_set), len(val_set), len(test_set)) == (2, 0, 0)


def test_lambda_policy():
    # rank 样本不足 2000 → 恒 0
    assert train_mod.lambda_for(0, 0, 30) == 0.0
    assert train_mod.lambda_for(1999, 29, 30) == 0.0
    # 够 2000 → 0 线性爬到 0.3
    assert train_mod.lambda_for(2000, 0, 30) == 0.0
    assert train_mod.lambda_for(2000, 15, 30) == pytest.approx(0.3 * 15 / 29)
    assert train_mod.lambda_for(2000, 29, 30) == pytest.approx(0.3)


def test_roc_auc():
    assert train_mod.roc_auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]) == pytest.approx(1.0)
    assert train_mod.roc_auc([0, 0, 1, 1], [0.8, 0.9, 0.1, 0.2]) == pytest.approx(0.0)
    assert train_mod.roc_auc([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5]) == pytest.approx(0.5)
    assert train_mod.roc_auc([1, 1], [0.3, 0.4]) is None


def test_train_smoke_and_checkpoint(tmp_path):
    path = write_jsonl(tmp_path / "s.jsonl", 24)
    records = train_mod.load_records(path)
    result = train_mod.train(records, epochs=3, batch_size=8, seed=7)
    assert result.n_train + result.n_val + result.n_test == 24
    assert len(result.history) >= 1
    assert all(entry["lambda"] == 0.0 for entry in result.history)  # rank 样本远不足 2000

    out = tmp_path / "gat-v1.pt"
    meta = train_mod.save_checkpoint(result, out)
    assert out.exists()
    assert meta["model_version"].startswith("gat-v1@")
    assert meta["samples"] == 24

    ckpt = torch.load(out, weights_only=False)
    assert set(ckpt) == {"state_dict", "config", "meta"}
    assert ckpt["config"]["in_dim"] == 522 and ckpt["config"]["q_dim"] == 512
    model = MoshiScorer(**{k: ckpt["config"][k] for k in ("in_dim", "q_dim", "hidden", "heads", "edge_dim", "delta_cap")})
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    assert sum(p.numel() for p in model.parameters()) == 311874


def test_train_is_deterministic_with_fixed_seed(tmp_path):
    records = train_mod.load_records(write_jsonl(tmp_path / "s.jsonl", 16))
    a = train_mod.train(records, epochs=2, batch_size=8, seed=42)
    b = train_mod.train(records, epochs=2, batch_size=8, seed=42)
    sa, sb = a.model.state_dict(), b.model.state_dict()
    assert sa.keys() == sb.keys()
    for key in sa:
        assert torch.equal(sa[key], sb[key]), f"参数不一致：{key}"


def test_main_writes_checkpoint(tmp_path):
    data = write_jsonl(tmp_path / "s.jsonl", 12)
    out = tmp_path / "models" / "gat-v1.pt"
    code = train_mod.main(["--data", str(data), "--out", str(out), "--epochs", "1", "--batch-size", "4"])
    assert code == 0
    assert out.exists()
    ckpt = torch.load(out, weights_only=False)
    assert ckpt["meta"]["git_sha"]


def test_pairwise_loss_keeps_gradient():
    d_pos = torch.tensor(0.01, requires_grad=True)
    d_neg = torch.tensor(0.02, requires_grad=True)
    loss = train_mod._pairwise_loss([("q_1", d_pos, 1.0), ("q_1", d_neg, 0.0)])
    assert loss is not None
    assert loss.requires_grad
    loss.backward()
    assert d_pos.grad is not None and d_neg.grad is not None
    # 不同 query 的样本不成对
    assert train_mod._pairwise_loss([("q_1", d_pos, 1.0), ("q_2", d_neg, 0.0)]) is None


def test_pairwise_ignores_null_query():
    """query_id 为 null 的反馈不知道来自哪次查询，不能互相配对。"""
    d_pos = torch.tensor(0.01)
    d_neg = torch.tensor(0.02)
    assert train_mod._pairwise_loss([(None, d_pos, 1.0), (None, d_neg, 0.0)]) is None


def test_early_stop_falls_back_to_val_bce_when_auc_undefined(tmp_path):
    """val 集只有一类时 AUC=None，仍应能早停并选中权重（退回 -val_bce）。"""
    records = train_mod.load_records(write_jsonl(tmp_path / "s.jsonl", 6, kinds=("overturn",)))
    result = train_mod.train(records, epochs=8, batch_size=4, seed=3, patience=1)
    assert result.val_auc is None
    assert result.stopped_epoch >= 0
    assert len(result.history) < 8  # 命中早停而不是跑满
