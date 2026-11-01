"""下载编码模型权重（P1-28）。

权重不进 git：`sidecar/models/` 被 .gitignore 排除，新环境先跑本脚本。

    py -3 -m venv sidecar/.venv
    sidecar/.venv/Scripts/python.exe -m pip install -r sidecar/requirements.txt
    sidecar/.venv/Scripts/python.exe sidecar/fetch_model.py

走 hf-mirror（`HF_ENDPOINT` 可覆盖），只拉 ONNX + tokenizer，不拉 torch 权重。
"""
from __future__ import annotations

import os
import sys

REPO = "Xenova/bge-small-zh-v1.5"  # transformers.js 的 ONNX 导出，与 BAAI 原版权重等价
LOCAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "bge-small-zh-v1.5")
ALLOW = ["onnx/model.onnx", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "config.json"]


def main() -> int:
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("缺 huggingface_hub：pip install huggingface_hub", file=sys.stderr)
        return 2
    path = snapshot_download(REPO, local_dir=LOCAL_DIR, allow_patterns=ALLOW)
    print(f"模型已就绪：{path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
