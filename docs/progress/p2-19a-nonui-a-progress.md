# P2-19-A 非 UI 缺口包 A（task-13）

- 任务：P2-19A-01 归档只读路由 / -02 facts 筛选参数 / -03 schema infer CLI / -04 export --slug；追加第 5 项 `POST /api/archive/export`
- 状态：DONE（2026-11-04）
- 依据：台账 §4 P2-19-A（L998-1009）、详设 §4.3 / §4.8 / §8.3 / §9.1–§9.4、概设 §8.1

## 开工核查

- 本包 4 项 + Lead 追加项 5 均属「文档写了 / 详设列了、任务表没排、代码没有」；证据见 `docs/progress/p2-19a-reconciliation.md` 第 E/F 组。
- 只改 writeScopes 内文件；`src/app/http/server.ts`（路由注册）、`src/app/cli/index.ts`（命令注册）、`src/app/main.ts`、台账、`src/ui/**`、`tools/**`、`package.json` 一律未动。
- 并行任务在改 `src/app/cli/commands/{db,init}.ts`、`src/infra/sqlite/migrate.ts`、`tests/unit/{db-cli,init-cli}.test.ts`（非本卡范围），未触碰。

## 实现

### 项 1：`GET /api/archive/topics/:slug`（归档页只读正文）

- `src/core/archive/writer.ts`：新增 `readArchiveMarkdown(archiveDir, relativePath)`。路径来自 DB（不可信），先 `path.resolve(archiveDir)` 做 containment，越界返回 `null`，缺文件返回 `null`。
- `src/app/http/routes/archive.ts`：新增 `GET /topics/:slug`。命中返回台账字段 + `markdown`（文件缺失时 `markdown:null, missing:true`，页面可降级）；slug 不存在 → 404 `E_NOT_FOUND` / `reason:'archive_slug_not_found'`。列表接口原本已含 `status/path/last_exported_at`，无需改。
- 路由注册：`/api/archive` prefix 已在 `server.ts:90` 注册，本卡无新注册动作。

### 项 2：facts 列表筛选参数 `canonical_key / strength_min / strength_max / pool`

- `src/infra/sqlite/factRepo.ts`：`SearchOptions` 新增 `canonicalKey? / strengthMin? / strengthMax? / pool?`；`buildWhere` 分别拼 `canonical_key = ?`、`strength >= ?`、`strength <= ?`、`pool = ?`。
- `src/app/http/routes/facts.ts`：`parseStrength`（正则 `/^(0(\.\d+)?|1(\.0+)?)$/`，越界/科学计数/数组 → 400 `strength_min_invalid` / `strength_max_invalid`）、`parsePool`（枚举外 → 400 `pool_invalid`）；`strength_min > strength_max` → 400 `strength_range_invalid`；`pool` 与 `status` 同时给时 AND。
- 只增参数，既有响应形状与 `next_cursor/total` 不变。

### 项 3：`moshi schema infer` CLI + 待晋升清单

- `src/app/cli/commands/schema.ts`：`SUBCOMMANDS=['infer','validate','diff']` + `runInfer`。复用 `runSchemaInfer(db,{now,dryRun})`（不复制推断逻辑），输出单行 JSON：
  `{command:'schema infer', generated_at, dry_run, predicates, attr_keys, promoted:[...], candidates:[{predicate,keys,single_ratio,value_occurrences}], pending:[{kind,name,cardinality,sample_count}], summary:{updated,planned,kept,promoted,observed}}`
  其中 `promoted` 取 `action==='promote'`，`candidates` 取 `action==='observe'`，`pending` 取 `listOntologyKeys(db).filter(!promoted)`（概设 §2.6 的「待晋升清单」）。
  `--dry-run` 只判定不写库（`summary.updated=0`，`planned` 给出本会写回的条数）；`--write` 为默认行为的显式写法。
- 无需库 → exit 1；未知参数 → exit 2；成功 exit 0。

### 项 4：`moshi export --slug / --all`

- `src/core/archive/index.ts`：新增共享写盘入口 `exportArchive(db,{archiveDir,roots,slug?,now?})`（CLI + HTTP 共用；`archiveTopic`/`archiveAll`/`writeArchiveLedger` 的既有语义全部复用）。slug 不存在或 topic_id 非数字返回 `null`。返回 `{exported,written,unchanged,proposed,dir,elapsedMs,ledgerDifferences,ledgerPath}`。
- `src/app/cli/commands/export.ts`：解析 `--out / --slug / --all`；`--all` 与 `--slug` 互斥（exit 2）；缺值 exit 2；slug 不存在 exit 1。首行契约保持不变：`导出 N 篇（写盘 W、未变 U）→ dir，Xms`。

### 项 5：`POST /api/archive/export`

- `src/app/http/routes/archive.ts`：body 可选 `{slug?, all?}`。校验：非对象 → 400 `export_body_invalid`；slug 非非空字符串 → 400 `slug_invalid`；all 非布尔 → 400 `all_invalid`；`slug` 与 `all` 同时给 → 400 `export_target_conflict`；slug 不存在 → 404 `archive_slug_not_found`。
- 同步执行，返回 `{exported,written,unchanged,proposed,dir,elapsed_ms}`（与 CLI 打印口径一致），不引入 job 队列。
- 写边界不变：只写归档目录（`writer` 白名单兜底），不读 MD 回灌、不写 content 全文。

## 验收

```
> pnpm typecheck
（无输出 = 通过）

> pnpm lint:lifecycle
✔ 生命周期写路径检查通过（103 个文件）

> pnpm lint:writes
lint:writes OK — 103 个文件，无白名单外写调用

> pnpm vitest run tests/unit/archive-route.test.ts tests/unit/export.test.ts \
    tests/unit/facts-filters.test.ts tests/unit/schema-infer-cli.test.ts
 ✓ tests/unit/archive-route.test.ts (9 tests) 370ms
 ✓ tests/unit/export.test.ts (7 tests) 298ms
 ✓ tests/unit/facts-filters.test.ts (4 tests) 208ms
 ✓ tests/unit/schema-infer-cli.test.ts (4 tests) 157ms
 Test Files  4 passed (4)   Tests  24 passed (24)

> pnpm vitest run archive export        # 回归相邻归档/导出测试
 ✓ tests/unit/archive-route.test.ts (9)  ✓ tests/unit/export.test.ts (7)
 ✓ tests/unit/archive-guard.test.ts (12) ✓ tests/unit/archive-topic.test.ts (4)
 ✓ tests/unit/archive.test.ts (4)        ✓ tests/unit/check-archive.test.ts (5)
 Test Files  6 passed (6)   Tests  41 passed (41)
```

## 决策

- D-P2-19A-A-1：`exportArchive` 在 `exported === 0` 时**不写台账、不建归档目录**——保持 P2-15 既有测试「没有达标主题不建目录」的契约；有主题才写。
- D-P2-19A-A-2：`readArchiveMarkdown` 的 containment 放在 `core/archive/writer.ts`（而非路由层），任何读归档正文的入口都受保护。
- D-P2-19A-A-3：`pool` 按**库表真实列**实现（`POOL = ['utility','value_floor']`，见 `src/domain/enums.ts:25`），与概设 §8.1 L947 的六维筛选 `pool` 一致。任务卡写「pool（active|disputed|archived|invalidated|pruned，映射 epistemic_status）」与 schema 不符——那是 `EPISTEMIC`（`enums.ts:22`），已由既有 `status` 参数承担；`pool` 与 `status` 同时给时 AND。
- D-P2-19A-A-5：`runSchemaInfer` 增加可选 `dryRun`（默认 false，向后兼容），仅跳过 ontology 写回；CLI `schema infer --dry-run` 用它做预览，判定结果与写回逻辑不复制。
- D-P2-19A-A-4：schema infer 只读输出 JSON，不额外写 DB（写回由既有 `runSchemaInfer` 内部完成），避免 CLI 二次落盘。

## 遗留

- I-1：`GET /api/archive/topics` 仍无分页（`listArchiveMeta` 默认 limit 200）——概设 §8.9 归档列表性能预算未验证，归 P2-19-B/后续性能卡。
- I-2：台账 `archive_meta.path` 若为空（老数据），只读接口按文件缺失降级；未做路径回填迁移。
