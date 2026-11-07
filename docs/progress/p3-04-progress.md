# P3-04 `/score` 端点与超时（进度）

状态：DONE（2026-11-07，独立验收 AC-1..AC-8 PASS）
依据：任务详述 P3-04；详设 §4.6 / §7.1。
前置：P3-03（`model.py`）、P3-02（`features.py`）。

## 范围

- Python：`sidecar/moshi_sidecar/server.py` 新增 `/score`
  - 接收 `moshi-subgraph/2` payload → `build_batch` → `MoshiScorer`
  - 返回 `{scores:[{fact_id, delta, overturn_prob}], model_version, ms}`
  - 权重懒加载自 `<data_dir>/models/gat-v1.pt`（详设 §7.4）；缺失 → `E_MODEL_NOT_LOADED`
  - 形状错误 → `E_INPUT_SHAPE`（`_error_code` 改 `isinstance` 判定，`FeatureError` 也归对）
- Node：`src/infra/sidecar/client.ts` 新增 `score()` → `ScoreOutcome`
  - `degraded ∈ {no_sidecar, timeout, input_shape, model_not_loaded, error}`
  - 超时用 `score_timeout_ms`（默认 120ms），不计崩溃重启
- `src/infra/sidecar/transport.ts`：新增 `SidecarTimeoutError` 区分超时与连接失败

## 不做

- 不接 `core/read`（P3-07 shadow mode）
- 不训练/不产出权重（P3-06）
- 软 25ms 只作为返回值 `ms` 暴露，监控在 P3-09/P3-10

## 验收读数

| 命令 | 读数 |
| --- | --- |
| `pytest sidecar/tests/ -q` | 52 passed |
| `vitest run tests/unit/sidecarClient.test.ts` | 11 passed |
| `pnpm verify` | 120 files / 1483 tests |
| `pnpm build` | exit 0 |

独立验收补充实测：损坏权重也转 `ModelUnavailable`；eval 模式两次调用模型输出逐位相等（`ms` 为墙钟，不同属预期）。
