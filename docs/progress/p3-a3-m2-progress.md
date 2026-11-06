# P3-A3 m2 进度（实施子代理维护）

- 状态：**FAILED（第二次独立验收，仅 AC-2；按批次规则终止，等用户裁决）**；数值面达标，生命周期缺陷归预存 B-8/P3-A9
- 机器：M2 本机（Windows，pwsh 7；证据不引用 M1 读数）
- 设计：`docs/progress/m2-batch-20261107/p3-a3-design.md`
- 验收：`docs/progress/m2-batch-20261107/p3-a3-acceptance.md`
- 复核时间：2026-11-07 01:59–02:26（Asia/Shanghai）
- 本任务**零代码改动**；只写本进度文件；未 commit、未 push。

## 0. 结论摘要

| 项 | 结论 | 说明 |
| --- | --- | --- |
| AC-1 setup-env | PASS | exit 0，venv/依赖 hash/模型合格 |
| AC-2 eval --vector | **BLOCKED** | 数值全部达标（四类各 10、temporal/refusal 10/10、门禁 exit 0、临时副本），但命令打印结果后**永不自然退出**（verifier 181.7s、本机 109s/129s 仍存活） |
| AC-3 sidecar.test | PASS | 2/2 通过、0 跳过、无整组 skip |
| AC-4 真实库未改 | PASS | SHA256/长度/mtime 多次复跑前后一致 |

## 1. setup-env --check（AC-1 PASS）

```
$ node scripts/setup-env.mjs --check
[setup-env] 系统 Python：C:\Users\john\AppData\Local\Programs\Python\Python313\python.exe
判定：J:\Workspace\Codes\moshi\sidecar\.venv\Scripts\python.exe
写主目录探测 通过 · 模块 齐全 · 模型 在 · 依赖hash 一致
[setup-env][check] 合格
EXIT=0
```

## 2. eval run --golden v1 --vector（AC-2 数值达标；退出行为 FAIL）

命令（未加 `--in-place`；数据面默认 `mkdtempSync(os.tmpdir()/moshi-eval-)` + `db.backup` 临时副本，真实库不被写）：

```
$ pnpm exec tsx src/app/main.ts eval run --golden v1 --vector
golden 题型：single_hop=10 multi_hop=10 temporal=10 refusal=10
向量索引（仅副本）：编码 0 条，缺 0，失败 0
golden 评估（C:\Users\john\.moshi\golden\golden.v1.jsonl；数据面 临时副本；向量路 开）：30/40 通过（跳过 0 行非法）
single_hop: 10/10  multi_hop: 0/10  temporal: 10/10  refusal: 10/10
  FAIL g-m01 [multi_hop] recall@K=1.00；依赖链 0 条
  ...（g-m02~g-m10 同形，共 10 条多跳 FAIL）
```

- 四类计数齐全：single_hop=10 / multi_hop=10 / temporal=10 / refusal=10。
- 拒答（refusal）通过 **10/10**；时序（temporal）通过 **10/10**；门禁只含 temporal+refusal → `gate_failed=false`。
- `multi_hop: 0/10` 属预期：真实库 `edge=0` → `dependency_summary.length=0` 必挂（台账 B-1 / P1-16 m2 已裁决不导致非 0）。
- 「编码 0 条」语义：临时副本 `db.backup` 已含全部 60 条向量（只读核验 `fact_vec=60`、`meta.vec_dim=512`），`syncFactVectors` 只补缺失行 → 增量 0 是正确的「已同步」读数（缺 0、失败 0）。与 2026-11-06 M2 记录 `temp/m2-verify/eval-vector-m2.txt` 逐行一致。
- sidecar 就绪时间：02:14:08 spawn → `sidecar.ready` 写入 `started_at=2026-11-07T02:14:15.145Z`，约 **7s**。
- 输出打印耗时约 10s；**此后进程永不退出**，三次运行均需外部 `taskkill /T /F` 杀 sidecar 树后 node 才退出（EXIT=0）。**不把外部 kill 后的 EXIT=0 当作自然退出证据。**

## 3. 定向返工（验收打回后）：自然退出路径排查 → 不存在

| # | 变体（无代码改动） | 结果 |
| --- | --- | --- |
| a | `pnpm exec tsx src/app/main.ts eval run --golden v1 --vector`（原命令，2 次） | 打印 ~10s；109s / verifier 181.7s 时进程树仍活 → FAIL |
| b | `node dist/app/main.js eval run --golden v1 --vector`（dist 2026-11-07 01:57:46 构建）+ stdin 重定向 `< NUL` | 打印内容逐行同 a；`node` 启动 129s 时仍活（cmd→node→python launcher→python），taskkill 后 EXIT=0 → FAIL |
| c | CLI 参数 / `--config` / 环境变量 / 等待超时 | 代码面不存在可用开关（见下），未跑非法组合 |

只读代码排查（结论：唯一出口是外部终止进程）：

- `src/app/main.ts:248-254`：入口仅 `if (code !== 0) process.exitCode = code`，**无 `process.exit()`**；cli 模式依赖事件循环自然排空。
- `src/app/cli` 无 stdin 读取（关闭 stdin 无影响）；`src/app/cli/commands/eval.ts:69` 仅支持 `--golden/--vector/--in-place/--allow-partial`，无 `--timeout`/`--no-sidecar`/`--json` 等；无相关环境变量开关。
- `src/infra/sidecar/client.ts:123-133`：`ensureStarted` 每次都 `spawnSidecarProcess()`，**无「接管已存在 sidecar」路径**（`--config` 换 pipe 名同样会自拉新进程）。
- `src/infra/sidecar/client.ts:199-222`：`shutdown()` 对已 ready 实例只发 `/shutdown`，**不 kill**（只有 `ready===null` 的启动中实例才 kill）。
- `src/infra/sidecar/spawn.ts:92-98`：`child.stdout/stderr.on('data')` + `createWriteStream(logFile)` 常开，`child.unref()` 不足以让事件循环排空（日志流与子进程管道持续 ref）。
- `src/infra/sidecar/client.ts:311-327`：`checkIdle` 的 `idle_exit` 分支同样只 `cleanupTransport()` 不 kill，且 eval 的 `shutdown()` 已 `clearInterval(idleTimer)`，空闲路径根本不会触发。
- `sidecar/moshi_sidecar/server.py:119-121`：`/shutdown` 只 `state.unload()` + `return {"ok": True}`；全文件无 `sys.exit`/`os._exit`；而 docstring 第 11 行写「/shutdown → {ok}（随后进程退出）」——**实现与设计意图不符**。

⇒ 该退出缺陷为**预存缺陷**（非 P3-A3 引入：本任务零代码改动；`src/app/cli/commands/eval.ts` 最后改动为 `d3ced7b`「P1-16 m2」；2026-11-06 M2 证据输出与本次逐行一致）。在「不改代码/脚本/测试」的约束下（改任何源码都会破坏 AC-4），**P3-A3 m2 无代码任务无法修复**，故报 BLOCKED。

## 4. sidecar 集成测试（AC-3 PASS）

```
$ pnpm exec vitest run tests/integration/sidecar.test.ts
Test Files  1 passed (1)
     Tests  2 passed (2)          ← 执行 2、通过 2、跳过 0
  Duration  30.29s（transform 129ms / collect 7.89s / tests 22.13s）
EXIT=0
```

- 文件实际 2 条用例：`spawn → 就绪 → health → encode → unload → shutdown 全链路`、`kill 掉进程后自动重启（重启计数 +1）`。
- **无整组 skip**：`describe.skipIf(!pythonOk || !modelOk)` 未触发（M2 本机 python venv 与模型权重均具备，与 §1 互证）。
- 每用例独占管道 `\\.\pipe\moshi-sci-<pid>-<seq>`，未与固定管道冲突。

## 5. 真实库只读基线（AC-4 PASS）

只读方式（`better-sqlite3` readonly + `sqlite-vec.load()`，未执行任何写语句）：

| 项 | eval 前 | 三次运行后 |
| --- | --- | --- |
| `moshi.db` SHA256 | `EAC8E2791BB318551A8BD4489BBA0F4FE082870042C4417488DCD36D7170D27B` | 同左（一致） |
| 长度 / mtime | 2908160 / 2026-11-06 20:28:26 | 2908160 / 2026-11-06 20:28:26 |
| `query_log` 行数 | 174 | 174（不增长） |

- `fact=60`、`fact_vec=60`、`edge=0`、`meta.vec_dim=512`、`meta.vector_disabled` 不存在（向量路开启）。
- 直接查 `fact_vec` 需加载 vec 扩展，否则报 `no such module: vec0`（预期，非失败）。
- 未用 `--in-place`、未手工改 `~/.moshi`、未跑 `icacls /setintegritylevel L`（M1 条件）。

## 6. 未决/风险与建议（BLOCKED 归属）

1. **建议新增任务 P3-A9「sidecar 进程关停/生命周期修复」**（预存缺陷，非本批次节点引入）：
   - 修复点：① `sidecar/moshi_sidecar/server.py:119-121` 的 `/shutdown` 置退出标志并在 `serve_pipe` 关闭管道后退出进程（或 dispatch 返回 `{"ok":true,"exit":true}` 后 `sys.exit(0)`）；② `src/infra/sidecar/client.ts:199-222` `shutdown()` 对已 ready 实例补 kill 兜底（CLI 单次运行必须收口）；③ `src/infra/sidecar/spawn.ts:92-98` 日志流 `close()`/`unref()`，确保 `child.unref()` 后事件循环可排空。
   - 验收口径：`node dist/app/main.js eval run --golden v1 --vector` 在 **≤60s 自然退出且 exit 0**，重复 3 次每次均自然退出；退出后 `Get-CimInstance Win32_Process -Filter "Name='python.exe'"` 中 moshi sidecar 计数为 0、无 `\\.\pipe\moshi-infer` 残留；`tests/integration/sidecar.test.ts` 仍 2/2 通过；新增「eval --vector 自然退出」CLI 集成测试；`pnpm verify` 全绿；真实库 SHA256/mtime 不变。
2. **AC-2 判定建议**：数值面（四类各 10、temporal/refusal 10/10、门禁 exit 0、临时副本、DB 未改）全部达标，唯「自然退出」不满足；建议本节点记 BLOCKED/WIP 并归因预存缺陷，由 P3-A9 修复后重验，而非把 FAIL 记在 P3-A3 代码头上。
3. **环境残留**：复核开始时固定管道 `\\.\pipe\moshi-infer` 被 2 组昨日孤儿 sidecar 占用（21800/13984 token `5e30ad87…`、2192/19628 token `3cb057c7…`，2026-11-06 20:39/20:43），已在重跑前清理；`~/.moshi/sidecar.ready` 现为最近一次运行的陈旧就绪文件，按规则未手工改动。
4. **AC-2 文案「编码 60 条」与实际读数差异**：实测「编码 0 条，缺 0，失败 0」，原因是副本已含 60 条向量（真实库 `fact_vec=60` 佐证），与 P1-16 m2 / 2026-11-06 M2 记录口径一致。
5. 工作区未提交改动说明：`docs/progress/m2-batch-20261107-progress.md` 为 Lead 既有未提交改动（+3/−3 状态表），非本子代理产生；本子代理唯一改动为本文件。
6. 未 commit、未 push（等 Lead 裁决）。

## 7. 第二次独立验收（2026-11-07 02:30）

- 结论 **FAIL（第二次，仅 AC-2）**：结果 11.5s 打印齐全（四类各 10、temporal/refusal 10/10、临时副本、无 `--in-place`），但 181.8s（结果后 170.3s）进程树仍活（node→python sidecar），`HAS_EXITED=False`，无自然退出。
- 无代码改动：HEAD 仍 `d3ced7b`；`git status` 仅本文件与总进度文件；src/sidecar/tests/scripts 零改动；`git diff --check` 干净。
- AC-1/3/4 复跑仍 PASS：`setup-env --check` exit 0；`sidecar.test.ts` 2/2 自然退出；真实库 SHA256/size/mtime/`query_log=174` 前后不变。
- 只 kill 自己启动的进程树，强制终止后 EXIT=1、无残留；未改文件、未 commit、未 push。
- 按批次规则：二次 FAIL → 终止批次；P3-A4 不启动；待裁决 B-8/P3-A9 与 P3-A3 m2 口径。
