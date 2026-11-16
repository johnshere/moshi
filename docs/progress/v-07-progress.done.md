# V-07 导入边界收口 — 进度（DONE.m2，2026-11-16）

## 目标（用户 m00557：方案一、方案二都执行）

1. **方案一 · 配置继承**：daemon 用 `--config <非默认>` 启动时，导入子进程必须继承同一份配置（客户零感知，不需用户改启动方式）。
2. **方案二 · 并发写**：导入子进程与 daemon（hook / MCP / cron harvest）同时写库不得报错，不允许要求用户先停止 AI 对话。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/app/main.ts` | import `defaultConfigPath`；`buildHttpApp` 传 `configFile`（:168） |
| `src/app/http/server.ts` | `const configFile = deps.configFile ?? defaultConfigPath()`（:219），hook 复用（:241），`importRoutes` 传入（:272） |
| `src/app/http/routes/import.ts` | `ImportRoutesOpts.configFile`（:73-74）；新增 `createDefaultSpawn(configFile, spawnProcess)`（:129-155）——spawn env = `{...process.env, MOSHI_CONFIG: configFile}`，参数仍 `import --since <iso> --json`，stdio `['ignore','pipe','pipe']`；`startRun` 默认分支使用（:256-260） |
| `src/infra/sqlite/db.ts` | `busy_timeout` 5000→10000（:67）；新增 `isBusyError`（:89，含 `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`/`database is locked`）、`RetryBusyOptions`（:96，attempts 5 / baseDelayMs 40 / maxDelayMs 1000 / jitter 0.25）、`backoffDelay`（:115）、`sleepSync`（:129，`Atomics.wait`）、异步重试守卫 `asyncRetryDepth`（:137）、`retryBusySync`（:146）、`retryBusyAsync`（:166） |
| `src/infra/sqlite/tx.ts` | `withTransaction`（:10-24）：已在事务内直接跑；否则 `retryBusySync(() => run.immediate())`——一处覆盖全仓 49 处写事务 |
| `src/infra/sqlite/factRepo.ts` | :149 / :239 / :265 三处事务改走 `withTransaction` |
| `src/core/write/ingest.ts` | :75-81 `ingestEvent` 拆 `writeEvent` 外层套 `retryBusySync`（重放安全：episode 按 `(raw_hash,session)` 查重、annotation `dedup_key` ON CONFLICT DO NOTHING） |
| `src/app/cli/commands/import.ts` | `LOCK_YIELD_MS=20`（:165）、`IMPORT_BUSY_ATTEMPTS=3`（:168）、`harvestOneBatch` 撞 BUSY 退避 20/40/60ms（:183）、主循环（:253）、每片后 `await sleep(20)`（:271） |
| `src/app/http/routes/hook.ts` | :199 `await retryBusyAsync(() => signalForHook(deps, envelope))` |
| `src/app/mcp/tools.ts` | :93 / :104 / :115 `memory_annotate`/`memory_feedback`/`memory_correct` 改 async + `retryBusyAsync` |
| `tests/unit/db-retry.test.ts`（新） | 13 用例：`isBusyError` 判定、退避曲线、真实双连接 `BEGIN IMMEDIATE` 持锁后重试成功、`busy_timeout` 生效、`withTransaction` 嵌套直跑、异步重试内同步放行 |
| `tests/integration/import-api.test.ts` | 新增用例「默认 spawn 工厂让子进程继承 daemon 配置（`MOSHI_CONFIG`）且参数不变」 |
| `tests/unit/migrate.test.ts` | :176 断言 5000→`10_000` |
| `docs/详设.md` | §1.7 `busy_timeout=10000` + 多进程共写重试段；§2.2 PRAGMA 注释同步 |
| `docs/任务台账/想法池.md` | I-67：①③ 标记已修，②（状态仅内存）仍开放 |
| `docs/任务台账.md` | §1 当前任务、§3 v1.x 表、§9.3 机器证据行 |

## 验证

- `pnpm verify`：**153 files / 1785 tests 全绿**（typecheck + typecheck:ui + 四项 lint + vitest）。
- `pnpm build`：exit 0；重启正式 daemon（pid 19052，9836，新构建）。
- 真机（临时 daemon 9846，`--config .dsh/temp/v07/config.yaml`，`sources:["dsh"]`，data_dir 指向 `.dsh/temp/v07/data`）：
  - 继承：3 天导入 **61 会话 / 23165 回合 / 20 新事实 / 0 失败 / 30s**，临时库 `fact=189`；7 天导入 **230 会话 / 47523 回合 / 85 新事实 / 0 失败 / 82s**，临时库 `fact=601`。
  - 隔离：真实库 `~/.moshi/moshi.db` 的 `fact` 计数全程 **35 → 35**（证明子进程确实用临时 data_dir，未误写真实库）。
  - 并发：7 天导入运行中连打 15 次 MCP `memory_annotate`：**15/15 成功、0 错误、max 280ms、avg 88ms**；`/api/import/status` 全程正常。
  - 锁：daemon 日志 1646 行中 `SQLITE_BUSY` / `database is locked` 命中 **0**。

## 补修：点导入弹黑窗（用户 m00778）

- 现象：界面点「开始导入」时弹出一个命令行窗口，绝对不允许。
- 根因：`createDefaultSpawn` 的 spawn 选项只有 `stdio`/`env`，**缺 `windowsHide`**。daemon 以 `DETACHED_PROCESS` 运行、自己没有控制台，而 `node.exe` 是控制台子系统程序——不隐藏就会为每次导入新开一个可见控制台。
- 修复：`src/app/http/routes/import.ts:144-172` 的 spawn 选项补 `windowsHide: true` + Windows `creationFlags: 0x08000000`（`CREATE_NO_WINDOW`），与 `src/infra/sidecar/spawn.ts:73-82` 同一写法（那里注释已记录同类坑）。
- 回归：`tests/integration/import-api.test.ts:208` 用例断言 `windowsHide === true`（win32 另断言 `creationFlags`）。
- 证据：`pnpm build` 后重启 daemon；真机 7 天导入（233 会话）每 300ms 采样 `conhost.exe` 的父进程，导入子进程名下命中 **0**（无控制台 → 无可见窗口），导入 exit 0。

## 遗留

- daemon 内**同步** harvest 事务仍可能长时间占住事件循环（最坏 attempts×(busy_timeout+退避)），未做分片改造。
- 重试要求事务外无副作用：`ingestEvent` 的查重与 `dedup_key` 是重放安全前提，新增写路径需沿用。
- 导入的 3 次 BUSY 重试用尽会提前收工，剩余 annotation 由后台 harvest 接手（非丢数据，但不是即时完成）。
- `/api/import/status` 仍只存内存（I-67 ② 未做）。
