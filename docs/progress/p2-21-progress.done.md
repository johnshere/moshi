# P2-21 两阶段扫描器 —— 过程记录（DONE）

> 归档时间 2026-11-02 08:32。对应台账 §3 `P2-21`、§4 详情、§6 `2026-11-02 08:30` 条目、§5.2 D-69。

## 1 开工时的真实状态（不是台账写的状态）

台账标 WIP，实际是**死代码**：

| # | 缺陷 | 证据 |
| --- | --- | --- |
| 1 | 没有测试、没有生产调用点 | 全仓 grep `scanAllSources\|scanTurns` 只命中 scanner.ts 自身 |
| 2 | `scanSessionSource` 拿假 ref 调 `readEpisode`（`path:''`） | 空路径必然 stat 失败，读到 0 个事件 |
| 3 | 阶段 2 没接失败语义 | 无 `llm_scan_unavailable`，超限是 `continue` 而非停 |
| 4 | 游标复用文件偏移语义 | 详设 §5.12.4 要的是 `{turn_index, block_index, block_hash}` |
| 5 | 阶段 2 幂等键用本地数组下标 | 跨次扫描不稳定 |
| 6 | annotation 无 pending 概念 | §5.12.2「全部 pending」未落地 |
| 7 | 块里的 edge 只进 payload | `harvest.applyAnnotation` 只读 `payload.facts[]`，边被丢弃 → 属 P2-22 |
| 8 | `llm_scan_*` 想塞隔离区 | `quarantine.enqueue` 的 reason 枚举里根本没有这三个值 |

结论：不能"接着做"，只能"重写 + 补调用点 + 补测试"。

## 2 做了什么

### 2.1 `src/core/collect/scanner.ts`（重写）

- **块游标**：`BlockCursorStore` 独立文件 `<data_dir>/cursors.blocks.json`，键 `"<source>\u0000<path>"`，值 `BlockCursor = Cursor & {turnIndex, blockIndex, blockHash}`；损坏/形状不对时 `onCorrupt(reason)` 后重建空游标，不抛错。
  - 不复用 `CursorStore`：那是 import 线的游标，两个写者共用一个文件会互相覆盖。
- **阶段 1**（确定性）：逐 turn `findMoshiBlocks` → `parseAnnV1Block` → `extractFromBlock`（facts ≤20 / edges ≤20）→ `annotationRepo.insert({dedupKey: blockDedupKey(sessionId, blockHash), channel:'harvest', origin:'agent_format@v1'})`。畸形 / 未知版本进隔离区（`ann_malformed` / `ann_version_unknown`），同 turn 的其它块照常处理。
- **阶段 2**（LLM 兜底）：只喂**没有块**的 turn；`llmBatchTurns` 切批（默认 40）；`clampConfidence(facts, 0.6)`；幂等键 `dk-llm:${sessionId}:${turnStart}:${turnEnd}:${promptVersion}`，origin `llm_scan@v1`。
  - 三道闸：`llmPerSessionDaily`（会话/天，超了 `llm_scan_session_daily_reached` 直接跳过）、`llmDailyTokenBudget`（累计 token 达上限即 `break` → `llm_scan_budget_exhausted`）、LLM 抛错 → `llm_scan_unavailable` 且阶段 1 结果保留。
  - `LlmScanner` 是注入点；生产侧传 `undefined`（LLM 归纳属 P3），不在生产路径上伪造本地假 LLM。
- **顺序不可颠倒**：先阶段 1 全量入队，再跑阶段 2；先写 episode 再推进游标。

### 2.2 `src/app/collectRunner.ts`（新增，生产调用点）

`startCollectRunner({db, cfg, cursorsFile, home, genericInbox, sources?, log?, onEnqueued?, intervalMs?})`：

- `collect.interval_ms` 驱动（默认 60s），`timer.unref()` 不拖住进程退出；
- 单轮不重入：运行中 `wake()` 只置 `again`，本轮结束补跑一次；
- 有 annotation 入队（`blockAnnotationsCreated + llmCalls > 0`）就 `onEnqueued()` 唤醒 `harvestRunner`，事实不必等 15s 兜底周期；
- `collect.enabled=false` → `runOnce()` 返回 `null`，一轮都不扫；
- `state()` 暴露 `{runs, lastMs, lastError, lastStats, enabled}`，`stop()` 摘定时器。

**为什么现在做**：台账 §4 写"挂到 P2-17 调度器"，而 P2-17 依赖 P2-09/12/15，全未开工。不改这一条，扫描器就是死代码，DoD 第 6 条直接不过（P1-08/P1-14 踩过同一个坑）。P2-17 落地后只换驱动，扫描逻辑不动 → 记 D-69。

### 2.3 接线与配置

- `src/app/main.ts`：`import os`、`startCollectRunner`；boot 后 `startCollectRunner(...)`（`cursorsFile: dataPaths(cfg).collectCursors`、`home: os.homedir()`、`onEnqueued: () => runner?.wake()`），启动失败只记 `collect.start.failed` 不阻断 daemon；`shutdown` 里 `collectRunner?.stop()` 排在 harvest 之后。
- `src/app/config.ts` / `config.example.toml` 的 `[collect]` 段：P2-20 时已加，本轮沿用（enabled / interval_ms / llm_scan / llm_batch_turns / llm_per_session_daily / llm_daily_token_budget / prompt_version）。

### 2.4 测试

| 文件 | 例数 | 覆盖 |
| --- | --- | --- |
| `tests/unit/scanner.test.ts` | 9 | 两遍幂等、harvest 端到端零增量、畸形+v99 进隔离区、阶段 2 只喂无块 turn、置信 ≤0.6、预算即停（2 批后停）、会话闸、LLM 抛错、块游标推进 / 损坏重建 |
| `tests/unit/collectRunner.test.ts` | 2 | 真实 `~/.claude/projects` 目录 → 扫出 annotation → 唤醒一次；二遍不重复 / 不重复唤醒；`enabled=false` 空转 |

## 3 验收输出

```
pnpm verify   → Test Files 52 passed (52) / Tests 604 passed (604)
pnpm build    → tsc -p tsconfig.build.json && node tools/copy-assets.mjs（通过）
```

## 4 坑

- **第一次 verify 挂 typecheck**：测试里 LLM 返回值按 `{subject,predicate,value,confidence}` 构造，`AnnotatePayload` 还要求 `etype` + `content`（TS2739）。→ 测试数据必须照 `harvest.ts:322` 的完整形状写。
- `timer.unref()` 对 `setTimeout` 有效（Node ≥ 18 返回带 `unref` 的 Timeout）；忘了它，daemon 的 shutdown 会被下一轮扫描顶住。

## 5 留给后面的

- **边没落库**：块里的 `pending`/`resolved` 边只进 annotation payload，`harvest.applyAnnotation` 不消费 → `edge` 表恒 0。这是 P2-22 的活（`core/write/edges.ts` + `003_edges.sql`）。
- **阶段 2 无真实 LLM**：`LlmScanner` 注入点已就位，接线属 P3；在那之前 `collect.llm_scan` 开着也只是空跑阶段 1。
- **P2-17 调度器**：落地后把 `collectRunner` 的定时器换成调度器（D-69）。
- **块游标 vs 文件偏移**：块游标同时携带文件偏移（`offset/size/inode/lastTs`）做重读优化，`turn_index` 的确定性靠 annotation 幂等键兜底；文件被 truncate / 轮转时的行为依赖 `readLines` 的处理，本轮未单独验证。
