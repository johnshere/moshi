#!/usr/bin/env python
"""GAT 训练脚本（详设 §7.4；台账 P3-06）。

只吃 `moshi samples export` 产出的 JSONL（`moshi-subgraph/2` payload），
不碰 SQLite、不重算特征——16 维边特征与 522 维节点特征只有 TS 侧一份权威（D-153）。

用法：
    python sidecar/train.py --data <samples.jsonl> --out <data_dir>/models/gat-v1.pt

训练配置（详设 §7.4 原样）：
- 损失：`BCEWithLogits(overturn_logit, y) + λ * pairwise_margin(delta)`
- λ：0 → 0.3 线性爬升，**仅当 train 侧 rank 样本 ≥ 2000** 才启用
- pairwise：`max(0, m - (δ_pos - δ_neg))`，m = 0.1，只配同 query 内的样本对
- 优化器：AdamW lr=1e-3, weight_decay=1e-4；有效 batch 32 个子图（逐图前向累加梯度）
- epoch 30，早停 val AUC 连续 5 轮不升
- **按时间切 8:1:1**（随机切会让同一天样本泄漏到验证集）
- seed=42，`torch.use_deterministic_algorithms(True)`

导出格式与 §7.4 一致：`{state_dict, config, meta}`，`meta.model_version` 由
`git_sha` 派生，供 `/health` 与 `/score` 回传。
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from moshi_sidecar.features import build_batch
from moshi_sidecar.model import MoshiScorer

LAMBDA_MAX = 0.3
MIN_RANK_SAMPLES = 2000
MARGIN = 0.1
DEFAULT_SEED = 42
DEFAULT_EPOCHS = 30
DEFAULT_BATCH = 32


# ---------------------------------------------------------------- 数据


@dataclass
class Example:
    """一条样本：张量 + 标签锚点。张量在训练时按需构建（不预展开整个数据集）。"""

    sample_id: str
    label_kind: str
    label: float
    weight: float
    created_at: str
    query_id: str | None
    focus_fact_id: str | None
    payload: dict
    tensors: dict | None = field(default=None, repr=False)


def load_records(path: str | Path) -> list[Example]:
    records: list[Example] = []
    with Path(path).open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
                payload = raw["payload"]
                if payload.get("schema") != "moshi-subgraph/2":
                    raise ValueError(f"schema 不是 moshi-subgraph/2：{payload.get('schema')}")
                records.append(
                    Example(
                        sample_id=str(raw["sample_id"]),
                        label_kind=str(raw["label_kind"]),
                        label=float(raw["label"]),
                        weight=float(raw.get("weight", 1.0)),
                        created_at=str(raw["created_at"]),
                        query_id=raw.get("query_id"),
                        focus_fact_id=raw.get("focus_fact_id"),
                        payload=payload,
                    )
                )
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"{path}:{line_no} 样本非法：{exc}") from exc
    return records


def split_by_time(
    records: list[Example], ratios: tuple[float, float, float] = (0.8, 0.1, 0.1)
) -> tuple[list[Example], list[Example], list[Example]]:
    """按 `created_at` 升序切 8:1:1；相同时间戳按 sample_id 定序，保证可复现。

    样本量 < 3 时全部给 train（没有足够数据切验证集，早停自然不发生）。
    """
    ordered = sorted(records, key=lambda r: (r.created_at, r.sample_id))
    n = len(ordered)
    if n < 3:
        return ordered, [], []
    n_train = int(n * ratios[0])
    n_val = int(n * ratios[1])
    n_train = max(1, min(n_train, n - 2))
    n_val = max(1, min(n_val, n - n_train - 1))
    return ordered[:n_train], ordered[n_train : n_train + n_val], ordered[n_train + n_val :]


def lambda_for(n_rank: int, epoch: int, epochs: int) -> float:
    """λ 从 0 线性爬到 0.3；rank 样本不足 2000 时恒为 0（详设 §7.4）。"""
    if n_rank < MIN_RANK_SAMPLES or epochs <= 1:
        return 0.0
    return LAMBDA_MAX * min(1.0, epoch / (epochs - 1))


def _tensors(example: Example) -> dict:
    """payload → 张量（复用推理侧的 build_batch，保证训练/推理同一条特征路径）。"""
    if example.tensors is None:
        batch = build_batch(example.payload)
        x = torch.from_numpy(np.ascontiguousarray(batch["x"][0])).float()
        edge_index = torch.from_numpy(np.ascontiguousarray(batch["edge_index"])).long()
        edge_attr = torch.from_numpy(np.ascontiguousarray(batch["edge_attr"][0])).float()
        node_mask = torch.from_numpy(np.ascontiguousarray(batch["mask"][0])).bool()
        edge_mask = torch.from_numpy(np.ascontiguousarray(batch["edge_mask"][0])).bool()
        qv = batch["query_vector"]
        query_vec = None if qv is None else torch.from_numpy(np.ascontiguousarray(qv)).float()
        focus_idx = None
        if example.focus_fact_id is not None:
            ids = [n["fact_id"] for n in example.payload["nodes"]]
            if example.focus_fact_id in ids:
                focus_idx = ids.index(example.focus_fact_id)
        example.tensors = {
            "x": x,
            "edge_index": edge_index,
            "edge_attr": edge_attr,
            "node_mask": node_mask,
            "edge_mask": edge_mask,
            "query_vec": query_vec,
            "focus_idx": focus_idx,
        }
    return example.tensors


def _forward(model: MoshiScorer, t: dict):
    return model(t["x"], t["edge_index"], t["edge_attr"], t["node_mask"], t["edge_mask"], t["query_vec"])


# ---------------------------------------------------------------- 评估


def roc_auc(labels: list[float], scores: list[float]) -> float | None:
    """秩和法 AUC；正负例任一为空时返回 None（样本太少算不出）。"""
    pos = [s for s, y in zip(scores, labels) if y >= 0.5]
    neg = [s for s, y in zip(scores, labels) if y < 0.5]
    if not pos or not neg:
        return None
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    pos_rank_sum = sum(r for r, y in zip(ranks, labels) if y >= 0.5)
    n_pos, n_neg = len(pos), len(neg)
    return (pos_rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def _eval_overturn(model: MoshiScorer, examples: list[Example]) -> tuple[float, float | None]:
    """返回 (平均 BCE, AUC)；只统计有锚点、有标签的 overturn 样本。"""
    model.eval()
    losses: list[float] = []
    labels: list[float] = []
    probs: list[float] = []
    with torch.no_grad():
        for ex in examples:
            if ex.label_kind != "overturn":
                continue
            t = _tensors(ex)
            if t["focus_idx"] is None:
                continue
            _delta, logit = _forward(model, t)
            y = torch.tensor(ex.label, dtype=torch.float32)
            losses.append(float(F.binary_cross_entropy_with_logits(logit[t["focus_idx"]], y)))
            labels.append(ex.label)
            probs.append(float(torch.sigmoid(logit[t["focus_idx"]])))
    if not losses:
        return float("nan"), None
    return sum(losses) / len(losses), roc_auc(labels, probs)


# ---------------------------------------------------------------- 训练


@dataclass
class TrainResult:
    model: MoshiScorer
    history: list[dict]
    val_auc: float | None
    stopped_epoch: int
    n_train: int
    n_val: int
    n_test: int
    n_rank: int


def _pairwise_loss(deltas: list[tuple[str | None, torch.Tensor, float]]) -> torch.Tensor | None:
    """同 query 内 pos/neg 的 margin 损失（详设 §7.4：max(0, m - (δ_pos - δ_neg))）。

    δ 保持张量形态：转成 float 再回来会让这项损失脱离计算图，梯度为零。
    """
    by_query: dict[str, list[tuple[torch.Tensor, float]]] = {}
    for query_id, delta, label in deltas:
        # query_id 为 null 的反馈不知道来自哪次查询：并成一组会把不同查询的
        # adopt/reject 错配成对，产出无意义的排序信号。这类样本不参与 pairwise。
        if query_id is None:
            continue
        by_query.setdefault(query_id, []).append((delta, label))
    terms: list[torch.Tensor] = []
    for pairs in by_query.values():
        for delta_pos, y_pos in pairs:
            if y_pos < 0.5:
                continue
            for delta_neg, y_neg in pairs:
                if y_neg >= 0.5:
                    continue
                terms.append(F.relu(MARGIN - (delta_pos - delta_neg)))
    if not terms:
        return None
    return torch.stack(terms).mean()


def train(
    records: list[Example],
    *,
    epochs: int = DEFAULT_EPOCHS,
    batch_size: int = DEFAULT_BATCH,
    lr: float = 1e-3,
    weight_decay: float = 1e-4,
    seed: int = DEFAULT_SEED,
    patience: int = 5,
    verbose: bool = False,
) -> TrainResult:
    random.seed(seed)
    torch.manual_seed(seed)
    # 不在设置期捕获异常：该开关是 op 执行期才生效，try/except 形同虚设。
    # 若某算子不确定，宁可训练中途明确报错，也不要静默产出不可复现的权重。
    torch.use_deterministic_algorithms(True)

    train_set, val_set, test_set = split_by_time(records)
    n_rank = sum(1 for ex in train_set if ex.label_kind == "rank")

    model = MoshiScorer()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    gen = torch.Generator().manual_seed(seed)

    history: list[dict] = []
    best_auc: float | None = None
    best_metric: float | None = None
    best_state: dict | None = None
    best_epoch = 0
    bad_epochs = 0

    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(train_set), generator=gen).tolist()
        lam = lambda_for(n_rank, epoch, epochs)
        epoch_loss = 0.0
        steps = 0

        for start in range(0, len(order), batch_size):
            chunk = [train_set[i] for i in order[start : start + batch_size]]
            optimizer.zero_grad(set_to_none=True)
            batch_loss = torch.zeros(())
            deltas: list[tuple[str | None, float, float]] = []

            for ex in chunk:
                t = _tensors(ex)
                delta, logit = _forward(model, t)
                if ex.label_kind == "overturn" and t["focus_idx"] is not None:
                    y = torch.tensor(ex.label, dtype=torch.float32)
                    batch_loss = batch_loss + ex.weight * F.binary_cross_entropy_with_logits(
                        logit[t["focus_idx"]], y
                    )
                if ex.label_kind == "rank" and t["focus_idx"] is not None:
                    # λ=0 时也收着 δ（不进损失），日志里能看到排序头是否已经分开
                    deltas.append((ex.query_id, delta[t["focus_idx"]], ex.label))

            if lam > 0.0:
                pair = _pairwise_loss(deltas)
                if pair is not None:
                    batch_loss = batch_loss + lam * pair

            if batch_loss.requires_grad:
                batch_loss.backward()
                optimizer.step()
                epoch_loss += float(batch_loss.detach())
                steps += 1

        val_bce, val_auc = _eval_overturn(model, val_set)
        record = {
            "epoch": epoch,
            "lambda": round(lam, 4),
            "loss": round(epoch_loss / steps, 6) if steps > 0 else None,
            "val_bce": None if val_bce != val_bce else round(val_bce, 6),
            "val_auc": None if val_auc is None else round(val_auc, 6),
        }
        history.append(record)
        if verbose:
            print(json.dumps(record, ensure_ascii=False), file=sys.stderr)

        # val 单类（非空）时 AUC 无定义：退回用 -val_bce 当早停指标，
        # 否则会白跑满 epoch 且永不选中权重。val 完全没有 overturn 样本时
        # 没有任何可评估信号，不回退（`val_bce` 为 NaN）。
        metric: float | None = val_auc
        if metric is None and val_bce == val_bce:
            metric = -val_bce
        if metric is not None:
            if best_metric is None or metric > best_metric + 1e-9:
                best_metric = metric
                if val_auc is not None:
                    best_auc = val_auc
                best_epoch = epoch
                best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
                bad_epochs = 0
            else:
                bad_epochs += 1
                if bad_epochs >= patience:
                    break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return TrainResult(
        model=model,
        history=history,
        val_auc=best_auc,
        stopped_epoch=best_epoch,
        n_train=len(train_set),
        n_val=len(val_set),
        n_test=len(test_set),
        n_rank=n_rank,
    )


# ---------------------------------------------------------------- 导出


def git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            cwd=Path(__file__).resolve().parents[1],
        )
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def save_checkpoint(result: TrainResult, out: str | Path) -> dict:
    sha = git_sha()
    config = {
        "in_dim": 522,
        "q_dim": 512,
        "hidden": 128,
        "heads": 4,
        "edge_dim": 16,
        "delta_cap": 0.15,
    }
    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "samples": result.n_train + result.n_val + result.n_test,
        "train_samples": result.n_train,
        "val_samples": result.n_val,
        "test_samples": result.n_test,
        "rank_samples": result.n_rank,
        "val_auc": result.val_auc,
        "best_epoch": result.stopped_epoch,
        "git_sha": sha,
        "model_version": f"gat-v1@{sha}",
    }
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": result.model.state_dict(), "config": config, "meta": meta}, out_path)
    return meta


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GAT 训练（详设 §7.4）")
    parser.add_argument("--data", required=True, help="moshi samples export 产出的 JSONL")
    parser.add_argument("--out", required=True, help="权重输出路径（如 <data_dir>/models/gat-v1.pt）")
    parser.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--patience", type=int, default=5)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    records = load_records(args.data)
    if not records:
        print("没有样本：先跑 moshi samples build 再 samples export", file=sys.stderr)
        return 1
    overturn = sum(1 for r in records if r.label_kind == "overturn")
    if overturn == 0:
        print("警告：没有 overturn 样本，overturn 头无法训练", file=sys.stderr)

    result = train(
        records,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        seed=args.seed,
        patience=args.patience,
        verbose=args.verbose,
    )
    meta = save_checkpoint(result, args.out)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
