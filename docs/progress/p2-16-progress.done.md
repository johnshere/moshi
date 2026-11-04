# P2-16 归档分裂合并与台账 — 进度

状态：实现 + 自测完成，待 Lead `pnpm verify` / `pnpm build` / commit（生产接线不需要：合并/分裂暂为 core API，CLI/HTTP 端点留给后续任务）
任务：task-7（owner: archive）
开工：2026-11-04

## 目标 / 契约（详设 §9.5 L2843-2850、§9.6 L2852-2862）

- 合并：slug 取存活时间更长的一方 = `archive_meta.last_exported_at` 更早者；另一方写「已并入 X」跳转文档、`status='merged'`；**不物理删除文件**、不删 `archive_meta` 行。
- 分裂：新主题新 slug；原文档 `status='split'`、正文顶部加「已拆分为 A / B」；原文件保留。
- 台账 `.moshi-archive.json`：`{"schema":"moshi-archive-ledger/1","generated_at":...,"topics":[{topic_id,slug,path,revision,content_hash,status}]}`，与 DB `archive_meta` 互为校验；不一致以 DB 为准并重建。
- 红线（§9.7）：不读 MD 回灌图、不写整段原文、不物理删除归档文件、不覆盖人工修改。

## 决策

- D1：合并「存活」按 `last_exported_at` 升序（更早者存活）；`NULL` 视为从未导出、排在最后不参与竞争；同刻按 topic_id 数字升序。存活行用 `reassignArchiveTopic` 把 topic_id 迁到新社区 id，slug/path/revision/content_hash 原样保留（slug 不变，只换归属）。
- D2：跳转文档只写 frontmatter（`status: merged`、`merged_into: <存活 slug>`）+ 一句「本主题已合并到…归档见 <path>」，不复制任何正文（满足「不写整段原文」）；用 `bodyHashOfDocument` 把跳转文档 hash 记为 `content_hash` 基线，避免下次导出误判人工改动。
- D3：合并/分裂都不删文件、不删 meta 行；只改 `status`。
- D4：`status !== 'active'` 的主题在 `archiveTopic` 里直接 skip（在 slug 计算后、guard 之前），防止后续自动导出把「已并入/已拆分」标记覆盖掉。
- D5：分裂用「幂等标注」：旧文件正文已含 `> **已拆分为` 就不再重写（`annotated=false`），只刷新 meta 的 `status/content_hash`。banner 插在 frontmatter 之后、正文最顶部。
- D6：新主题若已有 `archive_meta` 复用 slug/path；否则 `slugFor(title ?? 'topic-<id>')` 建占位行（`content_hash/last_exported_at=NULL`、`dirty=1`），等该社区真正导出时填充。
- D7：台账以 DB 为唯一权威全量重建：先读旧台账算差异（`missing_in_ledger` / `extra_in_ledger` / `field_mismatch`），再写 JSON；返回 `differences` 供 CLI/doctor 提示「以 DB 为准，已重建」。CLI `export` 在 `docs>0` 时生成台账（保住 0 主题不建目录的旧测试）。
- D8：合并/分裂本身不写台账（无 archiveDir 写入职责面扩张）；下一次 `export` 会重建，测试验证的就是这条路径。

## 改动文件

- 新增 `src/core/archive/topic.ts`：`mergeTopics`、`splitTopics`、`buildArchiveLedger`、`readArchiveLedger`、`diffArchiveLedger`、`writeArchiveLedger`、`archiveLedgerPath`、`ARCHIVE_LEDGER_SCHEMA`、`ARCHIVE_LEDGER_FILE`；内部 `redirectDocument`、`insertAfterFrontmatter`、`exportedRank`、`topicIdOrder`。
- `src/core/archive/index.ts`：`prev.status !== 'active'` → skip 守卫。
- `src/infra/sqlite/archiveRepo.ts`：追加 `reassignArchiveTopic(db,from,to)`、`createArchiveMetaPlaceholder(db,{topicId,slug,title,path?})`（未改旧函数）。
- `src/app/cli/commands/export.ts`：导出后 `writeArchiveLedger(db,{archiveDir,roots})`；不一致时打印 `台账与 DB 有 N 处差异（以 DB 为准，已重建）→ path`。
- 新增 `tests/unit/archive-topic.test.ts`（4 tests）。

## 验收记录

合并场景（临时目录真实落盘；`temp/p2-16-demo.ts` 跑完已删除）：

```
导出: ...\archive\topics\开发环境\开发环境.md | ...\archive\topics\网络配置\网络配置.md
survivor: {"topicId":"5","slug":"开发环境","path":"topics/开发环境/开发环境.md"}
merged:   [{"topicId":"2","slug":"网络配置","path":"topics/网络配置/网络配置.md"}]

文件树:
  .moshi-archive.json
  topics/开发环境/开发环境.md
  topics/网络配置/网络配置.md

被合并文档（原 slug 保留）: ...\archive\topics\网络配置\网络配置.md
---
topic_id: 2
slug: 网络配置
title: 网络配置
status: merged
merged_into: 开发环境
---

# 已并入 开发环境

本主题已合并到「开发环境」，归档见 `topics/开发环境/开发环境.md`。本文件仅作跳转，不再更新。

台账: .moshi-archive.json | consistent = true
{ "schema": "moshi-archive-ledger/1", "generated_at": "2026-11-02T00:00:00.000Z",
  "topics": [
    { "topic_id": "2", "slug": "网络配置", "path": "topics/网络配置/网络配置.md", "revision": 1,
      "content_hash": "87944a62…", "status": "merged" },
    { "topic_id": "5", "slug": "开发环境", "path": "topics/开发环境/开发环境.md", "revision": 1,
      "content_hash": "49d71ccc…", "status": "active" } ] }
```

单测（断言而非人肉看）：

- 合并：旧 slug 文件仍存在、字节未变的是存活方（开发环境）；被合并方文件改为跳转且不含原正文事实；`archive_meta` '2' status=merged、'5' slug 继承、'1' 行消失；第三方主题文件与状态不动。
- 分裂：原文件保留、`status=split`、banner 在 `## 一句话结论` 之前；新主题 slug/path 正确、meta 为占位；二次分裂幂等（`annotated=false`、字节不变）；split 后 `archiveTopic` 返回 skip、文件字节不变。
- 台账：schema/generated_at 正确、topics 与 `listArchiveMeta` 逐字段一致、`diffArchiveLedger` 为空；手改台账 revision 后检出 `field_mismatch`，重建后归零且 `consistent=false`。

命令与输出：

- `pnpm typecheck` → 通过（无输出）。
- `pnpm vitest run tests/unit/archive-topic.test.ts tests/unit/archive-guard.test.ts tests/unit/archive.test.ts tests/unit/export.test.ts` → `Test Files 4 passed | Tests 23 passed`（4+12+4+3）。
- `pnpm lint:deps` ✔（141 模块/601 依赖/5 规则）；`pnpm lint:lifecycle` ✔（94 文件）；`pnpm lint:writes` ✔（94 文件）。
- `pnpm exec eslint src/core/archive src/infra/sqlite/archiveRepo.ts src/app/cli/commands/export.ts tests/unit/archive-topic.test.ts tests/unit/archive-guard.test.ts --ext .ts` → 无输出。
- 红线核查：`topic.ts` 内无 `unlink/rmSync/removeFile/safeRemove`（grep 无匹配）。

## 待 Lead 处理 / 遗留

- **提交顺序事故**：Lead 在 21:52:10 的 `8195212 feat(archive): 归档增量与人工编辑保护（P2-15）` 把本任务已落盘的 `index.ts`/`archiveRepo.ts`/`export.ts` 修改一起提交了，但当时 `src/core/archive/topic.ts` 还未跟踪 → 该 commit 单独 checkout 会因 import 缺失而 typecheck 失败。P2-16 的 `topic.ts` + `tests/unit/archive-topic.test.ts` 仍是未跟踪文件，请随后续 commit 补上。
- 合并/分裂目前只有 core API，未接 CLI/HTTP（任务卡未要求；建议 P2-16 后续或 P2-17 加 `moshi archive merge|split` 与 `/api/archive/...`）。
- doctor 消费 `diffArchiveLedger` 的接线未做（doctor 属他人任务）。
- `tools/check-archive.ts` 静态扫描（详设 §9.7）仍未实现，不在本任务 scope。
- 合并后旧社区若仍被 `selectTopics` 选中会以新 slug 再次建文档（测试不覆盖，真实流程中社区已合并消失）。
