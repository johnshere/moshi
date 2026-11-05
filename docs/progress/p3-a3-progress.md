# P3-A3 嵌入改回 torch（sentence-transformers）

状态：WIP（2026-11-05 19:55 开工；21:35 代码提交，收口被 B-7 阻断）

## 已落盘

- `sidecar/fetch_model.py`：改拉 BAAI 原版（safetensors + tokenizer + 1_Pooling），不再拉 Xenova 的 ONNX 导出。
- `sidecar/moshi_sidecar/encode.py`：改用 sentence-transformers 加载本地权重目录；`torch.set_num_threads(1)`、`set_grad_enabled(False)`、`eval()`；归一仍在 Python 侧；重依赖仍只在 `_ensure()` 里 import。
- `sidecar/requirements.txt`：删掉 onnxruntime / tokenizers。
- `src/infra/sidecar/python.ts`：`SIDECAR_ENCODE_MODULES` 改为 `torch` + `sentence_transformers`。
- 两个集成测试的 `modelOk` 判据由 `onnx/model.onnx` 改为 `model.safetensors`。

## 实测（详见 `.dsh/temp/p3-a3/p3-a3-measure.txt`）

- 编码质量合格：正例 24 对最低 0.692（要求 ≥0.6），dim 512，归一后范数 1.0。
- **三项破预算**：推理就绪 494MB（限 400）、推理空闲 400MB（限 220）、sidecar 就绪 11.3s（限 5s）。
- 集成测试因此失败：`startup_timeout_ms` 默认 5000，真进程 11.3s 才写就绪文件 → 状态停在 `starting`。
- **地板需重标**：拒答负例最高 cos 0.520 > 现行 `vector_min_sim=0.5`；正负区间 [0.520, 0.692]。

## 停在这里的原因

超预算属概设 §11.5 / §1.7 的方向性指标，不能自行放宽；地板重标会影响 P1-29 的既有验收口径。两项都要用户拍板。

## 用户裁定（2026-11-05 21:10）

- 内存两项超出可接受 → 概设 v0.6.3 三档重标为 420 / 520MB（D-147）。
- 就绪耗时 11.3s 是启动成本 → 不改预算，留作待办 I-54（服务状态管理）。
- `startup_timeout_ms` 5000 → 20000；`vector_min_sim` 0.5 → 0.6（D-148）；P1-28 的 ONNX cos 参考值标为失效。

## 阻断（21:20）

- 本机库重编码时，sidecar 写 `~/.moshi/sidecar.ready.tmp` 被拒：venv 的 python.exe 带低完整性标签（在 DSH 沙箱里创建所致），记 B-7。
- 详见 `docs/待处理-sidecar-venv低完整性标签.md`。
- vec-sync 真 sidecar 全链路 3/3 通过（临时目录在工程内，同为低完整性，所以不受影响）。

## 剩余（B-7 解决后）

1. 本机库重编码 `fact_vec`（期望 478/478）；
2. `eval --golden v1 --vector` 四类通过，复核地板 0.6；
3. `sidecar.test.ts` 不再 skip（探测超时问题见 I-55）；
4. verify + build；台账收口，改名 `.done.md`。
