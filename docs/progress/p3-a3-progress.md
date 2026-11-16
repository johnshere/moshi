# P3-A3 嵌入改回 torch（sentence-transformers）

状态：WIP（2026-11-05 19:55 开工；21:35 代码提交，收口被 B-7 阻断；23:35 环境供给遗留落盘，23:50 改名 setup-env 并归位本卡；2026-11-07 口径更正：I-55 归 M1 问题，M2 机器维度已达标，m2 收口不依赖 I-55）

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

- 本机库重编码时，sidecar 写 `~/.moshi/sidecar.ready.tmp` 被拒：venv 的 python.exe 带低完整性标签（2026-11-06 更正：继承父目录 `E:\Workspace` 的 `Low (OI)(CI)` 标签，非 DSH 沙箱创建所致），记 B-7。
- 详见 `docs/任务台账.md` B-7。
- vec-sync 真 sidecar 全链路 3/3 通过（临时目录在工程内，同为低完整性，所以不受影响）。

## 环境供给遗留（2026-11-05 并入本卡，B-7 按工程缺陷处理，D-149）

- 已落盘：`scripts/setup-lib.mjs`（纯逻辑）+ `setup-lib.d.mts`、`scripts/setup-env.mjs`（CLI，默认初次判定 / --force / --hook / --check）、`tests/unit/setup-env.test.ts`（13 例）、package.json 的 `setup:env`（--force）与 `postinstall`（--hook）、README 用法。
- 判定 = venv 存在 + 写主目录探测 + import 编码栈 + 模型权重 + 依赖声明 hash（锁文件优先，锁文件工具选型待定）。
- 本机实测 `--check`：写探测通过、缺 torch、缺模型、hash 不一致 → `E_MODULE_MISSING` exit 3；verify 全绿（115 files / 1384 passed / 3 skipped）。
- 待办（**M1 侧 / P3-A7 硬化，不阻塞 M2**）：运行时侧接线（resolvePython 写探测 + 原因码 + server.py --selftest，I-55）；低完整性 fixture 回归（**M1 条件回归**，`icacls /setintegritylevel L` 迷你 venv）；锁文件工具选型。

## I-55 的归属（2026-11-07 用户裁定）

- I-55 是 **M1 问题**：B-7 的低完整性标签继承只发生在 M1 的 `E:\Workspace`（根带可继承 `Low (OI)(CI)`）。
- M2 未复现：`setup-env --check` 写探测通过、重编码 60/60 · 1.09s、sidecar ready 8.47s、`eval --vector` 拒答 10/10 / 单跳 10/10；M2 的 venv 能写 `~/.moshi`。
- 因此低完整性 fixture 是 M1 条件回归，不是 M2 机器证据；I-55 的运行时写探测/原因码/selftest/锁文件硬化转 M1 侧/P3-A7（编号待定），不计 M2 缺项。
- M2 的 P3-A3 机器维度已达标，m2 收口不依赖 I-55；M1 仍待 `fact_vec` 重编码。

## 剩余（依赖装好后）

1. `pnpm setup:env` 装 torch 单栈 → 本机库重编码 `fact_vec`（60 条）；
2. `eval --golden v1 --vector` 四类通过，复核地板 0.6；
3. `sidecar.test.ts`：M2 按 `skipIf(!pythonOk || !modelOk)` 条件应不 skip（venv/模型均齐）；M1 的整组 skip 是 15s 冷 import 超时（I-55），不属 M2；
4. M2：verify + build 后按 `DONE.m2` 收口；M1 待 `fact_vec` 重编码。
