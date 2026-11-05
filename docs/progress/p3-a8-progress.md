# P3-A8 · sidecar 环境供给与自检（progress，WIP）

> 任务卡见 `docs/任务台账.md` §3 P3-A8。随改动实时更新；验收完成改状态并改名 `p3-a8-progress.done.md`。

## 目标

按用户裁定（2026-11-05）：工程运行不依赖本机环境。B-7（venv 低完整性标签）按**工程缺陷**处理，不做「那台机器手动重建」式绕过：
- 判据：解释器必须能写用户主目录 + 能 import 编码栈 + 模型权重在（与 `src/infra/sidecar/python.ts` 同一口径）；
- 供给：`pnpm setup:sidecar`（强制重建）+ `pnpm install` postinstall 钩子（初次判定，失败不红）；
- 场景语义：开发环境初始化 = 构建；打包后初始化（`moshi init`）= 只装配不构建（v1.1 随包 wheel，概设 §11.6）。

## 决策（用户拍板）

| # | 决策 |
| --- | --- |
| 1 | 脚本默认=初次判定（合格跳过，不合格重建）；`--force`=强制重建；`--hook`=postinstall 非致命；`--check`=只判定 |
| 2 | `pnpm setup:sidecar` → `--force`；postinstall → `--hook`；同一份实现，差一个参数 |
| 3 | 合格判定 = 写主目录探测 + import + 模型存在 + 依赖声明 hash 双条件（锁文件优先，锁文件生成工具选型待定） |
| 4 | 低完整性进程无法自愈（SeRelabelPrivilege）→ 修复动作必须由 Medium 进程（Node）执行；坏 venv 由脚本删掉重建 |

## 已完成（2026-11-05）

- `scripts/setup-lib.mjs`（纯逻辑）+ `scripts/setup-lib.d.mts`（类型声明）：parseArgs / venvPythonPath / sysPythonCommand / WRITE_PROBE / depsHash / readRecordedHash / classify
- `scripts/setup-sidecar.mjs`（CLI，纯 node ESM，不依赖 tsx/node_modules）：判定 → 重建（rm venv → py -m venv → pip install -i 清华 → fetch_model.py → 写 hash）→ 最终验收
- `package.json`：`setup:sidecar`（--force）、`postinstall`（--hook）
- `tests/unit/setup-sidecar.test.ts`：13 例（参数解析 / classify 六分支 / hash 确定性 / venv 路径）
- 实测 `--check`：本机 venv 写主目录**通过**（无低完整性）、缺 torch、缺模型、hash 不一致 → `E_MODULE_MISSING` exit 3 ✓

## 待办

- [ ] `pnpm verify` 全绿确认
- [ ] 台账 §1/§3/§6 更新、§5.2 D-149、B-7 状态
- [ ] commit
- [ ] （后续）锁文件生成工具选型（uv.lock vs pip-tools，D 编号待定）
- [ ] （后续）运行时侧接线：resolvePython 写探测 + 原因码 + server.py --selftest（I-55 并入本卡）
- [ ] （后续）低完整性 fixture 回归测试（`icacls /setintegritylevel L` 迷你 venv）

## 验收

- [ ] `pnpm setup:sidecar --check` 本机输出合格（装完依赖后）
- [ ] `pnpm verify` 全绿
- [ ] 坏 venv 机器：doctor/脚本报 `E_NO_WRITE`，`pnpm setup:sidecar` 一条命令修复
