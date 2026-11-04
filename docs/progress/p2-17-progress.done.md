# P2-17 调度器（task-8）

- 状态：**实现 + 自测完成，待 Lead 接线（main.ts）/ verify / build / commit**
- 依据：详设 §8.6（L2741-2763）、台账 P2-17（L981-988）、D-69/D-73
- 环境：2026-11-04，Windows + pwsh 7

## 1. 目标与契约

统一调度 daemon 的全部周期任务，替代各处零散 timer；同一时刻只跑一个任务，片间让出。

| 项 | 实现 |
| --- | --- |
| cron 触发 | `harvest` = `cfg.ingest.harvest_cron`（默认 `0 3 * * *`）、`export` = `cfg.archive.export_cron`（默认 `0 4 * * *`）、`backup` = `0 <cfg.storage.backup_hour> * * *` |
| after 依赖 | `consolidate` after `harvest`、`infer` after `consolidate`、`layout` after `export`（依赖做传递闭包，按 priority 升序串行） |
| 并发 | 1：所有触发进入同一条 Promise 链；`state().running` 可观测 |
| 限速 | 令牌桶 20 条/秒（`createRateLimiter`），任务通过 `ctx.throttle(n?)` 消费 |
| 硬超时 | 单任务 10 分钟，`AbortController` + `Promise.race`，`warn` 后跳过继续下一任务 |
| 错过 | `runDue(now)` 只看当前分钟；`lastMinute` 去重，不补跑历史分钟 |
| 让出 | 每个任务结束后 `await new Promise(setImmediate)` 片间让出，查询不被长任务独占 |
| 时间注入 | `runDue(now)`、`SchedulerOptions.now`、`timerMs`（0 = 不自装定时器） |
| last_harvest_at | harvest 成功后 `setMeta(db,'last_harvest_at',nowIso())`（harvestRunner 路径同样写入，幂等） |

## 2. 关键决策

- **D1 backup 优先级 5，先于 harvest**：备份要在当天写操作前完成；03:00 的顺序为 backup → harvest → consolidate → infer。
- **D2 collect 作为链尾伪任务**：不占 cron 表，按 `cfg.collect.interval_ms` 判断到期，排在当次任务链最后；`collect.enabled=false` 或 interval ≤ 0 不调度。
- **D3 限速器为通用 API**：`createRateLimiter({capacity,intervalMs,now,sleep})` 供任务按 item 消费；当前 harvest/consolidate 仍是批处理，未在内部逐条 take（见遗留）。
- **D4 collectRunner / layoutRunner 默认不自装 timer**：`intervalMs = opts.intervalMs ?? 0`，daemon 由 scheduler 驱动；保留显式 `intervalMs` 入参给测试/独立运行。
- **D5 layout 事件驱动**：`layout` 只在 `export` 之后触发；`cfg.layout.enabled=false` 或 `countUnlaidFacts===0` 时 skip（不启动 worker）。
- **D6 去重键 = 自然分钟**：`Math.floor(now/60000)`，同一分钟重复 tick 返回空数组；调度日志每次任务 start/done 各一条。

## 3. 改动文件

- 新增 `src/app/jobs/scheduler.ts`：`startScheduler(opts): Scheduler`、`parseCron`、`cronMatches`、`createRateLimiter`、`DEFAULT_JOB_TIMEOUT_MS`、`RATE_LIMIT_PER_SECOND`、`SCHEDULER_TICK_MS`。
- `src/app/collectRunner.ts`：默认 `intervalMs=0`（不再读 `cfg.collect.interval_ms`）。
- `src/app/layoutRunner.ts`：默认 `intervalMs=0`（不再读 `cfg.layout.interval_ms`）。
- `src/app/harvestRunner.ts`：harvest 成功后写 `meta.last_harvest_at`。
- 新增 `tests/unit/scheduler.test.ts`（9 tests）。

未改：`src/app/main.ts`、`src/app/cli/index.ts`、`src/app/http/server.ts`（Lead 统一接线）。

## 4. 验收记录

### 类型 / 测试 / lint

```
pnpm typecheck
→ ✔ 无输出（exit 0）

pnpm vitest run tests/unit/scheduler.test.ts tests/unit/collectRunner.test.ts tests/unit/community.test.ts
→ Test Files  3 passed (3)
  Tests       24 passed (24)
  （scheduler 9、collectRunner 2、community 13；community 10k 性能用例 6.2s）

pnpm lint:lifecycle → ✔ 生命周期写路径检查通过（102 个文件）
pnpm lint:deps      → ✔ 依赖方向检查通过（150 个模块，644 条内部依赖，5 条规则）
pnpm lint:writes    → lint:writes OK — 102 个文件，无白名单外写调用
pnpm exec eslint src/app/jobs/scheduler.ts src/app/collectRunner.ts src/app/layoutRunner.ts \
  src/app/harvestRunner.ts tests/unit/scheduler.test.ts --ext .ts
→ 无输出（clean）
```

### 模拟 03:00 tick（临时脚本，跑完已删）

```
tick at 2026-11-03T19:00:00.000Z (local 03:00)
  backup      ok      8ms
  harvest     ok      2ms
  consolidate ok      1ms
  infer       ok      0ms
total 12ms | runs=4
last_harvest_at = 2026-11-04T13:57:19.313Z
--- log ---
[info] scheduler job backup start      {"event":"scheduler.job.start","job":"backup",...}
[info] scheduler job backup done       {"event":"scheduler.job.done","job":"backup","ms":8}
[info] scheduler job harvest start     {"event":"scheduler.job.start","job":"harvest",...}
[info] scheduler job harvest done      {"event":"scheduler.job.done","job":"harvest","ms":1}
[info] scheduler job consolidate start {"event":"scheduler.job.start","job":"consolidate",...}
[info] scheduler job consolidate done  {"event":"scheduler.job.done","job":"consolidate","ms":1}
[info] scheduler job infer start       {"event":"scheduler.job.start","job":"infer",...}
[info] scheduler job infer done        {"event":"scheduler.job.done","job":"infer","ms":0}
```

（04:00 的 export → layout 由单测 `03:00 依次跑 harvest→consolidate→infer` 与默认 JOBS 集成用例覆盖结构；export 依赖 P1 export 命令，daemon 路径未在 demo 触发。）

### 单测覆盖（`tests/unit/scheduler.test.ts`）

1. cron 解析/匹配：03:00、`*/15`、周字段；非法段数与越界抛错。
2. 03:00 顺序 harvest→consolidate→infer；同分钟第二次 tick 返回空。
3. 错过 tick 不补跑（03:05、03:06 均无任务）。
4. 并发 1：两个分钟 tick 排队，`maxActive=1`，顺序 4 条。
5. 超时：harvest 永不 resolve → `timeout` + warn，consolidate 继续 `ok`。
6. 令牌桶：满桶 20 条可用，第 21 条 sleep ≥ 50ms。
7. collect 由 scheduler 按 `collect.interval_ms` 驱动。
8. collectRunner / layoutRunner 默认不装 timer（spy `setInterval`/`setTimeout`，cfg interval=5 也不触发）。
9. 真实默认 JOBS：03:00 先 backup 后 harvest，链式 consolidate→infer，`last_harvest_at` 非 null。

## 5. 需要 Lead 的接线（`src/app/main.ts`）

```ts
import { startScheduler } from './jobs/scheduler.js';

// boot 成功、collectRunner/layoutRunner 创建之后：
scheduler = startScheduler({
  db,
  cfg: instance.cfg ?? cfg,
  log,
  collect: () => collectRunner?.runOnce() ?? null,
});

// shutdown 路径：
scheduler?.stop();
```

说明：`collectRunner`/`layoutRunner` 仍创建（保持 `runOnce`/`state` 可被 HTTP 复用），但不再自调度；`harvestRunner`/`schemaRunner`/`communityRunner` 的既有事件驱动路径保持不变。若希望这两条也完全交给 scheduler，可后续把 `runner.wake()` 收敛为任务，但不属本卡。

## 6. 遗留

- **item 级限速未接入批处理内部**：harvest/consolidate 目前按批执行，`ctx.throttle` 已提供但未逐条 take；当前批大小本身受 cfg 限制，待后续按实测 QPS 接入。
- **layout 仅 04:00 export 后跑**：白天新增未布局事实只能等下一次 export；若需更及时，应把 layout 触发挂到 communityRunner/写路径（另立任务）。
- **communityRunner / schemaInferRunner / harvestRunner 仍各自有内部 timer/事件路径**：本卡只收口 collect/layout 的 daemon 入口（D-69/D-73），其余保留，避免一次改太多。
- **调度日志 at 用真实 nowIso()**：`runDue` 注入时间只用于触发判定；如需完全可复现日志，可把 `now` 传入日志字段（无功能影响）。
- **进程内单 scheduler 假设**：多 daemon 实例同时跑会重复触发；当前由 `.moshi/moshi.lock` 单实例约束，未加分布式锁。
