"""P3-03 模型定义单测（详设 §7.3，综述 §15.2）。

覆盖：参数量、前向形状、delta 值域、`self_attn=False` 可复现、
`self_attn=True` 接口可用、边/节点 mask 行为、非法输入、64 节点 CPU 时延。
"""

import statistics
import time

import pytest
import torch

from moshi_sidecar import features as F
from moshi_sidecar.model import MoshiScorer, count_parameters

N_NODES = 16
N_EDGES = 24


def make_inputs(seed: int = 42, n_nodes: int = N_NODES, n_edges: int = N_EDGES):
    g = torch.Generator().manual_seed(seed)
    x = torch.randn(n_nodes, F.NODE_FEAT_DIM, generator=g)
    edge_index = torch.randint(0, n_nodes, (2, n_edges), generator=g)
    edge_attr = torch.zeros(n_edges, F.EDGE_FEAT_DIM)
    edge_attr[:, 0] = 1.0
    edge_attr[:, 6] = 0.5
    node_mask = torch.ones(n_nodes)
    edge_mask = torch.ones(n_edges)
    q = torch.randn(F.EMBED_DIM, generator=g)
    q = q / q.norm()
    return x, edge_index, edge_attr, node_mask, edge_mask, q


def new_model() -> MoshiScorer:
    torch.manual_seed(42)
    return MoshiScorer().eval()


# ── 常量与参数量 ────────────────────────────────────────────────────────────


def test_dims_come_from_features_constants():
    m = MoshiScorer()
    assert m.in_dim == F.NODE_FEAT_DIM == 522
    assert m.q_dim == F.EMBED_DIM == 512
    assert m.edge_dim == F.EDGE_FEAT_DIM == 16


def test_parameter_count():
    # 实测 311,874：按详设 §7.3 结构如实统计；卡面「~26 万」为数量级估算
    # （inp/q_proj/xattn/FFN 的完整投影未被计入估算）。守住量级与概设 1–6M 上限。
    n = count_parameters(new_model())
    assert 260_000 <= n <= 360_000, f"参数量 {n} 超出预期量级"
    assert n < 1_000_000


# ── 前向形状与值域 ──────────────────────────────────────────────────────────


def test_forward_shapes():
    m = new_model()
    x, ei, ea, nm, em, q = make_inputs()
    with torch.no_grad():
        delta, logit = m(x, ei, ea, nm, em, q)
    assert delta.shape == (N_NODES,)
    assert logit.shape == (N_NODES,)
    assert torch.isfinite(delta).all()
    assert torch.isfinite(logit).all()


def test_delta_within_cap():
    m = new_model()
    x, ei, ea, nm, em, q = make_inputs()
    with torch.no_grad():
        delta, _ = m(x, ei, ea, nm, em, q)
    assert float(delta.abs().max()) <= m.delta_cap + 1e-6


def test_forward_without_query_vector():
    m = new_model()
    x, ei, ea, nm, em, _ = make_inputs()
    with torch.no_grad():
        delta, logit = m(x, ei, ea, nm, em, None)
    assert delta.shape == (N_NODES,)
    assert logit.shape == (N_NODES,)


def test_forward_without_masks():
    m = new_model()
    x, ei, ea, _, _, q = make_inputs()
    with torch.no_grad():
        delta, logit = m(x, ei, ea, None, None, q)
    assert delta.shape == (N_NODES,)


# ── 可复现与消融接口 ────────────────────────────────────────────────────────


def test_self_attn_false_is_deterministic():
    m = new_model()
    x, ei, ea, nm, em, q = make_inputs()
    with torch.no_grad():
        d1, l1 = m(x, ei, ea, nm, em, q, self_attn=False)
        d2, l2 = m(x, ei, ea, nm, em, q, self_attn=False)
    assert torch.equal(d1, d2)
    assert torch.equal(l1, l2)


def test_self_attn_true_runs_and_has_same_shape():
    m = new_model()
    x, ei, ea, nm, em, q = make_inputs()
    with torch.no_grad():
        delta, logit = m(x, ei, ea, nm, em, q, self_attn=True)
    assert delta.shape == (N_NODES,)
    assert logit.shape == (N_NODES,)
    assert torch.isfinite(delta).all()


# ── mask 行为 ───────────────────────────────────────────────────────────────


def test_edge_mask_filters_padding_edges():
    """被 edge_mask 屏蔽的边不参与计算：结果与只传真实边一致。"""
    m = new_model()
    x, ei, ea, nm, _, q = make_inputs()
    keep = torch.zeros(N_EDGES)
    keep[: N_EDGES // 2] = 1.0
    em = keep

    real_ei = ei[:, : N_EDGES // 2]
    real_ea = ea[: N_EDGES // 2]
    with torch.no_grad():
        masked = m(x, ei, ea, nm, em, q)
        sliced = m(x, real_ei, real_ea, nm, None, q)
    assert torch.equal(masked[0], sliced[0])
    assert torch.equal(masked[1], sliced[1])


def test_node_mask_affects_cross_attention_only_by_padding():
    """node_mask 全 1 与不传 mask 等价（没有 padding 节点时）。"""
    m = new_model()
    x, ei, ea, nm, em, q = make_inputs()
    with torch.no_grad():
        with_mask = m(x, ei, ea, nm, em, q)
        without = m(x, ei, ea, None, None, q)
    assert torch.equal(with_mask[0], without[0])
    assert torch.equal(with_mask[1], without[1])


# ── 性能 ────────────────────────────────────────────────────────────────────


def test_64_node_forward_under_25ms():
    m = new_model()
    x, ei, ea, nm, em, q = make_inputs(n_nodes=64, n_edges=192)
    with torch.no_grad():
        for _ in range(10):  # warmup
            m(x, ei, ea, nm, em, q)
        ts = []
        for _ in range(20):
            t0 = time.perf_counter()
            m(x, ei, ea, nm, em, q)
            ts.append((time.perf_counter() - t0) * 1000)
    assert statistics.median(ts) < 25.0, f"64 节点前向中位数 {statistics.median(ts):.2f}ms ≥ 25ms"


# ── 非法输入 ────────────────────────────────────────────────────────────────


def test_rejects_bad_shapes():
    m = new_model()
    x, ei, ea, nm, em, q = make_inputs()
    with pytest.raises(ValueError, match="x 形状"):
        m(x.unsqueeze(0), ei, ea, nm, em, q)
    with pytest.raises(ValueError, match="edge_index"):
        m(x, ei.T, ea, nm, em, q)
    with pytest.raises(ValueError, match="edge_attr"):
        m(x, ei, ea[:, :15], nm, em, q)
    with pytest.raises(ValueError, match="边数不一致"):
        m(x, ei, ea[:-1], nm, em, q)
    with pytest.raises(ValueError, match="query_vec"):
        m(x, ei, ea, nm, em, torch.randn(511))
    with pytest.raises(ValueError, match="node_mask"):
        m(x, ei, ea, torch.ones(N_NODES + 1), em, q)


def test_hidden_must_divide_heads():
    with pytest.raises(ValueError, match="整除"):
        MoshiScorer(hidden=130, heads=4)
