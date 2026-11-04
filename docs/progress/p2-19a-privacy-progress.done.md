# P2-19A-12 隐私 purge / 总览 / 全库流式导出 — 进度

- 任务：task-19（P2-19A-12）
- 状态：DONE（自测完成；`pnpm build`/`pnpm verify` 由 Lead 统一跑）
- 日期：2026-11-04

## 改动文件

| 文件 | 说明 |
| --- | --- |
| `src/app/http/routes/privacy.ts`（新） | `privacyRoutes`（GET /overview、POST /purge）与 `exportRoutes`（GET /all）；参数校验、错误映射、流式导出 |
| `src/core/ops/purge.ts`（新） | scope 编排：dry_run 统计、审计先行、单事务删除、归档白名单文件删除、体积统计、隐私总览组装 |
| `src/infra/sqlite/auditRepo.ts`（只增） | 隐私数据访问段：计数/删除/审计/last_purge_at/导出分页读/user_version/WAL checkpoint |
| `src/infra/fs/safeRemove.ts`（新） | 归档白名单判定、文件枚举、安全删除（只删普通文件、拒绝 symlink、绝不删目录） |
| `tests/unit/privacy-purge.test.ts`（新） | 7 例：confirm、dry_run 零写入、all/archive/facts/sessions、overview |
| `tests/unit/privacy-export.test.ts`（新） | 4 例：附件头/结构、全状态、include=archive、空库、>500 条分页 |

未改：`server.ts`、`cli/index.ts`、`main.ts`、`docs/任务台账.md`、`src/ui/**`、`package.json`、`migrations/**`。

## 契约落地

### POST /api/privacy/purge

- `confirm !== 'PURGE'` → 400 `E_INPUT`，`detail.reason='confirm_required'`。
- `scope ∈ {all,facts,sessions,archive}`（缺省 `all`），非法值 → 400 `E_INPUT` `reason='invalid_scope'`。
- `dry_run:true` → `{ok:true,dry_run:true,would_delete:{facts,edges,entities,annotations,sessions,archive_files}}`，**零写入**（不写 audit、不删文件）。
- 实跑：`withTransaction` 内**先 appendPrivacyPurgeAudit 再删**；audit 写失败即事务失败、一行不删。
- 删除范围：
  - `all`：evidence_log/feedback/layout → fact_fts/fact_vec → edge → fact（先断开 superseded_by）→ community_summary/adjudication/training_sample → annotation/quarantine/episode/session/query_log → alias/entity（先断开 merged_into）→ archive_meta；并删归档白名单文件。
  - `facts`：仅事实链（evidence_log/feedback/layout/fts/vec/edge/fact + community_summary），保留实体/会话/注解。
  - `sessions`：annotation/quarantine/episode/session；先 `UPDATE fact SET source_episode=NULL` 满足 FK，事实保留。
  - `archive`：只删 archive_meta + 归档白名单文件，事实不动。
- 保留：`meta` / `ontology` / `audit`。
- 响应：`{ok,scope,deleted:{...},archive_files_removed,size_before_mb,size_after_mb,elapsed_ms}`。
- 归档白名单：`archive_dir/topics/**/*.md`、`archive_dir/_history/**`（普通文件）；符号链接、目录、白名单外路径一律拒绝；目录本身保留。

### GET /api/privacy/overview

`schema='moshi-privacy/1'`；`db{path,size_mb,wal_mb}`；`counts{facts,edges,entities,annotations,sessions,archive_topics,facts_pruned,facts_invalidated}`；`archive{dir,topics,bytes}`；`retention{prune_idle_days:60,half_life_days:cfg.lifecycle.half_life_days}`；`last_purge_at`（读 audit `tbl='privacy' AND field='privacy.purge'`，无则 null）。

### GET /api/export/all

- `content-type: application/json; charset=utf-8`，`content-disposition: attachment; filename="moshi-export-YYYY-MM-DD.json"`。
- 结构 `{schema:"moshi-export/1",exported_at,facts,edges,entities,annotations,meta{schema_rev,user_version}}`。
- facts 走 `factRepo.listFactsPage`（rowid keyset，**全 epistemic 状态**，无 status 过滤）；edges/entities/annotations 在 auditRepo 新增分页读；每批 500，`Readable.from` 逐块写出。
- `?include=archive` 只附 `archive_topics` 台账元数据（slug/title/revision/last_exported_at/dirty/human_edited/status），不含正文。

## 实现决策与理由

1. **SQL 暂放 auditRepo.ts**：core/app 被 `lint:lifecycle` 禁止出现 `db.prepare/exec/transaction`，本卡 write scope 只放开 `auditRepo.ts` 一个 infra 文件；隐私相关批量读/删 SQL 集中在该文件「隐私段」，后续拆 `privacyRepo.ts`。
2. **审计先行在事务内**：`appendPrivacyPurgeAudit` 与删除同一 `withTransaction`，保证「audit 失败即中止」；dry_run 不写 audit，因此 `last_purge_at` 只反映真实 purge。
3. **删除顺序按 FK**：evidence_log/feedback/layout → fact；episode 在 fact 之后（all）；sessions scope 需先断开 `fact.source_episode`；alias 先于 entity、`entity.merged_into` 先置空。
4. **比契约多清派生表**：`community_summary`/`adjudication`/`training_sample`（all）与 `query_log`（all）也会清——它们派生自事实/查询内容，留着等于泄漏；响应 counts 仍只报契约五键，不多报。
5. **归档删除独立于 DB 事务**：文件系统不可回滚；先枚举→audit→DB 事务→逐文件删，删除只 unlink 普通文件。
6. **体积口径**：`db.name` + `-wal` stat；purge 后 `wal_checkpoint(TRUNCATE)` 尝试截断 WAL；未做 VACUUM，`size_after_mb` 可能不立即下降（页复用），不虚报。
7. **retention**：全仓无 retention 配置键，`prune_idle_days=60` 按契约常量；`half_life_days` 取现有 `cfg.lifecycle.half_life_days`（默认 14）。

## 验收命令与输出

```
pnpm typecheck
> tsc -p tsconfig.json --noEmit          # 无输出，通过

pnpm vitest run tests/unit/privacy-purge.test.ts tests/unit/privacy-export.test.ts
 ✓ tests/unit/privacy-purge.test.ts (7 tests) 427ms
 ✓ tests/unit/privacy-export.test.ts (4 tests) 554ms
 Test Files  2 passed (2)
      Tests  11 passed (11)

pnpm lint:lifecycle
✔ 生命周期写路径检查通过（111 个文件）
pnpm lint:deps
✔ 依赖方向检查通过（160 个模块，728 条内部依赖，5 条规则）
pnpm lint:writes
lint:writes OK — 111 个文件，无白名单外写调用
```

真实 inject 探针（`.dsh/temp/p2-19a/privacy-probe.ts`，seed 40 facts / 20 edges + 3 个归档文件 + 1 个白名单外文件）：

```
[overview] {"schema":"moshi-privacy/1","db":{...size_mb:0.41,wal_mb:0},"counts":{"facts":40,"edges":20,...},"archive":{"topics":0,"bytes":47},"retention":{"prune_idle_days":60,"half_life_days":14},"last_purge_at":null}
[dry_run] {"ok":true,"dry_run":true,"would_delete":{"facts":40,"edges":20,"entities":0,"annotations":0,"sessions":0,"archive_files":3}}
[counts before dry_run] {"facts":40,"edges":20,"entities":0,"annotations":0,"sessions":0,"ontology":0,"audit":0}
[counts after  dry_run] {"facts":40,"edges":20,"entities":0,"annotations":0,"sessions":0,"ontology":0,"audit":0}
[purge] {"ok":true,"scope":"all","deleted":{"facts":40,"edges":20,"entities":0,"annotations":0,"sessions":0},"archive_files_removed":3,"size_before_mb":0.41,"size_after_mb":0.41,"elapsed_ms":7}
[counts after purge] {"facts":0,"edges":0,"entities":0,"annotations":0,"sessions":0,"ontology":0,"audit":1}
[archive] {"topics_a":false,"topics_b":false,"history":false,"outside":true,"topics_dir":true}
[audit] {"ts":"2026-11-04T14:46:30.796Z","tbl":"privacy","field":"privacy.purge","reason":"all"}
```

## Lead 接线（server.ts）

```ts
import { privacyRoutes, exportRoutes } from './routes/privacy.js';

// 建议放在 diagRoutes / archiveRoutes 附近（/api 前缀插件之后）
await app.register(privacyRoutes, { prefix: '/api/privacy', db: deps.db, cfg: deps.cfg });
await app.register(exportRoutes, { prefix: '/api/export', db: deps.db });
```

> 两个插件在同一文件导出：`privacyRoutes` 暴露 `/overview`、`/purge`；`exportRoutes` 暴露 `/all`（即最终 `/api/export/all`）。

## 遗留

- `auditRepo.ts` 的隐私段是受 write scope 限制的临时归属，建议下一卡拆出 `src/infra/sqlite/privacyRepo.ts`（纯搬移，无行为变化）。
- 未做 VACUUM：purge 后磁盘文件不会立即缩小；如需回收空间可在 daemon 空闲时手动 `VACUUM`（不自动做，避免长时间锁库）。
- `?include=archive` 的 `archive_topics` 使用 DB 原始 snake_case 字段（与归档台账接口一致），未做 camelCase 转换。
- 无 TODO/FIXME。
