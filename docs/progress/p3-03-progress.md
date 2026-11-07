# P3-03 模型定义（进度）

状态：DONE（2026-11-07）
依据：任务详述 P3-03；详设 §7.3；综述 §15.2。
前置：P3-02（`features.py` 常量与形状）、P3-00（16 维边特征）。

## 范围

- 新增 `sidecar/moshi_sidecar/model.py`：`MoshiScorer`
  `GAT → 交叉注意力 → FFN → 双头 Readout`
- 新增 `sidecar/tests/test_model.py`
- 不接 `/score`（P3-04）、不训练（P3-06）

## 关键实现口径

| 项 | 口径 |
| --- | --- |
| 输入形状 | `x (N,522)`、`edge_index (2,E)`、`edge_attr (E,16)`、`node_mask (N)`、`query_vec (512)` 或 None；**无 batch 维** |
| padding 边 | `forward` 内用 `edge_mask` 过滤，不让 padding 自环进入 GAT |
| 输出 | `delta (N,)`（`tanh × delta_cap`）、`overturn_logit (N,)`（未 sigmoid，训练用 BCEWithLogits） |
| 常量 | `NODE_FEAT_DIM` / `EMBED_DIM` / `EDGE_FEAT_DIM` 从 `features.py` 导入，不写死 |
| `self_attn` | 默认 `False`，接口保留（消融用） |
| 可复现 | `eval()` 模式、固定 seed，同一输入两次前向逐位相等 |

## 实测验收点

| 项 | 结果 |
| --- | --- |
| 参数量 | **311,874**（卡面 ~26 万，偏差 +20%；结构按详设 §7.3 未改，原因已记详设 §7.3） |
| 64 节点 CPU 前向 | 中位 **2.30ms**（min 1.84 / p95 3.07，门槛 25ms） |
| `self_attn=False` 可复现 | 两次前向 `torch.equal` 均为 True |
| `self_attn=True` | 可运行，输出形状 `(N,)` 合法 |
| 独立验收 | AC-1..AC-10 PASS |

## 验收命令

- `sidecar/.venv/Scripts/python.exe -m pytest sidecar/tests/ -q` → 45 passed
- `pnpm verify` → 120 files / 1479 tests
- `pnpm build` → exit 0
