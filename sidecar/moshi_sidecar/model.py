"""P3-03：GAT 图打分模型（详设 §7.3，综述 §15.2）。

结构：`GAT → 交叉注意力 → FFN → 双头 Readout`。

- 两个输出头：`delta`（置信修正，`tanh × delta_cap`）与 `overturn_logit`
  （符号裁决被推翻的 logit，训练用 `BCEWithLogits`，推理侧再 sigmoid）。
- `self_attn` 默认关，接口保留——消融（P4-02）要切。
- 输入**不带 batch 维**：`x (N, NODE_FEAT_DIM)`、`edge_index (2, E)`、
  `edge_attr (E, EDGE_FEAT_DIM)`、`node_mask (N,)`、`edge_mask (E,)`、
  `query_vec (EMBED_DIM,)` 或 None。`features.build_batch` 产出的 `(1, …)`
  形状由调用方 squeeze（P3-04）。
- padding 边必须在进入 GAT 前用 `edge_mask` 过滤，否则 padding 的 `0→0`
  自环会污染节点 0。

维度常量从 `features.py` 导入，不在本模块写死（D-142）。
"""

from __future__ import annotations

import torch
import torch.nn as nn
from torch_geometric.nn import GATConv

from .features import EDGE_FEAT_DIM, EMBED_DIM, NODE_FEAT_DIM


class MoshiScorer(nn.Module):
    """`GAT → 交叉注意力 → FFN → 双头 Readout`（详设 §7.3）。"""

    def __init__(
        self,
        in_dim: int = NODE_FEAT_DIM,
        q_dim: int = EMBED_DIM,
        hidden: int = 128,
        heads: int = 4,
        edge_dim: int = EDGE_FEAT_DIM,
        delta_cap: float = 0.15,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        if hidden % heads != 0:
            raise ValueError(f"hidden({hidden}) 必须能被 heads({heads}) 整除")

        self.in_dim = in_dim
        self.q_dim = q_dim
        self.hidden = hidden
        self.heads = heads
        self.edge_dim = edge_dim
        self.delta_cap = delta_cap

        self.inp = nn.Linear(in_dim, hidden)
        self.gat1 = GATConv(hidden, hidden // heads, heads=heads, edge_dim=edge_dim, concat=True)
        self.gat2 = GATConv(hidden, hidden, heads=1, edge_dim=edge_dim, concat=False)
        self.ln1 = nn.LayerNorm(hidden)
        self.ln2 = nn.LayerNorm(hidden)

        self.q_proj = nn.Linear(q_dim, hidden)
        self.xattn = nn.MultiheadAttention(hidden, num_heads=4, batch_first=True)
        self.ln3 = nn.LayerNorm(hidden)

        self.ffn = nn.Sequential(
            nn.Linear(hidden, hidden * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden * 2, hidden),
        )
        self.ln4 = nn.LayerNorm(hidden)
        self.head = nn.Sequential(nn.Linear(hidden, 64), nn.GELU(), nn.Linear(64, 2))

    def encode(
        self,
        x: torch.Tensor,
        edge_index: torch.Tensor,
        edge_attr: torch.Tensor,
        node_mask: torch.Tensor | None = None,
        edge_mask: torch.Tensor | None = None,
        query_vec: torch.Tensor | None = None,
        self_attn: bool = False,
    ) -> torch.Tensor:
        """图编码 + 交叉注意力 + FFN，返回节点表示 `(N, hidden)`。"""
        if x.dim() != 2 or x.size(1) != self.in_dim:
            raise ValueError(f"x 形状应为 (N, {self.in_dim})，实际 {tuple(x.shape)}")
        if edge_index.dim() != 2 or edge_index.size(0) != 2:
            raise ValueError(f"edge_index 形状应为 (2, E)，实际 {tuple(edge_index.shape)}")
        if edge_attr.dim() != 2 or edge_attr.size(1) != self.edge_dim:
            raise ValueError(f"edge_attr 形状应为 (E, {self.edge_dim})，实际 {tuple(edge_attr.shape)}")
        if edge_index.size(1) != edge_attr.size(0):
            raise ValueError("edge_index 与 edge_attr 的边数不一致")

        if edge_mask is not None:
            keep = edge_mask.to(torch.bool)
            edge_index = edge_index[:, keep]
            edge_attr = edge_attr[keep]

        h = self.inp(x)
        h = self.ln1(h + self.gat1(h, edge_index, edge_attr))
        h = self.ln2(h + self.gat2(h, edge_index, edge_attr))

        key_padding_mask = None
        if node_mask is not None:
            if node_mask.dim() != 1 or node_mask.size(0) != h.size(0):
                raise ValueError("node_mask 形状应为 (N,) 且与 x 节点数一致")
            key_padding_mask = ~node_mask.to(torch.bool).unsqueeze(0)

        if self_attn:
            h = self.ln3(h + self.xattn(h.unsqueeze(0), h.unsqueeze(0), h.unsqueeze(0), key_padding_mask=key_padding_mask)[0].squeeze(0))

        if query_vec is not None:
            if query_vec.dim() != 1 or query_vec.size(0) != self.q_dim:
                raise ValueError(f"query_vec 形状应为 ({self.q_dim},)，实际 {tuple(query_vec.shape)}")
            q = self.q_proj(query_vec).unsqueeze(0).unsqueeze(0)  # (1, 1, hidden)
            attn, _ = self.xattn(q, h.unsqueeze(0), h.unsqueeze(0), key_padding_mask=key_padding_mask)
            h = self.ln3(h + attn.squeeze(0))

        return self.ln4(h + self.ffn(h))

    def forward(
        self,
        x: torch.Tensor,
        edge_index: torch.Tensor,
        edge_attr: torch.Tensor,
        node_mask: torch.Tensor | None = None,
        edge_mask: torch.Tensor | None = None,
        query_vec: torch.Tensor | None = None,
        self_attn: bool = False,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """返回 `(delta (N,), overturn_logit (N,))`。"""
        h = self.encode(x, edge_index, edge_attr, node_mask, edge_mask, query_vec, self_attn)
        out = self.head(h)  # (N, 2)
        delta = torch.tanh(out[:, 0]) * self.delta_cap
        return delta, out[:, 1]


def count_parameters(model: nn.Module) -> int:
    """可训练参数总数（验收用）。"""
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
