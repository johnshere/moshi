"""sidecar 服务进程（详设 §4.6 / §7.1）。

传输：Windows 命名管道 / unix 域套接字，HTTP/1.1 + JSON 的简化实现——
每请求一行 JSON `{"path": "...", "body": {...}}`，响应一行 JSON。

端点：
  /health    → {status, loaded, embed_model, model_version, rss_mb, pid, started_at}
  /encode    → {vectors, dim}
  /score     → {scores: [{fact_id, delta, overturn_prob}], model_version, ms}
  /reload    → {ok}
  /unload    → {ok}（权重置 None + gc.collect()，进程保留）
  /shutdown  → {ok}（仅卸载权重，进程保留；兼容旧行为）
  /terminate → {ok}（卸载权重后进程退出；内部关停用）

错误响应：`{"error": {"code": "...", "message": "..."}}`，
code ∈ {E_MODEL_NOT_LOADED, E_INPUT_SHAPE, E_OOM, E_INTERNAL}。
"""
import argparse
import gc
import json
import os
import sys
import threading
import time

from .encode import Encoder
from .features import build_batch

try:
    import pywintypes
    import win32file
    import win32pipe
    import winerror
except ImportError:  # 非 Windows：用 AF_UNIX（unix 平台）
    pywintypes = win32file = win32pipe = winerror = None

PIPE_BUFSIZE = 1 << 20
READ_CHUNK = 1 << 16


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"


def rss_mb() -> int:
    if hasattr(os, "getrusage"):
        import resource

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
    try:
        import psutil  # 可选；没有就返回 0

        return int(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024))
    except Exception:
        return 0


class ModelUnavailable(RuntimeError):
    """打分权重缺失或加载失败；`/score` 返回 `E_MODEL_NOT_LOADED`（`_error_code` 按类名映射）。"""


class State:
    def __init__(self, embed_model: str, embed_dim: int, data_dir: str | None = None) -> None:
        self.embed_model = embed_model
        self.embed_dim = embed_dim
        self.data_dir = data_dir
        # 详设 §7.4：客户机只加载 <data_dir>/models/gat-v1.pt
        self.scorer_path = os.path.join(data_dir, "models", "gat-v1.pt") if data_dir else None
        self.scorer = None
        self.model_version: str | None = None
        self.started_at = now_iso()
        self.encoder = Encoder(embed_model, embed_dim)
        self.unloaded = False
        self.stopping = False
        self.model_error: str | None = None
        self.lock = threading.Lock()

    def warmup(self) -> None:
        """启动时把权重读进来：就绪文件写出去之后，第一个查询不该还在付冷启。

        模型缺失不是致命错——记进 model_error，/encode 会返回 E_MODEL_NOT_LOADED，
        Node 侧按 no_sidecar/no_model 降级（详设 §6.13：查失败绝不报 ok+空）。
        """
        try:
            self.encoder.load()
        except Exception as e:  # noqa: BLE001
            self.model_error = str(e)

    def health(self) -> dict:
        # loaded = 权重真的在内存里（P1-28 起以 Encoder 为准，不再是"进程活着就算就绪"）
        return {
            "status": "ready",
            "loaded": (not self.unloaded) and self.encoder.loaded(),
            "embed_model": self.embed_model,
            "model_version": self.embed_model,
            "rss_mb": rss_mb(),
            "pid": os.getpid(),
            "started_at": self.started_at,
        }

    def unload(self) -> None:
        with self.lock:
            self.encoder.unload()
            self.scorer = None
            self.model_version = None
            self.unloaded = True
            gc.collect()

    def ensure_scorer(self):
        """懒加载 GAT 权重（详设 §7.4）。失败抛 `ModelUnavailable`，不拖垮进程。"""
        if self.scorer is not None:
            return self.scorer
        if self.scorer_path is None or not os.path.isfile(self.scorer_path):
            raise ModelUnavailable(f"未找到打分权重：{self.scorer_path or '<data_dir 未设置>'}")
        try:
            import torch

            from .model import MoshiScorer

            # 权重是 P3-06 本地训练产物（含 config/meta），不是外部输入
            ckpt = torch.load(self.scorer_path, map_location="cpu", weights_only=False)
            scorer = MoshiScorer(**ckpt.get("config", {}))
            scorer.load_state_dict(ckpt["state_dict"])
            scorer.eval()
            meta = ckpt.get("meta") or {}
            self.model_version = str(meta.get("model_version") or meta.get("git_sha") or "gat-v1")
            self.scorer = scorer
            return scorer
        except Exception as e:  # noqa: BLE001 —— 加载失败按降级返回，不拖垮进程
            raise ModelUnavailable(f"打分权重加载失败：{e}") from e

    def reload(self) -> None:
        with self.lock:
            self.encoder.unload()
            gc.collect()
            self.unloaded = False


def dispatch(state: State, path: str, body: dict) -> dict:
    if path == "/health":
        return state.health()
    if path == "/encode":
        texts = body.get("texts")
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            raise ValueError("texts 必须是 string 数组")
        with state.lock:
            if state.unloaded:
                state.unloaded = False  # 懒重载
            vectors = state.encoder.encode(texts)
        return {"vectors": vectors, "dim": state.embed_dim}
    if path == "/score":
        with state.lock:
            if state.unloaded:
                state.unloaded = False  # 懒重载
            scorer = state.ensure_scorer()
            t0 = time.perf_counter()
            batch = build_batch(body)
            import torch

            x = torch.from_numpy(batch["x"][0])
            edge_index = torch.from_numpy(batch["edge_index"])
            edge_attr = torch.from_numpy(batch["edge_attr"][0])
            node_mask = torch.from_numpy(batch["mask"][0])
            edge_mask = torch.from_numpy(batch["edge_mask"][0])
            query_vector = (
                torch.from_numpy(batch["query_vector"])
                if batch["query_vector"] is not None
                else None
            )
            options = body.get("options") or {}
            # 消融（P4-02）：cross_attn=false 时显式丢掉查询向量，模型走无查询条件化的分支
            if options.get("cross_attn", True) is False:
                query_vector = None
            with torch.no_grad():
                delta, logit = scorer(
                    x,
                    edge_index,
                    edge_attr,
                    node_mask,
                    edge_mask,
                    query_vector,
                    self_attn=bool(options.get("self_attn", False)),
                )
            probs = torch.sigmoid(logit)
            scores = [
                {
                    "fact_id": node["fact_id"],
                    "delta": float(delta[i]),
                    "overturn_prob": float(probs[i]),
                }
                for i, node in enumerate(body["nodes"])
            ]
            ms = (time.perf_counter() - t0) * 1000
        return {"scores": scores, "model_version": state.model_version, "ms": round(ms, 3)}
    if path == "/reload":
        state.reload()
        return {"ok": True}
    if path == "/unload":
        state.unload()
        return {"ok": True}
    if path == "/shutdown":
        # 兼容旧行为：只卸载权重，不退出进程。历史调用方按此语义使用。
        state.unload()
        return {"ok": True}
    if path == "/terminate":
        # 内部关停专用：卸载权重并退出；由 serve_pipe/serve_unix 写完响应后收尾。
        state.unload()
        state.stopping = True
        return {"ok": True}
    raise ValueError(f"未知端点: {path}")


def write_ready(ready_path: str, pipe_name: str, embed_model: str = "-", token: str | None = None) -> None:
    payload = {
        "pid": os.getpid(),
        "socket": pipe_name,
        "embed_model": embed_model,
        "model_version": embed_model,
        "started_at": now_iso(),
    }
    if token:
        # Node 侧用随机令牌认领「这次拉起」，不依赖 pid（venv 启动器会换 pid）
        payload["token"] = token
    parent = os.path.dirname(os.path.abspath(ready_path))
    os.makedirs(parent, exist_ok=True)
    tmp = ready_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, ready_path)


def serve_pipe(state: State, pipe_name: str) -> None:
    """Windows 命名管道服务：单连接串行处理（Node 侧单连接，够用）。"""
    while True:
        pipe = win32pipe.CreateNamedPipe(
            pipe_name,
            win32pipe.PIPE_ACCESS_DUPLEX,
            win32pipe.PIPE_TYPE_BYTE | win32pipe.PIPE_READMODE_BYTE | win32pipe.PIPE_WAIT,
            win32pipe.PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFSIZE,
            PIPE_BUFSIZE,
            5000,
            None,
        )
        try:
            win32pipe.ConnectNamedPipe(pipe, None)
        except pywintypes.error as e:
            if e.winerror in (win32pipe.ERROR_PIPE_CONNECTED,):
                pass
            else:
                win32file.CloseHandle(pipe)
                continue
        try:
            _handle_connection(state, pipe)
        finally:
            try:
                win32file.CloseHandle(pipe)
            except Exception:
                pass
        if state.stopping:
            return


def _read_line(pipe) -> bytes | None:
    buf = b""
    while True:
        try:
            _hr, data = win32file.ReadFile(pipe, READ_CHUNK)
        except pywintypes.error as e:
            # win32pipe 里没有 ERROR_* 常量（旧代码因此 AttributeError 把整个管道线程打死），
            # 错误码在 winerror 模块里
            if e.winerror in (winerror.ERROR_BROKEN_PIPE, winerror.ERROR_PIPE_NOT_CONNECTED):
                return None
            raise
        if not data:
            return None
        buf += data
        if b"\n" in buf:
            line, rest = buf.split(b"\n", 1)
            # 简单起见不处理多行残留；Node 侧一行一请求
            return line


def _handle_connection(state: State, pipe) -> None:
    while True:
        line = _read_line(pipe)
        if line is None:
            return
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            path = req.get("path", "")
            body = req.get("body") or {}
            resp = {"ok": True, **dispatch(state, path, body)}
        except Exception as e:  # noqa: BLE001 —— 端点错误按协议返回，不拖垮进程
            resp = {
                "error": {"code": _error_code(e), "message": str(e)},
            }
        try:
            win32file.WriteFile(pipe, (json.dumps(resp) + "\n").encode("utf-8"))
        except pywintypes.error:
            return
        if state.stopping:
            return


def _error_code(e: Exception) -> str:
    # 用 isinstance 而非类名：FeatureError(ValueError) 等子类必须归到 E_INPUT_SHAPE
    if isinstance(e, ModelUnavailable):
        return "E_MODEL_NOT_LOADED"
    if isinstance(e, ValueError):
        return "E_INPUT_SHAPE"
    return "E_INTERNAL"


def serve_unix(state: State, socket_path: str) -> None:
    """unix 域套接字服务（非 Windows）。"""
    import socket

    if os.path.exists(socket_path):
        os.unlink(socket_path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(socket_path)
    srv.listen(1)
    while True:
        conn, _ = srv.accept()
        with conn:
            buf = b""
            while True:
                chunk = conn.recv(READ_CHUNK)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        req = json.loads(line)
                        path = req.get("path", "")
                        body = req.get("body") or {}
                        resp = {"ok": True, **dispatch(state, path, body)}
                    except Exception as e:  # noqa: BLE001
                        resp = {"error": {"code": _error_code(e), "message": str(e)}}
                    conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
                    if state.stopping:
                        return


def main() -> int:
    ap = argparse.ArgumentParser(description="moshi sidecar")
    ap.add_argument("--pipe", required=True, help="Windows 命名管道名（\\\\.\\pipe\\...）")
    ap.add_argument("--socket", help="unix 域套接字路径（非 Windows）")
    ap.add_argument("--ready", required=True, help="就绪文件路径")
    ap.add_argument("--model", default="bge-small-zh-v1.5", help="embedding 模型名")
    ap.add_argument("--dim", type=int, default=512)
    ap.add_argument("--token", default=None, help="启动令牌（写进就绪文件，供 Node 认领）")
    args = ap.parse_args()

    state = State(args.model, args.dim, os.path.dirname(os.path.abspath(args.ready)))
    # 先把权重读进来再宣布就绪：否则首个查询要付 1~2s 冷启，P95 直接失控
    state.warmup()
    write_ready(args.ready, args.pipe, args.model, args.token)

    if win32pipe is not None and sys.platform == "win32":
        serve_pipe(state, args.pipe)
    else:
        if not args.socket:
            print("非 Windows 需要 --socket", file=sys.stderr)
            return 2
        serve_unix(state, args.socket)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
