# ADR 0001：Fact 语义分层——扩 `ftype`，不新增 `memory_kind`

- 状态：已采纳（2026-11-08）
- 决策记录：D-168
- 相关：V-05、迁移 `006_fact_semantics.sql`

## 背景

原 `fact.ftype` 只有 `semantic / episodic / conditional` 三值。讨论中曾提出新增
`memory_kind`，把记忆分为语义 / 情景 / 程序 / 偏好等种类。逐值比对后发现：

- `memory_kind` 的 `semantic` / `episodic` 与 `ftype` 完全重合；
- `memory_kind` 的 `procedural` 与 `ftype` 的 `conditional` 不在同一根轴上——
  「程序性」描述的是**记忆内容的形式**，「条件性」描述的是**适用条件**，两者可以同时成立；
- 两列并存会产生双权威：新增一种记忆要么改两处，要么两处渐渐不一致。

真正缺的不是「再加一个种类字段」，而是让既有 `ftype` 更丰富，并补齐与它**正交**的
生命周期属性。

## 决策

1. `ftype` 保持为唯一的记忆种类字段，扩为
   `semantic | episodic | procedural | conditional`。
2. **不新增** `memory_kind`。
3. 新增七个正交字段，按各自语义独立取值：
   - `retention_class`：`durable | event | cache | session`
   - `volatility`：`static | slow | volatile | historical`
   - `admission_reason`：`non_rederivable | expensive | context_needed | human_intent | cross_object`
   - `ttl_seconds`
   - `source_kind`：`observation | user_statement | decision | reflection | document | derived | agent_inference`
   - `recheck_kind`：`none | command | manual | on_read`
   - `expired_at`
4. `ftype` 的 `CHECK` 不能原地扩值，迁移 006 重建 `fact` 表；迁移仍只增不改，
   空库与带数据的库都必须能跑。
5. 采集闸门：`tool_parse` 通道的 `durable` 事实若没有 `admission_reason`，
   降级为 `cache` 且 `recheck_kind = on_read`（`admissionGate`）。
6. 检索默认排除 `retention_class = 'cache'` 的事实；`include_cache` 显式放行。
7. 删除 `fs.ls`：目录清单可现场重查，逐目录项落 `exists` 是垃圾数据。

依据：CoALA（语义 / 情景 / 程序记忆）、LangMem（记忆类型）、Zep/Graphiti（双时间）、
Letta/MemGPT（工作区与归档）、Generative Agents（反思）、MemOS（TTL 与 provenance）。

## 后果

- 旧行不回填：`retention_class / volatility / admission_reason / expired_at` 为 `NULL`
  （未分类），`source_kind` / `recheck_kind` 取 DDL 默认值。测试库整库重建，旧分类随库消失。
- 查询侧多一个默认过滤条件；时序题依赖的 `event` 类仍默认返回。
- parser、harvest、MCP schema、UI 枚举与测试需同步；新增枚举值只改一处权威
  （`src/domain/enums.ts`）。

## 被否决的方案

- **新增 `memory_kind`**：双权威，且 `procedural` 与 `conditional` 不同轴。
- **把 `preference / decision / cache` 塞进 `ftype`**：混合了种类、来源与生命周期，
  继续制造正交字段；它们应分别落在 `source_kind`、`retention_class`。
- **旧数据回填**：只影响测试库，重建成本低于维护回填脚本，且回填会把垃圾数据固化。
