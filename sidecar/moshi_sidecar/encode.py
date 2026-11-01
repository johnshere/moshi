"""编码器（详设 §7.2）：bge-small-zh-v1.5，ONNX Runtime 推理。

为什么是 ONNX 而不是 sentence-transformers：本机只装 CPU 版运行时，
torch 轮子约 800MB+ 且与 Python 3.13 的兼容性还在追；ONNX 侧只需
`onnxruntime + tokenizers`（合计约 20MB），模型本体 95MB，懒加载后
单条编码 5~15ms，够 Phase 1 的召回用。

归一化只能在 Python 侧做（§7.2）：Node 侧浮点误差会让 `1 - distance/2`
的相似度漂移。BGE 系列的句向量取 **CLS**（第 0 个 token）而不是 mean pooling，
换模型时这一行要跟着换。
"""
from __future__ import annotations

import os

import numpy as np

# 重依赖 onnxruntime / tokenizers **不在模块顶层 import**：
# server 先把就绪文件写出去再服务，顶层拉 1~2s 会让 Node 侧就绪超时（实测 5s 超限）。
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
        self._session: ort.InferenceSession | None = None
        self._tokenizer: Tokenizer | None = None

    def load(self) -> None:
        """显式加载（server 启动时预热，避免首个查询付 1.5s 冷启）。"""
        self._ensure()

    def loaded(self) -> bool:
        return self._session is not None

    def _ensure(self) -> None:
        """懒加载：首次 encode 时读模型（进程启动不等权重）。"""
        if self._session is not None:
            return
        import onnxruntime as ort
        from tokenizers import Tokenizer

        onnx_path = os.path.join(self.model_dir, "onnx", "model.onnx")
        tok_path = os.path.join(self.model_dir, "tokenizer.json")
        for p in (onnx_path, tok_path):
            if not os.path.exists(p):
                raise ModelUnavailable(f"模型文件缺失：{p}（先跑 sidecar/fetch_model.py）")
        tok = Tokenizer.from_file(tok_path)
        tok.enable_truncation(max_length=MAX_TOKENS)
        tok.enable_padding(pad_id=0, pad_token="[PAD]")
        sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        out_shape = sess.get_outputs()[0].shape
        dim = out_shape[-1]
        if isinstance(dim, int) and dim != self.embed_dim:
            raise ModelUnavailable(f"模型维度 {dim} 与配置 embed_dim={self.embed_dim} 不一致")
        self._tokenizer = tok
        self._session = sess

    def encode(self, texts: list[str]) -> list[list[float]]:
        self._ensure()
        assert self._tokenizer is not None and self._session is not None
        encs = self._tokenizer.encode_batch(texts)
        ids = np.asarray([e.ids for e in encs], dtype=np.int64)
        mask = np.asarray([e.attention_mask for e in encs], dtype=np.int64)
        feeds = {"input_ids": ids, "attention_mask": mask}
        if any(i.name == "token_type_ids" for i in self._session.get_inputs()):
            feeds["token_type_ids"] = np.zeros_like(ids)
        hidden = self._session.run(None, feeds)[0]  # [B, S, D]
        cls = hidden[:, 0, :].astype(np.float32)  # BGE：CLS pooling
        norm = np.linalg.norm(cls, axis=1, keepdims=True)
        norm[norm == 0] = 1.0
        return (cls / norm).tolist()  # §7.2：归一只能在 Python 侧

    def unload(self) -> None:
        """权重卸载（§7.1 空闲 5min）：句柄置 None + 由调用方 gc.collect()。"""
        self._session = None
        self._tokenizer = None
