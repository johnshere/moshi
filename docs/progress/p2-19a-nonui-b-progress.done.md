# P2-19A 非 UI 缺口包 B — 进度

- 任务卡：task-14（P2-19A 非 UI 缺口包 B）
- 状态：DONE（实现 + 单测 + 真实数据探针通过；build/verify 由 Lead 统一跑）
- 分支基点：当前工作区 HEAD（未改 `docs/任务台账.md`、`package.json`、`src/ui/**`、`src/app/http/server.ts`、`src/app/cli/index.ts`、`src/app/main.ts`、`src/app/communityRunner.ts`）

## 改动文件

| 文件 | 改动 |
|---|---|
| `tools/check-archive.ts` | 新增：归档反模式静态检查（ingest / content_full / delete），`--json`，违规 exit 1 |
| `tests/unit/check-archive.test.ts` | 新增：干净样例 + 三类违规 + `check-archive-ignore` 白名单，共 5 例 |
| `src/core/diag/types.ts` | `DiagArchiveJson` 增 `proposed_pending` / `merged_or_split`；`DiagQualityJson` 增 `layout_freshness` |
| `src/infra/sqlite/diagRepo.ts` | `readArchiveSummary` 增两项 SQL；新增 `readLayoutTimestamps(db)` |
| `src/core/diag/quality.ts` | 新增 `computeLayoutFreshness(lastLayoutAt, lastFactWriteAt)` |
| `src/core/diag/collect.ts` | 采集布局时间戳并填充 `quality.layout_freshness` |
| `tests/unit/diag.test.ts` | 空库字段断言更新；新增 archive 补项 + layout 新鲜度用例（24h） |
| `src/app/jobs/scheduler.ts` | 默认 JOBS 增 `community`（周级 cron + `after:'infer'` + 脏检查复用 `runCommunityOnce`） |
| `tests/unit/scheduler.test.ts` | 默认 JOBS 顺序断言 + 社区周级/链式触发用例（10 tests） |

## 实现决策

1. **layout_freshness 口径**：`MAX(layout.computed_at)` 与 `MAX(fact.updated_at)` 的小时差（保留 4 位），正数 = 有写入尚未上屏；无 layout 行（`last_layout_at` 为 null）→ `null`。未新增表，也未依赖 `layout_version`（该 meta 键是代数不是时间）。
2. **archive 补项语义**：`proposed_pending = COUNT(human_edited=1)`（待合并）；`merged_or_split = COUNT(status <> 'active')`；`human_edited` 保持原口径（`<>0`，含 1/2）。
3. **last_eval**：全仓确认无写入方（`POST /api/eval` 不存在，CLI eval 不写 `meta`），按契约只读不新增接口；`meta.last_eval` 缺失时输出 `null`，报告中注明「无 eval 记录」。
4. **社区重建**：独立周级 cron `0 5 * * 0`（周日 05:00，priority 60）+ `after:'infer'`，保证「事实/schema 先更新、社区后重建」；任务体复用 `runCommunityOnce(db)`（不另起 runner 定时器），用 `schemaRev(db)` + `countEdges(db,true)` 做等价于 `startCommunityRunner` 的脏检查，无变化返回 `{skipped:'up-to-date'}`，避免每日 harvest 链重算同一张图。放在 `infer` 之后而非链尾 `layout` 之后，避免与 export/layout 链重复触发。
5. **check-archive**：TypeScript AST 扫描 `src/core/archive/*.ts`（排除测试）；`ingest` 只在同文件同时出现「读归档 md」与「写 fact/entity/ontology」时报；`content_full` 匹配原始来源字段（`rawText/sourceText/originalText/payloadJson/payload/episodeText/transcriptText/messageText`），放行 `fact.content` 摘要与 archive_meta 的 `content_hash` 基线；`delete` 匹配 `rm/rmSync/unlink/unlinkSync/safeRemoveFile/safeRemoveDir`；行内或上一行 `check-archive-ignore` 白名单。

## 验收证据（2026-11-04）

```
pnpm typecheck
→ 无输出（通过；首次测试内模板字符串转义 TS1127，已改字符串拼接）

pnpm vitest run tests/unit/check-archive.test.ts tests/unit/diag.test.ts tests/unit/scheduler.test.ts
→ Test Files 3 passed (3) / Tests 27 passed (27)
  check-archive 5、diag 12、scheduler 10

pnpm exec tsx tools/check-archive.ts
→ check-archive OK — 6 个文件，无归档反模式（exit 0）

pnpm exec tsx tools/check-archive.ts --json
→ {"ok":true,"files":["src/core/archive/guard.ts","index.ts","render.ts","topic.ts","topics.ts","writer.ts"],"violations":[]}（exit 0）

pnpm lint:lifecycle → ✔ 生命周期写路径检查通过（103 个文件）
pnpm lint:deps      → ✔ 依赖方向检查通过（151 个模块，656 条内部依赖，5 条规则）
pnpm lint:writes    → lint:writes OK — 103 个文件
```

真实数据探针（`.dsh/temp/p2-19a/diag-probe.ts`，seed 60 facts / 30 edges 后插 3 条 archive_meta）：

```json
{
  "archive": {"topics":3,"dirty":1,"human_edited":2,"proposed_pending":1,"merged_or_split":1},
  "quality": {"orphan_ratio":0.4,"modularity":-0.0583,"stale_chains":0,"near_dup_ratio":0,
              "key_entity_coverage":1,"scope_leak":0,"layout_freshness":0},
  "last_harvest_at": null,
  "last_eval": null
}
```

## 需 Lead 接线

1. `package.json`：新增 `"lint:archive": "tsx tools/check-archive.ts"`，并加入 `verify`（建议排在 `lint:writes` 之后；工具违规时 exit 1，可直接 fail 构建）。你之前说 verify 接线归你，这里只给建议。
2. `/api/diag` 新字段由现有 `diagRoutes` 自动返回（响应只增字段，向后兼容），`server.ts` 无需改。
3. `community` job 在 `buildDefaultJobs` 内，daemon 启动即生效，`server.ts` / scheduler 调用方无需改。
4. `src/ui/tsconfig.json` 的 settings/** 接线属于 P2-18 遗留，本卡未触碰 UI。

## 遗留 / 说明

- `check-archive` 为静态检查：允许 archive_meta 的 content-hash 基线读取（§9.4 设计口径）；若未来出现动态拼 SQL/间接调用，需要增强。
- 社区 job 的脏检查状态保存在调度器实例内存中，进程重启后的首轮会无条件重建一次（等价 runner 首次运行，可接受）。
- 无新增 TODO/FIXME；未跑 `pnpm build` / `pnpm verify`（Lead 统一）。
