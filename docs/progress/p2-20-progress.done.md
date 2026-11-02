# P2-20 采集协议 v1 实施记录

## 目标
- `src/core/collect/protocol.ts`：块定位 → JSON 解析 → 字段校验 → 引用解析
- `moshi://protocol/ann-v1` resource
- `memory_query` 结果末尾一行提示
- `annotation.origin` 列

## 验收
- 3 份回放样本（正常块 / 无块 / 畸形块）
- `v:99` 未知版本
- 畸形块进 `quarantine` 且计 `ann_malformed`
- 未知版本整块跳过且计 `ann_version_unknown`
- `pnpm verify` 全绿

## 思路
1. 新增迁移 `003_protocol.sql`：给 `annotation` 加 `origin TEXT` 列（允许 NULL，默认 NULL）。
2. `protocol.ts`：
   - `findMoshiBlocks(text)`：只认 ` ```moshi ` 围栏（行首反引号+moshi），到 ` ``` ` 结束，允许跨行。
   - `parseAnnV1Block(rawText)`：去掉围栏行，JSON 解析，校验顶层 `v`、`facts[]`、`edges[]`。
   - 未知 `v` 抛 `AnnVersionUnknownError`（带原始文本，后续进 quarantine 并计数）。
   - 畸形 JSON/字段缺失 抛 `AnnMalformedError`。
   - `resolveEdgeRef(ref, knownFacts)`：`f:<id>` 或 `k:<canonical_key>`，解析不到返回 `pending`。
3. 在 `app/mcp/server.ts` 注册 resource `moshi://protocol/ann-v1`，返回机读版规范。
4. `app/mcp/query.ts`：在 `EvidencePackJson` 末尾加 `protocol_hint` 字段（或拼进 `advice`？详设说"结果末尾一行提示"）。为不破坏 schema，新增 `protocol_hint: string` 字段，由 `runMemoryQuery` 固定返回一句。
5. 测试：`tests/unit/protocol.test.ts` 覆盖 3 样本 + v99。

## 当前状态
DONE（2026-11-02 00:39）

## 完成摘要
- 迁移 003_protocol.sql + TARGET_VERSION=3 + lifecycle/migrate 测试更新
- protocol.ts 块定位/解析/校验/引用解析，错误分级
- mcp server resource + query protocol_hint + annotate/ingest origin
- tests/unit/protocol.test.ts 16 例 + mcp.test.ts 补充
- `pnpm verify` 50 files / 593 tests 全绿
- commit `49bef49`
