# Agent 记忆系统调研：范围、隔离与时间模型

> 调研日期：2026-11-08  
> 状态：调研记录，暂不排期。当前优先级是确认 moshi 基本可用；本文只作为后续 V-01（scope）与 V-02（scope UI）的设计输入。  
> 方法：公开文档、论文与项目 README 的案头调研；未做代码级集成验证，未做基准复测。

## 0. 结论

1. **没有可以直接替换 moshi 的成熟方案。** 主流系统要么是独立运行时（Letta）、要么绑定特定框架/语言（LangMem、Graphiti、Cognee）、要么是通用记忆 API（Mem0）。moshi 的 SQLite 图、证据链、审计与训练样本是自定义的，直接引入外部系统会形成第二套事实源。
2. **值得直接借的是设计，不是运行时。**
   - LangMem：层级命名空间（namespace tuple）；
   - Zep/Graphiti：双时间模型与 `group_id` 命名空间；
   - Cognee：dataset 级隔离与 RBAC 语义；
   - Letta：共享记忆块与私有归档的区分；
   - Mem0：显式多维实体范围（同时要避开它的过滤陷阱）；
   - MemOS：MemCube 的 ACL/TTL/provenance/版本元数据。
3. **对 moshi 的核心判断不变：单个 `scope` 字符串不够。** 应拆成四层：来源（provenance）、可见范围（namespace）、真值/记录时间（validity）、保留与策略（policy）。
4. **当前不建议落地。** 先确认系统可用性；若后续要做，先写 ADR，再动 schema。历史数据不要自动回填 scope。

## 1. 调研对象

| 系统 | 定位 | 范围/隔离机制 | 时间模型 | 备注 |
|---|---|---|---|---|
| **Mem0** | 通用记忆 API，向量 + 关键词 + 可选图 | `user_id` / `agent_id` / `app_id` / `run_id` 四维实体范围，查询用 filters | 记录时间、`expiration_date` 等过滤 | 每条记忆只有一个主实体；多实体 AND 查询会落空 |
| **Zep / Graphiti** | 双时间知识图谱 | `group_id` 图命名空间；查询按 group 过滤 | `valid_at/invalid_at`（事件时间）+ `created_at/expired_at`（记录时间） | `group_id` 是调用方过滤，不是授权；不传会搜索所有组 |
| **Letta / MemGPT** | 有状态 Agent 运行时 | 记忆块可挂多个 Agent（`block_ids`），可 `read_only`；archival memory 默认按 Agent 隔离 | 以对话/记忆块生命周期为主 | 共享块适合跨 Agent 协作；私有归档适合单 Agent 长期记忆 |
| **LangMem / LangGraph** | 框架级长期记忆 Store | 命名空间为字符串元组，支持模板变量，如 `("memories", "{org}", "{user}")` | Store 记录时间；无强双时间 | 读命名空间可高于写命名空间，适合团队/Agent 分层 |
| **Cognee** | 文档/知识图谱记忆 | **dataset 是隔离边界**；用户/角色/租户 RBAC；read / write / delete / share | 以数据集与文档生命周期为主 | 每个 dataset 独立图/向量；拒绝与“不存在”分开 |
| **MemOS** | 记忆操作系统（研究型） | MemCube 自带 ACL、TTL、provenance、版本链；组合视图 | 生命周期：create → activate → merge → archive → freeze → reclaim | 概念完整，组件重，偏研究/平台 |
| **A-MEM** | Zettelkasten 式笔记网络 | 无强隔离模型 | 笔记时间戳 + 演化 | 笔记链接/演化是亮点；缺版本与审计 |

## 2. 五个可复用的模式

### 2.1 命名空间：多维、层级、读写分离

LangMem 的 namespace 是元组，不是单个标签：

```text
("memories", "{org_id}", "{team_id}", "{user_id}", "{agent_id}")
```

常见用法：

- 写：`("memories", "team_a", "agent_a")`
- 读：`("memories", "team_a")`（读上层，覆盖团队共享）

对 moshi 的映射：

```text
global
host:<host_id>
project:<project_id>
agent:<agent_id>
session:<session_id>
```

查询时传 `context`，服务端解析可见集合；而不是让调用方传一个裸 `scope` 字符串。

### 2.2 可见集合不是 AND 过滤

Mem0 的实体范围有一个重要限制：每条记录只有一个主实体；`user_id` 与 `agent_id` 同时 AND 会查不到，只传一个还会隐式把其余维度限定为 null。

因此不要写成：

```sql
WHERE user_id = ? AND agent_id = ? AND project_id = ?
```

应写成“可见集合”：

```text
visible = global
        ∪ host:<current_host>
        ∪ project:<current_project>
        ∪ agent:<current_agent>       -- 仅 Agent 私有记忆
        ∪ session:<current_session>
```

并按“越具体越优先”处理同一身份的覆盖：

```text
session > project > agent > host > global
```

这与 moshi 当前 `src/core/read/search.ts` 的精确匹配（`fact.scope !== scope` 直接丢弃）不同；精确匹配既不继承，也无法组合。

### 2.3 双时间：真值时间与记录时间

Zep/Graphiti 的四时间戳值得照搬：

| 时间 | 含义 | moshi 现状 |
|---|---|---|
| `valid_at` | 事实在现实世界中开始为真 | 已有 |
| `invalid_at` / `valid_to` | 事实在现实世界中不再为真 | 已有 |
| `created_at` | 系统何时记录 | 已有 `recorded_at` / `created_at` |
| `expired_at` | 系统何时不再采用这条记录 | 没有显式列；目前靠失效/替代 |

另外还需要区分：

- **真值有效期**：`valid_at/valid_to`；
- **记录/采用期**：`recorded_at/expired_at`；
- **保留期**：`expires_at` / TTL（会话级、临时记忆）；
- **排序衰减**：`strength` 继续做排序，不承担“是否可见”。

“记忆有时效性”不应由 scope 表达，应由这组时间字段表达。

### 2.4 共享与私有分开

Letta 的模型：

- **共享记忆块**：挂到多个 Agent，更新对全部挂载方可见；可 `read_only`；
- **私有 archival memory**：默认按 Agent 隔离，靠 metadata/tags 过滤。

对 moshi 的启示：

- 大多数事实可以用“主 scope + 继承”覆盖；
- 真正需要“项目 A 和 Agent X 都能看、项目 B 不能看”时，单 scope 不够，需要 `fact_scope(fact_id, scope)` 多对多；
- 不要默认上多对多，先用主 scope + 继承覆盖 80%，确有共享需求再加关联表；
- 私有记忆默认隔离，公开/共享必须显式授权，不能反过来。

### 2.5 隔离是读取出口的策略，不是写入标签

Cognee 的模型最完整：

- dataset 是隔离边界；
- 用户/角色/租户持有 read / write / delete / share 权限；
- 无权访问返回 403；不存在返回 404；
- 权限检查在服务层执行。

Zep 也明确提醒：`group_id` 只是过滤条件，不是授权；不传 `group_ids` 会搜索所有组。

对 moshi 的硬性要求：

- 没有 context 时，默认只查 `global`，**绝不默认查全部**；
- MCP、REST、UI 图、PPR 遍历、训练样本、导出，每一个读取出口都要执行同一套可见性检查；
- 只在事实列表层过滤是不够的；`edge` 没有 scope，邻居扩展/子图仍可能跨 scope 泄漏；
- “不可训练 / 不可导出”应是独立策略位，不能靠 scope 推断。

## 3. 直接复用评估

| 方案 | 语言/形态 | 能否嵌入 moshi | 结论 |
|---|---|---|---|
| **Mem0** | Node (`mem0ai`) / Python；Apache-2.0 | TS SDK 可用 `better-sqlite3` 做 history，但向量默认内存存储；会形成第二套记忆存储 | 可做“语义记忆旁路”实验，不做核心事实源 |
| **Graphiti** | Python；Apache-2.0 | 通常依赖 Neo4j/FalkorDB；moshi 是 SQLite | 不复用代码，借双时间与命名空间设计 |
| **Letta** | 有状态 Agent 运行时 | 会替换 Agent 控制循环，不是纯库 | 不复用运行时，借共享/私有语义 |
| **LangMem** | Python，绑定 LangGraph Store；MIT | 与 TS/SQLite 不匹配 | 不复用代码，借 namespace tuple |
| **Cognee** | Python；Apache-2.0 | 偏企业知识工程，组件重 | 不复用引擎，借 dataset/RBAC |
| **MemOS** | Python，研究型记忆 OS | 组件重，超出当前需要 | 不复用，借 MemCube 元数据 |
| **A-MEM** | 研究代码 | 无审计/版本，生产性不足 | 不复用，借笔记链接/演化思路 |

**唯一值得小规模验证的是 Mem0 TS**：如果未来需要独立的语义召回层，可以用它做旁路实验。但它不能替代 moshi 的证据链、审计、图结构和训练样本；核心事实源不要迁过去。

## 4. 对 moshi 的建议模型

### 4.1 四层拆分

| 层 | 内容 | 现有基础 | 需要补 |
|---|---|---|---|
| **来源 provenance** | 哪个会话、哪个 Agent、哪台机器、哪个 cwd | `episode.session/agent/cwd` | `host_id`；Agent 实例 id（现在只是适配器名） |
| **可见范围 namespace** | `global/host/project/agent/session` | `fact.scope`、`entity.scope` | 命名空间语法、继承、查询 context、优先级 |
| **时间 validity** | 真值有效期、记录期、保留期 | `valid_at/valid_to`、`recorded_at` | `expired_at`、TTL |
| **策略 policy** | 私有、共享白名单、不可训练、不可导出 | 只有 quarantine | 策略位与各读取出口检查 |

### 4.2 查询上下文

建议 MCP `memory_query` 增加 `context`：

```json
{
  "host": "m2",
  "project": "moshi",
  "agent": "claude-code:work",
  "session": "s_..."
}
```

服务端解析可见集合，并按优先级处理覆盖。没有 context 时只查 `global`，保持安全默认。

### 4.3 两个必须单独决定的建模问题

1. **entity 是否按 scope 复制**  
   现在 `entity` 唯一键包含 scope，同一 `pkg:node` 会在每个 scope 各一份。建议事实分层、实体尽量共享；否则图会碎，实体消解成本也会上升。
2. **edge 是否带 scope**  
   `edge` 现在没有 scope。PPR/邻居扩展/训练子图可能跨 scope 泄漏。至少要在遍历时按两端事实的可见性过滤；更彻底的做法是边也带 scope。

### 4.4 训练与评测

- 训练样本按可见范围分组，跨 scope 不能互当负样本；
- 私有 / `never_train` 记忆不得进入样本；
- 评测增加“跨 scope 泄漏数”指标（概设已有此设想）；
- 导出与归档同样执行策略检查。

## 5. 实施顺序（暂缓）

如果后续确认要做，建议按以下顺序，避免一次性重构：

1. **V-01a 语义与模型（ADR）**：确定四层、context、优先级、安全默认；
2. **V-01b 数据与检索**：episode 补 host/agent 实例；scope 命名空间；查询 context；泄漏测试；历史数据只做建议，不自动回填；
3. **V-02 UI/MCP**：上下文指示器、scope 切换、MCP `context` 参数；
4. **策略层**：TTL、private、never_train/export，再接训练与导出；
5. **可选 Mem0 TS 旁路实验**：只验证语义检索，不进入主链路。

## 6. 风险与未决问题

- **多租户 vs 本地单用户**：moshi 是本地单用户系统，Cognee 式 RBAC 可能过重；但“项目/Agent/会话隔离”仍然需要简化版策略。
- **安全默认**：无 context 时查 `global` 会产生“查不到项目事实”的体验；是否默认带当前 host/project，需要产品决策。
- **历史数据**：现有事实基本都是 `global`；episode 里有 cwd/agent，可做候选建议，但自动回填风险高。
- **图遍历泄漏**：只过滤事实列表不够，边、PPR、子图、UI 图、训练导出都要检查。
- **基准不可直接比较**：各系统论文/博客的 LoCoMo、LongMemEval 等结果口径不同，不能直接作为选型依据。
- **开源许可**：Mem0 / Graphiti / Cognee 为 Apache-2.0，LangMem 为 MIT；托管版/企业功能另有商业条款，选型时需单独确认。
- **外部系统演进**：Zep 的开源自托管形态与商业云形态需在真正选型时重新核对；本文不把任何外部系统当作稳定依赖。

## 7. 参考资料

- Mem0 entity-scoped memory：<https://docs.mem0.ai/cookbooks/essentials/entity-partitioning-playbook>
- Mem0 memory filters：<https://mem0.mintlify.app/platform/features/v2-memory-filters>
- Mem0 TypeScript OSS SDK：<https://github.com/mem0ai/mem0/blob/dae67f74/mem0-ts/src/oss/README.md>
- Zep Graphiti graph namespacing：<https://help.getzep.com/v2/graphiti/core-concepts/graph-namespacing>
- Graphiti overview：<https://github.com/neoneye/agent-memory-atlas/blob/38c629f7a784b7bffacefb01f041b36cf57a2417/docs/systems/graphiti/index.html>
- Letta shared memory：<https://docs.letta.com/v1-sdk/memory/shared-memory>
- Letta memory blocks：<https://docs.letta.com/v1-sdk/memory/memory-blocks>
- LangMem dynamic namespaces：<https://github.com/langchain-ai/langmem/blob/8620b986af5b0c7593e6b7fbece2998690d22d15/docs/docs/guides/dynamically_configure_namespaces.md>
- LangMem memory tools：<https://github.com/langchain-ai/langmem/blob/8620b986af5b0c7593e6b7fbece2998690d22d15/docs/docs/guides/memory_tools.md>
- Cognee data isolation & multi-tenancy：<https://docs.cognee.ai/core-concepts/multi-user-mode/data-isolation-and-multi-tenancy>
- Cognee permissions system：<https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/overview>
- MemOS architecture：<https://memos-docs.memtensor.net/cn/open_source/home/architecture>
- MemOS paper：<https://export.arxiv.org/abs/2507.03724>
- A-MEM paper：<https://export.arxiv.org/abs/2502.12110>
- 主流 Agent Memory 系统全景（第三方整理）：<https://github.com/cdavid817/awesome-agent-tutorial/blob/9c45cb664b119e3c298de9170333758be6d1874d/%E9%99%84%E5%BD%95/%E9%99%84%E5%BD%9515-%E4%B8%BB%E6%B5%81AgentMemory%E7%B3%BB%E7%BB%9F%E5%85%A8%E6%99%AF.md>
