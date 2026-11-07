# P3-09 双门槛 gate 命令 · 进度

状态：DONE（2026-11-07，独立验收 AC-1..AC-6 + 修复复验 PASS）

## 范围

详设 §7.6 / 台账 P3-09。`gat_mode` 从 `off` 升到 `shadow`/`on` 的硬门禁：

1. 非循环样本 ≥ 500：`SELECT COUNT(*) FROM training_sample WHERE source='adjudication' AND label_kind='overturn'`；
2. 最近 **200** 次带 `stage_ms_json.subgraph_nodes` 埋点的查询，平均子图节点数 ≥ 20。

不达标 → `moshi eval gate` 输出 `{ok:false, reason, current, required}` 且退出 1（硬门禁，不是提示）；daemon 启动时同样拒绝生效。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/infra/sqlite/queryLogRepo.ts` | 新增 `recentSubgraphNodeStats(db, limit)`：`json_extract(stage_ms_json,'$.subgraph_nodes')` 最近 N 条的平均值与实际样本数 |
| `src/core/ops/gate.ts`（新） | 阈值常量（500 / 20 / 200）、`evaluateGatGate(readings)` 纯判定、`checkGatGate(db)` 连库读数、`enforceGatGate(mode, db)` 启动门禁（返回有效模式，不写配置）；判定用**原始均值**、展示值截断到两位小数；无埋点查询不算 0 拉低密度，但空数据判密度 0 不达标 |
| `src/app/cli/commands/eval.ts` | 新增 `moshi eval gate` 子命令：只读用户库（不迁移、不建库），打印单行 JSON，达标退出 0 / 不达标退出 1 / 读取失败 2；`--help` 用法更新 |
| `src/app/main.ts` | daemon 启动硬门禁：调 `enforceGatGate`，不达标 → 记 `model.gate_refused` 日志并把**有效** `gat_mode` 压回 `off`；不写配置文件，数据攒够下次启动自动放行 |
| `tests/unit/gatGate.test.ts`（新） | 15 条：纯判定 5（达标 / 样本不足 / 密度不足 / 19.96 边界 / 无埋点）、连库 4（空库 / 达标 / feedback 与无埋点不计 / 200 窗排除更早小图）、启动门禁 3（off 不读 / shadow 拒绝 / on 放行）、CLI 3（空 home 退出 1 不建库 / 达标库退出 0 / 未迁移库退出 2） |

## 决策

- **窗口按“有埋点的行”取**：P3-07 之前的查询没有 `subgraph_nodes`，算成 0 会凭空拉低密度、让门槛永远过不去；不足 200 条时按实际条数平均（`density.observed` 一并输出，避免误读）。
- **拒绝切换的方式是压有效值而不是改配置**：没有 `config set` 命令，用户手动编辑配置文件是唯一开关；启动时重新评估意味着达标后无需再动手，也不会偷偷改用户文件。
- **门槛顺序**：样本门槛在前（详设列出顺序），`reason` 只报第一条不达标项；两项读数都完整输出。

## 验收

- AC-1 门槛 1 口径与详设 SQL 一致（`source='adjudication' AND label_kind='overturn'`），feedback 样本不计；
- AC-2 门槛 2 只统计最近 200 条带埋点的查询，更早查询被窗口排除、无埋点行不计 0；
- AC-3 `moshi eval gate` 输出 `{ok,reason?,current?,required?,samples,density}`，不达标退出 1、达标退出 0；空库不建库；
- AC-4 daemon 启动对不达标模式压回 `off` 并记日志，配置文件不变；
- AC-5 判定用原始均值（19.96 不达标）；展示值截断到两位小数，`current >= required` 与 `ok` 不矛盾；
- AC-6 `pnpm verify` / `pnpm build` 全绿。

## 读数

| 命令 | 结果 |
| --- | --- |
| `vitest run tests/unit/gatGate.test.ts` | 15 passed |
| `pnpm verify` | 126 files / 1527 passed（修复后） |
| `pnpm build` | exit 0 |

## 验收后修复（2026-11-07）

- **D1（必修）**：密度判定误用四舍五入后的展示值，19.95–19.99 会被判达标、击穿硬门禁。改为判定用原始均值；展示值改**截断**到两位小数（四舍五入会显示 20 却 `ok:false`）。补 19.96 / 19.995 / 20 边界单测。
- **O1（覆盖缺口）**：启动门禁抽成 `enforceGatGate(mode, db)` 纯返回值函数（不在 core 改配置），`main.ts` 只负责记日志与压值；补 3 条单测。CLI 读取失败路径补 1 条（退出 2）。
- **O2（只读副作用）**：WAL 库以 `readonly` 打开会在数据目录留下 `-wal`/`-shm` 伴随文件；逻辑上未写表、未迁移、未建库，属 SQLite 既有行为，不额外处理。
- **O4（展示精度）**：`floor2` 加 1e-9 抵消 `n*100` 的二进制误差（19.99 不再显示成 19.98），不影响判定。
- **O3（观测不足窗口）**：不足 200 条带埋点查询时按实际条数平均，可能仅 1 条即放行；已记想法池 I-56，不阻塞本节点。
