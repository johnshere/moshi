# V-05 Fact 语义分层与测试库覆盖重建 · 进度

- 状态：DONE.m2（2026-11-08）
- 决策：D-168；ADR `docs/adr/0001-fact-semantics.md`
- 机器：m2（JOHN，Windows 11 build 26200）

## 执行顺序与结果

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 迁移 006：ftype 扩四值 + 七字段，重建 fact 表 | `migrations/006_fact_semantics.sql`；`user_version=6`；v5 带数据库升级旧行保留、新列默认 |
| 2 | 领域类型 / 仓储 / mapper | `enums.ts`、`types.ts`、`mappers.ts`、`factRepo.ts` |
| 3 | parser 分类 + 删除 `fs.ls` | pkg/git/proc/build/fs 全部带 retention/volatility/admission/source/recheck；`fs.ls` 整段删除 |
| 4 | harvest 采集闸门 | `admissionGate`：tool_parse 的 durable 无 admission → cache + on_read |
| 5 | 读取过滤 | `search.includeCache` 默认 false；cache 事实默认不进包 |
| 6 | MCP schema / annotate / directWrite | 七字段可入参、可透传、可读回 |
| 7 | seed 覆盖数据 | `coverageFacts()` 10 条，走 `memory_annotate` → `harvest` 生产通路 |
| 8 | 测试库整库重建 | `temp/real-claude`（真实三源）+ `temp/m2-p3a4`（合成种子） |
| 9 | 文档 | 详设 §2.7/§3.3/§5.3/§6.1 + ADR |

## 验收读数

### 构建 / 测试

- `pnpm verify`：131 files / 1584 tests 全绿（含 typecheck:ui、lint:deps/lifecycle/writes/archive）
- `pnpm build`：exit 0（ui 114 modules + tsc + copy-assets）
- 新增单测：
  - `tests/unit/fact-semantics.test.ts`（5）：v5→v6 数据保留、索引/触发器/视图重建、四值 + 七字段读写、CHECK 拒绝非法值、`ls -l` 零事实
  - `tests/unit/harvest.test.ts`（+3）：`admissionGate` 降级 / 保留 / 非 tool_parse 不受影响
  - `tests/unit/search.test.ts`（+1）：cache 默认不返回、`includeCache` 返回

### 测试库 `temp/real-claude`（整库重建）

- 源：`claude-real` + `claude-subagents` + `dsh-real`（77 会话）
- 导入：34476 回合 / 24 新事实 / 0 隔离 / 4566 未识别 / 17.0s
- 派生：consolidate 40 procedure；community 71 节点 / 58 社区；schema infer 44 谓语
- 覆盖：annotate 10 条 + harvest（created 10, failed 0）
- 总量：fact=401、edge=2341、episode=34476、`user_version=6`
- 枚举桶（全非空）：
  - ftype：conditional 2 / episodic 332 / procedural 41 / semantic 26
  - retention：cache 157 / durable 66 / event 177 / session 1
  - volatility：historical 176 / slow 17 / static 49 / volatile 159
  - admission：null 158 / context_needed 62 / cross_object 1 / expensive 177 / human_intent 1 / non_rederivable 2
  - source_kind：7 值全出现；recheck_kind：4 值全出现
- 闸门：`durable` 且 admission 为空 = 0
- 垃圾数据：`ext.parser='fs.ls'` = 0
- 查询：cache 覆盖事实默认 `memory_query` 不返回，`include_cache=true` 返回
- 旧库快照：`temp/real-claude/snapshot-v5/moshi.db`

### 测试库 `temp/m2-p3a4`（合成种子）

- seed exit 0：75 会话 / 1396 回合 / fact=567 / 10 条覆盖事实
- eval 32/32（四类各 8），doctor I1–I10 全绿、exit 4（仅向量路降级）
- `fs.ls` = 0；cache 默认过滤与 `include_cache` 行为同上

## DoD

1. 代码落盘 ✅（迁移、领域、仓储、parser、harvest、读取、MCP、seed、UI 枚举）
2. build 过 ✅（TEMP 重定向工程内 `./temp`）
3. 验收输出抄 §6 ✅（`进度日志-2026-11.md` V-05 DONE.m2 行）
4. 关键分支单测 ✅（迁移、字段读写、CHECK、admissionGate、cache 过滤、fs.ls 零产出）
5. 无未记录 TODO/FIXME ✅
6. §1/§3/§6 已更新 ✅（另更新 §9.2、§9.3/m2、§5.3 I-59）
7. 生产接线点存在 ✅（`parseTurn → harvest → upsertFact`；`memory_query → searchWithPipeline`；`memory_annotate → schemas → directWrite/queue`）
8. 机器相关证据 ✅（§9.3/m2 V-05 行，状态 `DONE.m2`）

## 2026-11-08 补跑：四个测试库全部刷新

| 库 | 版本 | fact | 覆盖事实 | fs.ls 事实 |
| --- | --- | --- | --- | --- |
| `temp/real-claude` | 6 | 402 | 10 | 0 |
| `temp/m2-p3a4` | 6 | 567 | 10 | 0 |
| `temp/moshi-dev` | 6 | 121 | 10 | 0 |
| `temp/moshi-p3` | 6 | 858 | 10 | 0 |

- 四库 `source_kind` 七值、`recheck_kind` 四值、`ftype` 四值、`retention` 四值、`volatility` 四值、`admission` 五值全部出现（`moshi-dev` 的 60 条来自 `~/.moshi` 快照，按 D-168 不回填，分层字段为 NULL）。
- 四库 cache 覆盖事实默认 `memory_query` 不返回，`include_cache=true` 返回；`durable` 无 admission = 0。
- `temp/moshi-dev` 由 `pnpm dev:reset` 重建；DB 已到 v6，但脚本在 golden 对齐阶段失败：真实 `depends_on` 边为 0（`fs.ls` 删除后真实会话的每回合事实密度下降），无法凑 10 条多跳题，记 I-60。
