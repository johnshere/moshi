# P2-19A-06 设置页后端：配置读写与维护重建 — 进度

- **任务**：task-18（P2-19A-06）
- **状态**：实现 + 自测完成，待 Lead 注册 `configRoutes`、verify/build/commit
- **时间**：2026-11-04

## 目标

设置页从「只读诊断」变为可配置 + 可维护：

1. `GET /api/config`：返回白名单安全子集（**不含 token / sidecar / mcp 等敏感段**）。
2. `PUT /api/config`：`{patch:{...}}` 白名单键、深层合并、类型/范围校验、TOML 原子写回；
   返回 `{ok, schema, applied, restart_required}`。
3. `POST /api/maintenance/rebuild`：`{target:'fts'|'vec'|'degree'|'all', dry_run?}`，
   复用既有索引重建函数，返回 before/after mismatch 计数与耗时。
4. SettingsPage：ConfigForm + MaintenancePanel，保留既有 DiagPanel。

## 决策

- **D1 白名单是唯一映射来源**：`src/app/config.ts` 新增 `EDITABLE_CONFIG_ENTRIES`（15 项），
  对外路径与配置文件路径可不同（`http.port` 实际落 `server.port`）。GET/PUT 都查这张表，
  不二次维护键列表。
- **D2 GET 不整段 dump Config**：`publicConfig()` 逐字段列白名单子集；`sidecar`/`model`/`mcp`
  等运行期敏感段永远不出现。
- **D3 保留非白名单既有键**：PUT 先读原始 TOML → `mergeConfigDocument` 深合并 → 写回，
  不把 `model.gat_mode` 这类用户键抹掉。
- **D4 校验顺序与 reason**：白名单 → cron（`cron_invalid`）→ interval（`interval_invalid`）→
  `ConfigSchema`（`value_invalid`，含 issues）→ port ≤ port_scan_max（`port_invalid`）。
  所有错误走 `E_INPUT` 400 + `detail.reason`，前端直接展示后端 message。
- **D5 restart_required 只看实际 applied**：前端只提交**改动过的键**，避免未改动的 `http.port`
  把 `restart_required` 误置 true。启动期键 = `http.port` / `storage.data_dir` / `storage.archive_dir`。
- **D6 原子写**：复用 `src/infra/fs` 的 `safeEnsureDir` + `safeWriteFile`（内部 `.tmp` + rename，
  Windows 目标存在时先 unlink），写路径限制在 `dataPaths(cfg).root` 白名单内。
- **D7 维护复用既有实现**：FTS = `syncMissingFts` + `rebuildFts`；度数 = `rebuildDegree`；
  向量 = `syncFactVectors`（sidecar 注入时）。不新写 SQL/索引逻辑。
- **D8 dry_run 只计数**：`before/after` 都取 `readIndexInputs` 派生计数；`dry_run=true` 不写任何东西。
- **D9 向量不可用**：显式 `target:'vec'` 且无 sidecar → 503 `E_BUSY` `reason=sidecar_unavailable`；
  `target:'all'` 时跳过 vec 并在 `skipped` 里标注；`vector_disabled` 时也 skipped。

## 改动文件

| 文件 | 说明 |
| --- | --- |
| `src/app/config.ts` | 只增：白名单表、`readConfigDocument`/`stringifyConfigDocument`/`writeConfigDocument`、`mergeConfigDocument`、`checkConfigDocument`、`isValidCronExpression`、`PUBLIC_CONFIG_SCHEMA`、`RESTART_REQUIRED_PATHS`。既有 `loadConfig`/`ConfigSchema` 未动。 |
| `src/app/http/routes/config.ts` | 新增：`configRoutes(app,{db,cfg,configPath?,home?,roots?,sidecar?})`；`GET /config`、`PUT /config`、`POST /maintenance/rebuild`。 |
| `src/ui/settings/ConfigForm.tsx` | 新增：分组表单（采集/归档/启动期只读）、改动 diff、保存、toast、需重启黄条、错误条。 |
| `src/ui/settings/MaintenancePanel.tsx` | 新增：dry_run 开关 + FTS/vec/degree/all 四按钮 + before/after 表。 |
| `src/ui/settings/SettingsPage.tsx` | 挂载 ConfigForm + MaintenancePanel + 既有 DiagPanel。 |
| `tests/unit/config-api.test.ts` | 新增 13 例。 |

## 验收命令与输出

```text
pnpm typecheck      → clean
pnpm typecheck:ui   → clean
pnpm vitest run tests/unit/config-api.test.ts → 13 passed
pnpm lint:deps      → ✔ 152 模块 / 680 条内部依赖 / 5 规则
pnpm lint:writes    → ✔ 104 文件
pnpm lint:lifecycle → ✔ 104 文件
pnpm exec eslint src/app/config.ts src/app/http/routes/config.ts tests/unit/config-api.test.ts → clean
（src/ui 被 eslint ignore pattern 忽略，与既有 UI 文件一致）
```

## 真实 inject 输出（临时脚本，已删除）

```text
[GET /api/config] 200
{"schema":"moshi-config/1","config":{
  "ingest":{"harvest_cron":"0 3 * * *"},
  "archive":{"export_cron":"0 4 * * *","dirty_threshold_facts":3,"dirty_threshold_confidence":0.15,"min_facts":8,"history_keep":5},
  "layout":{"enabled":true,"interval_ms":60000},
  "collect":{"enabled":true,"interval_ms":60000,"llm_scan":true},
  "http":{"port":53000},
  "storage":{"data_dir":"C:\\Users\\john\\.moshi","archive_dir":"C:\\Users\\john\\Documents\\默识归档","backup_keep":7}},
 "meta":{"config_path":"C:\\Users\\...\\home\\.moshi\\config.toml"}}

[PUT /api/config] 200
{"ok":true,"schema":"moshi-config/1","applied":["ingest.harvest_cron","layout.interval_ms"],"restart_required":false}

[config.toml AFTER]
[ingest]
harvest_cron = "15 2 * * *"

[layout]
interval_ms = 45_000

[POST rebuild dry_run] 200
{"ok":true,"target":"fts","dry_run":true,"before":{"fts_missing":1,"vec_missing":1,"degree_mismatch":0},"after":{"fts_missing":1,"vec_missing":1,"degree_mismatch":0},"elapsed_ms":0}

[POST rebuild fts] 200
{"ok":true,"target":"fts","dry_run":false,"before":{"fts_missing":1,"vec_missing":1,"degree_mismatch":0},"after":{"fts_missing":0,"vec_missing":1,"degree_mismatch":0},"elapsed_ms":1,"details":{"fts_added":1}}
```

## 单测覆盖（`tests/unit/config-api.test.ts`，13 例）

1. GET 白名单子集，序列化无 `token`。
2. PUT 合法 patch → 写回 TOML、GET 立即可见、`applied` 精确。
3. 非法 cron → 400 `cron_invalid`，文件未创建/未变。
4. 白名单外键（`sidecar.base_url`）→ 400 `unknown_key`。
5. `interval_ms=500` → 400 `interval_invalid`。
6. 阈值 1.5 → 400 `value_invalid`（schema 兜底）。
7. `http.port` → `restart_required=true` 且只 applied 该项；随后改 `archive.min_facts` → false。
8. 保留既有 `[model] gat_mode` 与未涉及键（深合并）。
9. dry_run FTS 不修（before=after=1）。
10. 实跑 FTS 后缺失 1→0、`details.fts_added=1`。
11. 度数人为破坏 99 → 实跑 `degree_mismatch` 1→0 且库内 degree=1。
12. 非法 target → 400 `target_invalid`。
13. 向量 dry_run 可计数；实跑 vec 无 sidecar → 503 `sidecar_unavailable`。

## 需要 Lead 的接线（server.ts 两行）

```ts
import { configRoutes } from './routes/config.js';
// 在其它 /api 路由注册处：
await app.register(configRoutes, {
  prefix: '/api',
  db: deps.db,
  cfg: deps.cfg,
  sidecar: deps.sidecar,
});
```

> prefix 是 `/api`（路由内部为 `/config`、`/maintenance/rebuild`）；`configPath`/`roots`
> 缺省即可（`defaultConfigPath()`、`dataPaths(cfg).root`）。`sidecar` 不传时 vec 维护实跑返回 503。

## 遗留

1. **非启动期键也不会立即生效**：PUT 只写回 TOML，daemon 内存里的 `cfg` 与已启动的 scheduler/runner
   仍用启动时快照。卡里只要求启动期键返回 `restart_required`，但 cron/interval 实际同样需要重启
   （或后续让 scheduler 动态重读配置）。前端目前只对启动期键显示黄条，建议后续任务统一提示或做热加载。
2. **契约偏离**：任务卡写 `ingest.llm_scan`，实际配置字段是 `collect.llm_scan`，按真实结构暴露。
3. `interval_ms` 卡要求 ≥1000，因此 0（禁用定时器语义）不能通过设置页写入；既有配置文件仍可写 0。
4. GET 每次请求重新读配置文件（用于 PUT 后立刻可见）；配置文件很大时才有成本，目前可忽略。
5. `src/ui` 不在 eslint 覆盖范围（既有配置），仅由 `tsc -p src/ui/tsconfig.json` 校验。
6. 工作树另有他人 WIP（`batch.ts`/`queues.ts`/`inboxRepo.ts`），本任务未触碰。
