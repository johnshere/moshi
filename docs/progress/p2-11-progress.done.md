# P2-11 社区划分与稳定性施工记录

- 状态：DONE（代码/测试/生产接入完成；收口联动 B-2 被真实库 0 活跃边阻塞，见下）
- 开工：2026-11-04 20:26
- 完成：2026-11-04 21:20
- 依据：任务台账 §4 P2-11；详设 §8.4；概设 §9.2、§10.2.1
- 上一节点：P2-10 已验收并提交 `388af93`

## 开工核查

- 当前没有 `core/lifecycle/community.ts`、Louvain 划分实现或生产触发入口；`factRepo.setCommunity()` 已存在但无生产调用方。
- 图输入口径已明确：只取 `active/disputed` 事实与活跃边；划分结果写 `fact.community_id`，并推进 `meta.community_rev`。
- 稳定性要求：新旧社区按成员集合计算 Jaccard，重叠度 ≥0.5 才继承旧 id；新 id 必须避开全部旧 id，保证归档 `topic_id` 与 slug 稳定。
- 归档已直接依赖社区结果：`core/archive/topics.ts` 只选择 `community_id` 非空、事实数 ≥8 且依赖链完整度 ≥0.5 或存在互斥边的社区。
- `community_summary` 表和 `communityRepo` 读取方法已存在，但摘要生成属于 P2-12，本节点不提前实现。
- 根工程尚未直接依赖 Louvain 实现；UI workspace 已有 graphology 传递依赖，但不能当作后端可用依赖。算法来源与确定性顺序需在实现前定案。
- `factRepo.setCommunity()` 不更新 `updated_at`，符合布局/社区投影语义；批量写回应复用该专用入口并放在事务中，不新增裸 SQL 到 core。
- 验收需覆盖：两个明显连通分量、孤立节点、微变后 id 继承、Jaccard 冲突的一对一分配、失效节点/边排除、重跑确定性、10k 事实 <60s，以及真实库 `moshi export --all` 至少落盘 1 篇主题文档后关闭 B-2。

## 实现

### 算法（`src/core/lifecycle/community.ts`，新建）

- **自实现确定性 Louvain**（D-123）：根工程无 graphology 类依赖，不引入新包。
- 确定性三件套：社区用「社区内最小节点 id」作文本标识（可排序可比较）；节点按 id 升序访问、边按 (src,dst) 升序；ΔQ 平局取社区代表 id 较小者。
- ΔQ 用 Blondel 简化公式 `k_in/(2m) − Σ_tot·k_i/(2m²)`；自环项在移入/移出时抵消；模块度 = `Σ_c[Σ_in/(2m) − (Σ_tot/(2m))²]`。
- 退化处理：无节点/无边 → 每节点单社区、modularity=0；全图并一社区 → Q=0。
- 外层聚合上限 60 轮、局部移动 pass 上限 50，防病态收敛。
- `assignStableIds`：新旧社区按成员集合 Jaccard ≥0.5 且一对一继承旧 id；未继承的新社区 id = max(旧 id)+1 起递增、不复用消失旧 id；匹配顺序 = 新社区按代表 id 升序 + 每个按 Jaccard 降序/平局旧 id 升序。

### infra（`src/infra/sqlite/communityRepo.ts`，扩展）

- `loadCommunityNodes`（active/disputed ORDER BY id）、`loadCommunityEdges`（活跃边 valid_to IS NULL + 两端 active/disputed，ORDER BY src,dst）、`loadCommunityGraph`、`loadOldAssignment`（仅非空行）。
- `applyCommunityAssignment`：**单事务**，只写变化行 + 有变化才推进 `community_rev`（幂等）。
- `communityRev`、`countCommunityChanges`（dryRun 用，避免 app 层碰 db——lint:lifecycle 禁 src/core 与 src/app 持 db 句柄）。

### 生产接线

- `src/app/communityRunner.ts`（新建）：daemon runner（`COMMUNITY_INTERVAL_MS=300_000`，判脏 = schema_rev 或活跃边数变化，启动即算一次，`kick/stop/state`）+ `runCommunityOnce(db,{dryRun})`（daemon 与 CLI 共用）。
- `src/app/cli/commands/db.ts`：新增 `db community [--dry-run]`，输出 `{command,nodes,edges,communities,inherited,wrote,modularity,iterations,rev,ms,dry_run}`。
- `src/app/main.ts`：import、启动 `startCommunityRunner`、shutdown 时 stop。
- 判脏含「活跃边数变化」：边 INSERT/收口不推 schema_rev（001 只有 fact INSERT 触发器推 rev），但会改社区结构。

## 验收

- `pnpm typecheck` 通过（修两处：TS6133 未用变量、TS2345 继承表 key 类型）。
- `pnpm verify` 全绿：**75 files / 926 tests**（含新增 `tests/unit/community.test.ts` 13 例，vitest 约 6.3s）。
- `pnpm build` 通过（UI vite build + tsc + copy-assets）。
- 单测覆盖：两个连通分量+孤立节点 → 3 社区、孤立节点 sizes=1；孤立全图 → 各自单社区；同输入重跑逐位一致；两节点一边 → 单社区 Q≈0；微变（A 团加 1 节点）后 B 团/孤立节点 id 不变、A 团继承旧 id（Jaccard 3/4）、只写 1 行；Jaccard 冲突一对一（P 继承 1、Q 得 2）；消失旧社区 id 不复用（含边界：单成员 {c} 与旧 {c,d} J=0.5 → 继承 9）；首次划分 id 从 1 起；失效节点/失效边排除；写回落库、rev 推进、无变化不推进；10k 节点（100 团×100 + 桥接边，约 30k 边）实测 **5345ms** <60s 且结果确定；daemon runner 判脏（无变化跳过、插事实重算、只加边也重算）。
- 真实库收口联动（`C:\Users\john\.moshi\moshi.db`）：
  - `db community --dry-run`：`{"nodes":57,"edges":0,"communities":57,"inherited":0,"wrote":57,"modularity":0,"iterations":0,"rev":0,"ms":1,"dry_run":true}`
  - `db community`（写回）：首跑 `wrote:57, rev:1`；二跑 `inherited:57, wrote:0, rev:1`（幂等 + 全继承）。
  - `export --all`：**0 篇**——真实库 `edge` 表 0 行（连失效边都没有），57 个 active/disputed 节点全孤立 → Louvain 正确产出 57 个单节点社区，但无一满足 `fact_count≥8`（归档门槛），主题导出为空。
  - 结论：**B-2 无法经 P2-11 关闭**。根因是数据面：P2-22 边抽取（DONE）只在 harvest 新批时抽边（`extractEdges(db,{facts})`），真实库 57 条事实是 P2-22 上线前的存量，无补抽入口；社区划分在无边的退化图上行为符合规格（单节点社区 + modularity 0）。B-2 阻塞点从「community_id 全 NULL」更新为「真实库无活跃边」，与 B-1（真实库 edge=0）同源，待数据面补齐（harvest 新数据触发抽边 / 存量补抽）。

## 决策与遗留

- 决策 **D-123** 已记台账 §5.2（自实现确定性 Louvain、社区代表=最小节点 id、Blondel 简化 ΔQ、孤立节点自成社区、rev 仅在有变化时推进）。
- 遗留 **I-32** 已记台账 §5.3（真实库 0 活跃边，P2-11 产出 57 个单节点社区，export 仍 0 篇，B-2 数据前提未满足）。
