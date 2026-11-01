"""编码器（详设 §7.2）。

P1-01 只搭骨架：无外部模型依赖，`encode` 返回**确定性伪向量**（文本 hash 派生，
L2 归一化在 Python 侧重做——§7.2 明确 Node 侧可能有浮点误差，归一只能在这边）。
P1-02 换 bge-small（sentence-transformers），`encode` 的签名与返回形状不变。
"""
import hashlib
import math


def _pseudo_vector(seed: int, dim: int) -> list[float]:
    """确定性伪向量：用 splitmix64 从 seed 派生 dim 个值，[-1,1]，可复现。"""
    vec: list[float] = []
    x = seed & ((1 << 64) - 1)
    for _ in range(dim):
        x = (x + 0x9E3779B97F4A7C15) & ((1 << 64) - 1)
        z = x
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & ((1 << 64) - 1)
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & ((1 << 64) - 1)
        z = z ^ (z >> 31)
        vec.append((z / (1 << 63)) - 1.0)
    return vec


class Encoder:
    def __init__(self, embed_model: str, embed_dim: int = 384) -> None:
        self.embed_model = embed_model
        self.embed_dim = embed_dim
        self._model = None  # P1-02 放 sentence-transformers 模型句柄

    def loaded(self) -> bool:
        return self._model is not None

    def _ensure(self) -> None:
        """懒加载。P1-01 无真模型，仅标记占位句柄；P1-02 在此换真模型。"""
        if self._model is None:
            # 伪向量模式不需要真实模型；占位句柄只为 loaded() 语义正确
            self._model = "pseudo-v1"

    def encode(self, texts: list[str]) -> list[list[float]]:
        self._ensure()
        out: list[list[float]] = []
        for t in texts:
            h = hashlib.blake2b(t.encode("utf-8"), digest_size=8).digest()
            seed = int.from_bytes(h, "big")
            vec = _pseudo_vector(seed, self.embed_dim)
            norm = math.sqrt(sum(x * x for x in vec)) or 1.0
            out.append([x / norm for x in vec])  # §7.2：归一只能在 Python 侧
        return out

    def unload(self) -> None:
        """权重卸载（§7.1 空闲 5min）：句柄置 None + 由调用方 gc.collect()。"""
        self._model = None
