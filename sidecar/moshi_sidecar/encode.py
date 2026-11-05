"""编码器（详设 §7.2）：bge-small-zh-v1.5，sentence-transformers / torch 推理。

为什么是 torch 而不是 ONNX Runtime（D-143，撤回 D-61）：GAT 支路（§7.3–§7.4）
必须用 torch——ONNX Runtime 自 1.20 起停发训练包、不能加载 `.pt`、消融要逐个变体
导出。既然启用模型挡位时 torch 必装，嵌入再用 ONNX 就是概设 §11.2 已否决的
"第二套推理栈"。ONNX 是 v2 收敛目标（概设 §11.4），不是 v1 的手段。

归一化只能在 Python 侧做（§7.2）：Node 侧浮点误差会让 `1 - distance/2`
的相似度漂移。BGE 系列取 **CLS**（第 0 个 token）而不是 mean pooling——
权重目录里 `1_Pooling/config.json` 已经写明，由 SentenceTransformer 读取。
"""
from __future__ import annotations

import os

import numpy as np

# 重依赖 torch / sentence_transformers **不在模块顶层 import**：
# server 先把就绪文件写出去再服务，顶层拉 torch 要若干秒会让 Node 侧就绪超时。
# 它们只在 _ensure() 里加载；numpy 轻（~100ms）且 encode() 里处处要用，放顶层。

# bge-small-zh-v1.5 的隐藏维；改模型/改维度必须同步
# src/domain/embedding.ts 的 EMBED_DIM（库表 fact_vec 的 vec0 维度写死在那里）
DEFAULT_DIM = 512
DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
MAX_TOKENS = 512

# 模型文件相对本包的默认位置：sidecar/models/<model-dir>/
_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_DIR = os.path.join(os.path.dirname(_HERE), "models", "bge-small-zh-v1.5")


class ModelUnavailable(RuntimeError):
    """模型文件缺失或加载失败。server 侧映射为 E_MODEL_NOT_LOADED，调用方据此降级。"""


class Encoder:
    def __init__(self, embed_model: str = DEFAULT_MODEL, embed_dim: int = DEFAULT_DIM, model_dir: str | None = None) -> None:
        self.embed_model = embed_model
        self.embed_dim = embed_dim
        self.model_dir = model_dir or DEFAULT_MODEL_DIR
        self._model = None

    def load(self) -> None:
        """显式加载（server 启动时预热，避免首个查询付冷启动）。"""
        self._ensure()

    def loaded(self) -> bool:
        return self._model is not None

    def _ensure(self) -> None:
        """懒加载：首次 encode 时读模型（进程启动不等权重）。"""
        if self._model is not None:
            return
        weights = os.path.join(self.model_dir, "model.safetensors")
        if not os.path.exists(weights):
            raise ModelUnavailable(f"模型文件缺失：{weights}（先跑 sidecar/fetch_model.py）")
        try:
            import torch
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:  # 装了 Python 但没装推理栈
            raise ModelUnavailable(f"推理栈不可用：{exc}") from exc
        # 客户机只做推理：单线程省内存，且避免与 daemon 抢核
        torch.set_num_threads(1)
        torch.set_grad_enabled(False)
        model = SentenceTransformer(self.model_dir, device="cpu")
        model.eval()
        model.max_seq_length = MAX_TOKENS
        dim = model.get_sentence_embedding_dimension()
        if isinstance(dim, int) and dim != self.embed_dim:
            raise ModelUnavailable(f"模型维度 {dim} 与配置 embed_dim={self.embed_dim} 不一致")
        self._model = model

    def encode(self, texts: list[str]) -> list[list[float]]:
        self._ensure()
        assert self._model is not None
        # normalize_embeddings：§7.2 归一只能在 Python 侧
        vecs = self._model.encode(texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        return np.asarray(vecs, dtype=np.float32).tolist()

    def unload(self) -> None:
        """权重卸载（§7.1 空闲 5min）：句柄置 None + 由调用方 gc.collect()。"""
        self._model = None
