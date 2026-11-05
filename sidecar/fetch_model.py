"""下载编码模型权重（P1-28 / P3-A3）。

权重不进 git：`sidecar/models/` 被 .gitignore 排除，新环境先跑本脚本。

    py -m venv sidecar/.venv
    sidecar/.venv/Scripts/python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r sidecar/requirements.txt
    sidecar/.venv/Scripts/python.exe sidecar/fetch_model.py

走 hf-mirror（`HF_ENDPOINT` 可覆盖），拉 BAAI 原版的 sentence-transformers 目录
（safetensors + tokenizer + pooling 配置）；不拉 pytorch_model.bin（与 safetensors 重复）。
"""
from __future__ import annotations

import os
import sys

REPO = "BAAI/bge-small-zh-v1.5"
LOCAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "bge-small-zh-v1.5")
ALLOW = [
    "model.safetensors",
    "config.json",
    "config_sentence_transformers.json",
    "modules.json",
    "sentence_bert_config.json",
    "1_Pooling/config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
]


def main() -> int:
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("缺 huggingface_hub：先按 sidecar/requirements.txt 装依赖", file=sys.stderr)
        return 2
    path = snapshot_download(REPO, local_dir=LOCAL_DIR, allow_patterns=ALLOW)
    print(f"模型已就绪：{path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
