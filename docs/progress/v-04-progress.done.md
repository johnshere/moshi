# V-04 Python 组件可选安装 · 进度

- 状态：DONE.m2（2026-11-08）
- 决策：D-171（安装口径）
- 机器：m2（Windows 11 26200；平台绑定 + 本机解释器）

## 执行与产出

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 安装脚本 | `packaging/windows/install-python.ps1`：找本机 64 位 Python ≥3.11（`python`/`python3`/`py`/上次安装的 `%LOCALAPPDATA%\moshi\python`）→ 没有则下载 python.org 官方安装包（Authenticode 校验）以 per-user、不写 PATH 装到 `%LOCALAPPDATA%\moshi\python` |
| 2 | venv 与依赖 | `python -m venv $INSTDIR\sidecar\.venv` → `pip install -r sidecar/requirements.txt`（清华镜像、`--progress-bar off`）→ `fetch_model.py`（hf-mirror）→ 自检 import + `model.safetensors` 存在 → 写 `sidecar/component.json` |
| 3 | 安装向导 | 依赖页新增「安装 Python 组件（约 500MB，需联网）」勾选，默认不勾；静默安装用 `/PYTHON=1`；覆盖安装前先 `stop-moshi.ps1` 释放 .node/数据库；组件失败只告警、不阻断主程序 |
| 4 | 首开提示 | `sidecar_off` 文案改为「重新运行默识安装包，勾选『Python 组件』」，不再暗示应用内下载 |
| 5 | 文档 | 概设 §11.6、D-171、台账 §1/§3/§9.2/§9.3 |

## 验收读数

- `pnpm verify`：135 files / 1602 tests 全绿；`pnpm build` exit 0
- 安装包：`moshi-setup-0.1.0.exe` 5.8MB（组件不进包）
- 静默安装 `/S /PYTHON=1 /D=temp\v04-install`：
  - `sidecar/.venv` 1.2GB、`sidecar/models` 92MB、`sidecar/component.json` 记录 python=`J:\Software\miniconda\python.exe`、venv 路径、安装时间
  - venv 内 `import torch,sentence_transformers,torch_geometric` → `torch 2.15.0+cpu`
- 安装实例（9843，临时库）：`sidecar.python` 来源 `venv`、路径 `$INSTDIR\sidecar\.venv\Scripts\python.exe`；`sidecar.ready` 用时 ~6.7s；`/api/status` `sidecar.state=ready`、`mode=on`、`vector.dim=512`
- 卸载 `/S`：程序目录（含 venv/模型）删除；临时数据目录的 `moshi.db` 保留
- 生产 daemon：测试卸载器会按 `~/.moshi/daemon.lock` 停掉默认 daemon；验收后已重启（9836，sidecar ready）

## DoD

1. 代码落盘 ✅
2. build 过 ✅（安装包重建）
3. 验收输出已抄进度日志 ✅
4. 关键分支：解释器探测、venv 创建、pip 安装、模型下载、自检、失败降级均有脚本分支；端到端实测 ✅
5. 无未记录 TODO/FIXME ✅
6. §1/§3/§6 已更新 ✅
7. 生产接线点 ✅（安装向导 → `install-python.ps1` → `sidecar/.venv`；运行时探测第 3 顺位自动命中）
8. 机器相关证据 ✅（§9.3/m2#V-04）

## 遗留

- Python 下载分支（本机无 Python）只做了语法与参数核对，未在本机实测下载安装；验收走的是本机 Python 分支。
- 依赖源固定清华 PyPI 镜像与 hf-mirror；镜像不可用时的回退/自定义未做（可后续做成安装器参数）。
- 组件安装没有断点续传，失败重跑会重建 venv（幂等但耗时）。
- 应用内没有"安装/修复组件"按钮；安装路径统一归安装包（符合"无运行时下载"口径）。
