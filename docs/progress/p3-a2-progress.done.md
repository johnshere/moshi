# P3-A2 Python 运行时探测 + 工程内 venv

状态：DONE（2026-11-05 19:35 → 19:50）

## 改动

- 新增 `src/infra/sidecar/python.ts`：`resolvePython`，探测顺序为 配置 → MOSHI_PYTHON → sidecar/.venv → py（默认版本）→ PATH；每个候选真跑并 import 必需模块，返回 `sys.executable`。
- `src/app/config.ts`：`python_path` 默认改为 `''`，空串不做 ~ 展开。
- `src/infra/sidecar/client.ts`：拉起时探测一次并缓存；找不到解释器时按启动失败处理。
- `src/app/cli/commands/doctor.ts`：报告末尾输出 Python 行（只做展示，不影响退出码）。
- `tests/integration/{sidecar,vec-sync}.test.ts`：删掉写死的 `C:\Users\john\...`，改用同一个探测函数。
- `sidecar/requirements.txt`：加入 torch / sentence-transformers / torch_geometric / pytest；onnxruntime 与 tokenizers 标为过渡依赖，P3-A3 删除。
- `config.example.toml`、详设 §3.6 示例同步；台账 D-146。

## 验收输出

- venv：`D:\Caches\Python\pythoncore-3.13-64` → `sidecar\.venv`（3.13.17，1,098 MB，已被 gitignore 覆盖）；清华镜像安装 exit 0，`pip check` 无冲突。
- 自检（`.dsh/temp/p3-a2/p3-a2-selfcheck.txt`）：torch 2.15.0+cpu、PyG 2.8.1 GATConv(edge_dim=16) 前向输出 (3,8)、sentence-transformers 6.2.0。
- 真探测：有 venv 时命中 venv；无 venv 时 `py` → pythoncore-3.13-64（修正前 `py -3` 会选到 3.15）。
- `moshi doctor`：`Python   ...\sidecar\.venv\Scripts\python.exe（来源 venv）`，exit 4。
- 单测 `sidecar-python.test.ts` 7 例；verify 114 files / 1371 passed / 3 skipped；build exit 0。
- 生产接线：`SidecarClient.spawnSidecarProcess`（daemon 与 eval 都经此）和 `moshi doctor`。

## 遗留

- sidecar 集成测试仍然 skip，原因是缺 `sidecar/models` 权重，由 P3-A3 处理。
