# P2-09 巩固：情景→语义 — 施工进度

- 起止：2026-11-03 20:19 ~（进行中，代码/测试/验收已完成，待独立验收与 Lead 收口）
- 依据：台账 §4 P2-09（目标：同 key ≥3 条 episodic → 1 条 semantic + `derived_from` 边；产出 `core/lifecycle/consolidate.ts`；验收：跑两次不产生重复要点、产出的 confidence 不高于源均值；坑：不许改源事实、不许删源事实）
- 详设：§8.3（四类巩固全部在 harvest 之后串行、低优先级、限速每秒 20 条）、§8.3.1（分组 SQL + 产出模板 + 幂等键 + 红线）、§1.2（时间唯一解析入口 `parseTs`）、§1.3（数值精度 4 位小数）
- 概设：§5.5.2（为什么必须有情景→语义：否则图被重复观测灌满且永远没"结论"）、§5.5.3（触发与可重入：`derived_from` = 源 id 集合指纹；日常增量/全量重建）、**§5.5.4 红线表**（禁止改写 `fact.content`、禁止删除事实行、禁止用巩固结果覆盖原始观测、禁止巩固结果进 GAT 特征）

## 开工前核查（2026-11-03 20:19）

已读文档：`AGENTS.md`（DoD 六条）、台账 §1 / §3 / §4 P2-09 / §5.2 尾（`D-106`）/ §5.3 尾（`I-22`）、详设 §8.1 / §8.3 / §8.3.1、概设 §5.5.1~§5.5.4 / §5.6、`docs/progress/p2-08-progress.done.md`（格式样板）。

代码实测（逐项核对，不是推测）：

- **模块不存在**：`src/core/lifecycle/` 只有 `schema-infer.ts` 与 P2-08 的 `strength.ts`；全仓 grep 无 `consolidate` / `derived_from` 的实现，`ETYPE` 里的 `derived_from` 与 `CONF_SOURCE` 里的 `derived` 是**枚举已就绪、无生产者**。
- **`canonical_key` 已含 scope**：`domain/hash.ts` 的 `canonicalKey(scope, entityId, predicate)` 把 scope 混进哈希，所以按 `canonical_key` 分组 ≡ 按「scope + 实体 + 谓词」分组；但 SQL 分组仍显式带上 `scope`（`GROUP BY canonical_key, scope`），让 `invalidate` / 建边时不用反解哈希。
- **身份唯一索引是硬约束**：`migrations/001_init.sql` 的 `CREATE UNIQUE INDEX idx_fact_identity ON fact(canonical_key, scope, value_hash) WHERE valid_to IS NULL`（只约束活跃行）。派生要点的 `value_hash` 由 `valueHash(聚合结构)` 得出，与任何单条源事实都不同，因此不会撞索引。
- **写入闭环会把同值观测折叠**：`core/write/harvest.ts` 情形 B（`existing.validTo === null`）走 `refreshRecordedAt + touchAccess + mergeOnReobserve`，**不插新行**。用临时脚本 `temp/p2-09-scout/scout.ts` 实测确认：
  - 同 key 同 value 写 3 次 → **行数 1**；
  - 同 key 不同 value 写 3 次 → **行数 3**（默认基数性 `set`，`core/write/conflict.ts` 的 `DEFAULT_SINGLE_VALUED` 不含该谓词）；
  - 详设 §8.3.1 的分组 SQL 在这样造出的库上命中 1 组、`n=3`，组内 3 条 `value_hash` 互不相同。
  - ⇒ **硬结论**：真实数据里「同 key ≥3 条活跃 episodic」必然**取值互不相同**，详设 §8.3.1 的 `{value}` 单值模板不能照字面取某一条源值（会与活跃源行撞唯一索引）→ 见决策 D1。
- **生产路径没有任何代码写 `ftype='episodic'`**：全仓 `src/` grep `'episodic'` 只命中 `src/domain/enums.ts` 的枚举定义；harvest / annotate / tool_parse 全部默认 `'semantic'`，只有 `memory_annotate` 显式带 `ftype:'episodic'` 才能造出情景事实。⇒ 巩固必须有**真实进程内的调用点**（否则违 DoD ⑥），见 D4。
- **生产调用点现成**：`src/app/main.ts:77` 是 `runner = startHarvestRunner({ db, log })`（不传 intervalMs），所以「给 `HarvestRunnerOptions` 加一个默认开启的巩固选项」即可成为生产接线点，**不需要改 main.ts**。
- **Linter 红线**：`tools/check-lifecycle.ts` 禁止 `src/core`、`src/app` 出现裸 `db.prepare/exec/pragma/transaction` 与 `UPDATE fact SET ... strength|...`；`tools/check-writes.ts` 禁 app/core 用 `node:fs` 写类。⇒ 分组 SQL 与「插要点 + 建边 + 收口旧要点」的写动作都必须在 infra 层（见 D7）。
- **夹具坑**：`tests/fixtures/factories.ts` 的 `insertFact` 默认每次调用都新建实体（`makeEntity`），同一 subject 名会产生**不同 `entity_id`** → `canonical_key` 不同 → 分组失败。造同 key 数据必须显式传同一个 `subject.entity_id`（`seedObservations` 已按此写）。
- **`trg_degree_ins`**：`migrations/001_init.sql:347` 在插入活跃边时给 `src`/`dst` 两端 `degree + 1`（不动 `updated_at`）。给源事实建 `derived_from` 边必然让源事实 `degree` 变化，红线检查必须按字段判定（见 D9）。
- **边与检索 API**：`edgeRepo.neighbors(db, id, opts)` 没有方向参数（src/dst 都算邻居）；`factRepo.searchFacts` 的 `ftype` 是**数组**（传字符串会 TypeError）；`listByIds` 不保证顺序（指纹前必须排序）。

## 决策记录（P2-09）

- **D1 要点取值用「聚合结构」，不是某一条源值**：`attrs.frozen.value = { consolidated: true, observations: n, values: [...] }`，`values` 按 `canonicalJson` 排序去重后写入，`valueHash = valueHash(聚合结构)`。理由：开工前实测证明组内取值必然互不相同（见上），取任一条会与活跃源行撞 `idx_fact_identity`；聚合结构还让「要点 = 归纳」这件事在数据层面自解释，且天然满足「幂等键变则新要点变」。
- **D2 幂等键 `ext.derived_from = sha256(sorted(ids).join('\n'))`（64 位 hex）**：与 id 顺序无关（`listByIds` 不保证顺序，先 `sort` 再拼）；同一源集合永远同一指纹。识别「已提炼要点」不额外加 `ext` 标记，直接用 **`confidence_source = 'derived'`**——这是 `CONF_SOURCE` 里既有、此前无生产者的值，语义正好是「派生而非观测」，避免在一个字段里塞两个真值来源。
- **D3 源集合变了 → 产出新要点，并让上一条要点「收口」而非改源**：同 key 出现第 4 条观测后指纹变化，新指纹查不到活跃派生行 → 建新要点，同时把该 key 下**已存在的活跃派生要点** `invalidate({validTo, supersededBy: 新要点 id, status: 'invalidated'})`。源事实一条都不动（不 `invalidate`、不改 `epistemic_status`、不改 `content`）。收口 `validTo` 取 `max(now, old.validAt + 1ms)` 以过 `valid_to > valid_at` 的 CHECK。
- **D4 接线点 = `harvestRunner` 每轮 harvest 之后串行跑一次，默认开启**：`HarvestRunnerOptions` 增 `consolidate?: ConsolidateOptions | false`（`false` 可关）。失败**不冒泡**（`log.error` 后继续）——写入闭环是主线，巩固是它后面的低优先级维护（详设 §8.3 总则）。`lastMs` 含巩固耗时，所以 `state()` 反映的是「整轮」成本。生产侧 `main.ts` 一行没改即生效，这就是 DoD ⑥ 的接线点；测试 `harvestRunner.test.ts` 的新用例锁住它（不手动调 `consolidate`，只 `runMemoryAnnotate` 入队）。
- **D5 手动入口 `moshi db consolidate [--dry-run] [--rate n]`**：复用 P2-08 已建的 `db` 命令分发（`SUBCOMMANDS` 常量 + 公共 `--dry-run`），`--rate` 只对本子命令生效且必须是**非负整数**（`0` = 不限速，测试用）。`rebuild-strength` 分支逐行未动。
- **D6 限速在「组」之间**：`CONSOLIDATE_RATE_PER_SEC = 20`（详设 §8.3 总则的「每秒 20 条」在分组场景落到「每秒 20 组」），组间 `await delay(ceil(1000/ratePerSec))`；首个组前与 `dryRun` 都不等（dry-run 只读，限速没有意义）。单组内的写是一个事务，不会被限速打断。
- **D7 读/写分层**：新增 `src/infra/sqlite/consolidationRepo.ts` 只放两条**只读**查询（分组、按 key 取活跃派生行）；写动作全部复用既有仓储函数（`insertFact` / `insertEdge` / `invalidate` / `findByIdentity` / `listByIds`），事务用 `withTransaction`（`BEGIN IMMEDIATE`）。`core/lifecycle/consolidate.ts` 里**没有**任何裸 SQL，也不拼 `UPDATE`——`lint:lifecycle` 因此不用开白名单。
- **D8 置信度 `round4(min(0.90, 源均值))`**：与 P2-08 的 `round4` 同口径（详设 §1.3「写入前四舍五入到 4 位」）。因此「不高于源均值」以 4 位小数为精度成立（实测 `[0.7,0.7,0.7]` 的浮点均值是 `0.6999999999999998`，落库 0.7；判定按 `round4(均值)` 比较）。上限 0.90 严格生效（`[0.95,0.95,0.95] → 0.9`）。
- **D9 红线按字段判定，`degree` 除外**：写 `derived_from` 边会触发 `trg_degree_ins` 让源事实 `degree + 1`，这是「新增溯源边」的必然副作用（概设 §5.5.4 第一行明确允许新增溯源边），不是改写观测。测试与验收都按「除 `degree` 外逐字段相等 + `degree` = 原值+1」断言，并在注释里写明原因。
- **D10 新要点沿用 `draftToFact` 的默认值**：`strength=0.5`、`importance=0.5`、`pool='utility'`、`epistemicStatus='active'`、`communityId=null`、`sourceEpisode=null`、`span=null`。不发明「要点更重要」（无依据），也不把 `source_episode` 指向源观测（那条是原始轨迹的引用，要点是归纳不是轨迹）。`validAt = recordedAt = lastDecayAt = createdAt = updatedAt = now`（巩固产生即「刚观测到」）。

## 进度

- [x] 读台账 §4 P2-09 / §3 / §5.2 尾 / §5.3 尾、详设 §8.3 / §8.3.1、概设 §5.5、p2-08 progress 样板
- [x] 核查现状（lifecycle 目录、harvest 四情形、唯一索引、触发器、lint 红线、episodic 生产者 grep、夹具坑）+ 临时脚本实测「同 key ≥3 条必然取值不同」
- [x] `src/infra/sqlite/consolidationRepo.ts`：`listEpisodicGroups`（详设 SQL + `GROUP BY canonical_key, scope`）、`listActiveDerivedFacts`
- [x] `src/core/lifecycle/consolidate.ts`：`derivedFromOf` / `buildConsolidatedValue` / `renderConsolidatedContent` / `consolidatedConfidence` / `consolidate`
- [x] 接线：`src/app/harvestRunner.ts` 每轮 harvest 后串行巩固（默认开、失败不冒泡）
- [x] CLI：`src/app/cli/commands/db.ts` 新增 `consolidate` 子命令 + `--rate`
- [x] 单测：`tests/unit/consolidate.test.ts`（11 例）、`db-cli.test.ts` +3 例、`harvestRunner.test.ts` +1 例
- [x] `pnpm verify`（889 passed | 3 skipped / 73 files，0 failed）、`pnpm build`（exit 0）
- [x] 端到端验收（真 CLI + 真库 + 真 runner，9/9 通过，见下）
- [ ] 台账 §1 / §1.1 / §3 / §5.2 / §5.3 / §6 更新 —— **由 Lead 收口时做**
- [ ] 独立验收（独立子代理 verify-p2-09）

## 验收记录

### 台账 §4 的四条验收（逐条证据）

1. **同 key ≥3 条 episodic → 1 条 semantic + `derived_from` 边**：单测 `3 条观测归纳成 1 条要点，并建 3 条溯源边`；端到端 `[产出] semantic=1 episodic=3 count=4`、`[溯源边] derived_from=3`。
2. **跑两次不产生重复要点**：单测 `同一批源事实跑两次：第二次 created=0、要点唯一`；CLI 端到端 `[首跑] created=1` → `[二跑] created=0/skipped=1`，`count=4`、`semantic=1`。
3. **产出的 confidence 不高于源均值**：源 `0.8/0.7/0.6` → 均值 `0.7`，要点 `confidence=0.7`（`[验收2] true`）；另有纯函数例 `[0.95,0.95,0.95] → 0.9`（上限）与 `[0.5,0.6,0.7] → 0.6`。
4. **红线：不许改源事实、不许删源事实**：单测逐字段比对（除 `degree`）+ SQL 断言源 `valid_to` 仍 `NULL`、`epistemic_status` 仍 `active`、`COUNT(fact)` 只 +1；端到端 `[红线] 源事实除 degree 外逐字段一致=true；源 valid_to 仍为 null=true；源状态=["active","active","active"]`。

### 命令全文与输出摘要

```powershell
# 1) 全链（typecheck / typecheck:ui / lint:deps / lint:lifecycle / lint:writes / test）
$env:TEMP='E:\Workspace\00-learning\moshi\temp'; $env:TMP=$env:TEMP; pnpm verify
# Test Files  72 passed | 1 skipped (73)
#      Tests  889 passed | 3 skipped (892)      ← 基线 874 passed | 3 skipped / 72 files，只增不减
# Duration 194.05s   exit=0

# 2) 构建（TEMP/TMP 重定向工程内）
$env:TEMP='E:\Workspace\00-learning\moshi\temp'; $env:TMP=$env:TEMP; pnpm build
# moshi-ui: ✓ 83 modules transformed → index-Bk6N8BK_.js 1,198.78 kB
# copied src/app/http/ui.html -> dist/app/http/ui.html
# copied src/app/ui/dist/ -> dist/app/ui/dist/     exit=0

# 3) 端到端（真 CLI + 独立数据目录 + 真 runner；脚本 temp/p2-09-accept/accept.ts）
pnpm exec tsx temp/p2-09-accept/accept.ts
```

端到端输出（全文见 `temp/p2-09-accept/accept.log`）：

```
[种子] count=3 edges=0 ids=f_01m6gpmcsa…,f_01m6gpmcsc…,f_01m6gpmcsdg…
[首跑] exit=0 stdout={"command":"db consolidate","groups":1,"created":1,"skipped":0,"superseded":0,"ms":26,"dry_run":false}
[二跑] exit=0 stdout={"command":"db consolidate","groups":1,"created":0,"skipped":1,"superseded":0,"ms":1,"dry_run":false}
[产出] semantic=1 episodic=3 count=4
[要点] {"confidence":0.7,"confidenceSource":"derived","content":"service:sidecar 的 runtime_state 为 crashed、idle、listening（由 3 次观测归纳）","sourceEpisode":null,"derived_from":"2936bfb1…09b853","valueHash":"vh1:d0c42f23…86d0"}
[溯源边] derived_from=3
[红线] 源事实除 degree 外逐字段一致=true；源 valid_to 仍为 null=true；源状态=["active","active","active"]
[验收2] 要点 confidence=0.7 ≤ 源均值 0.7000 → true
[dry-run] exit=0 stdout={"command":"db consolidate","groups":1,"created":1,"skipped":0,"superseded":0,"ms":4,"dry_run":true}
[dry-run] fact 表逐行相同=true edge 表相同=true count=3→3
[缺子命令] exit=2 含 consolidate=true
[未知子命令] exit=2 stderr首行=未知子命令：vacuum
[--rate abc] exit=2 stderr首行=--rate 需要非负整数
[未知参数] exit=2 stderr首行=未知参数：--force
[库不存在] exit=1 stderr首行=尚未观测到数据库：…\no-db\data\moshi.db
[老命令未坏] exit=0 stdout={"command":"db rebuild-strength","scanned":4,"changed":0,"dry_run":true}
[接线] 入队 accepted=3 pending=3
[接线] count=4 semantic=1 自动产出=true
结果：9/9 通过
```

最后两行是 DoD ⑥ 的证据：只调 `memory_annotate`（`startHarvestRunner({db, intervalMs: 0})`，生产同款默认参数），**没有手动调 `consolidate`**，同一轮收尾就自动出现 1 条 `confidenceSource='derived'` 的要点。

### 改过的既有测试（逐条说明）

- `tests/unit/db-cli.test.ts`（M，+95）：新增 `describe('db consolidate（P2-09）')` 3 例（幂等 JSON、`--dry-run` 不写库、`--rate abc`/`--force` exit 2），并新增本地夹具 `seedEpisodic`（同 key 三条，显式复用 `makeEntity` 的 entity_id）。import 从 `{ insertFact }` 改为 `{ insertFact, makeEntity }`；文件头补一行 P2-09 说明。**既有 5 例断言一行未动**（`rebuild-strength` 的 4 例 + 无/未知子命令 1 例），只把「缺子命令」用例里 usage 的断言依赖保持不变（`USAGE` 仍含 `rebuild-strength`）。
- `tests/unit/harvestRunner.test.ts`（M，+45）：新增 1 例「episodic 观测落库后，同一轮收尾就提炼出 semantic 要点（P2-09 接线点）」；文件头补接线点说明。既有 4 例一行未动。溯源边数用 `SELECT COUNT(*) ... WHERE etype='derived_from'` 断言（不用 `countEdges`，因为 harvest 自己还会抽 `co_occur` 边）。
- **既有用例零失败**：全量 `889 passed | 3 skipped`，0 failed。

### 修测试时踩到的三处（防复发）

1. **浮点均值**：`0.7×3/3 = 0.6999999999999998`，`confidence` 落库 `0.7` 严格大于它 → 断言改成按 `round4` 精度比较（`Math.round(avg*1e4)/1e4`），并在 D8 记录口径。
2. **`groups` 的语义**是「达到阈值的候选组数」，不是原始分组数：默认阈值 3 时另一组只有 2 条 → `groups:1`。
3. **红线断言不能整对象 `toEqual`**：源事实 `degree` 从 0→1（`trg_degree_ins` 随新增边自增）→ 改成「除 degree 外逐字段相等 + degree = 原值+1」，见 D9。

### 与派单的偏离

1. 除 `core/lifecycle/consolidate.ts` 外多建了 `src/infra/sqlite/consolidationRepo.ts`（D7）：分组 SQL 不能进 core（`lint:lifecycle`），这与 P2-08 把分页扫描留在 infra 是同一约束。
2. 详设 §8.3.1 的 `content` 模板 `{value}` 位实现为「取值集合按 `canonicalJson` 排序后用 `、` 连接」（D1），并在文件头注释与 D1 里写明实测依据；单值场景下与文档字面完全一致。
3. 详设未规定「源集合变化后旧要点怎么办」，D3 取「收口旧要点、不动源」；这比「放任两个活跃要点并存」更贴 §5.5.2 的「永远有结论」意图。
4. 详设 §8.3 的「每秒 20 条」落在组间隔上（D6）。

### 未接线 / 风险

- **增量/全量模式未区分**：概设 §5.5.3 说「日常增量只处理 dirty 社区、用户点重建才全量」，当前每次都全量扫 `listEpisodicGroups`（10k 事实下按 `idx_fact_key` 分组，未做性能基准）；dirty 社区口径属于 P2-11（社区划分）之后，留给 P2-17 调度器一并落地。
- **限速只到「组」粒度**：单组内几百条源事实的建边在一个事务里完成，未按条限速。
- **`groups` 未做上限**：`maxGroups` 选项已留（默认不封顶），调度器接入时应该传。
- **巩固结果会满足 `isFeatureEligible`**：`domain/enums.ts` 的 `isFeatureEligible(status)` 只看 `epistemic_status ∈ {active, disputed}`，派生要点是 `active` → 若 P3 的 GAT 特征直接用这个判定，会违反概设 §5.5.4 第三行「巩固结果不得进 GAT 特征」。**本任务不改 GAT**，已记观察项。
- **`由 n 次观测归纳` 的 n = 不同取值数**，不是真实观测次数（同值重复观测被 harvest 情形 B 折叠成 1 行）。要还原真实次数需要在 harvest 记计数（未做，已记观察项）。
- **`confidence_source='derived'` 同时承载两个语义**（「派生」与「已提炼要点」）：目前只有本任务生产 `derived`，可接受；将来若别的巩固任务也产 `derived`，需要按 `ftype`+`ext` 再细分。
- **旧要点的 `derived_from` 边保持活跃**：收口的是要点行，边没有 `closeEdge`——溯源边描述的是「这条要点来自哪些观测」，历史保留是有意的；若将来要「有效溯源」，需按 `valid_to IS NULL AND src = 活跃要点` 过滤。
- 未覆盖：真实 daemon 常驻进程的多轮巩固时间线（只验了单轮 + 手动 `runOnce`）、>200 条源事实的组、并发写（SQLite WAL 竞争）。

## 独立验收（2026-11-03 21:00，验收子代理 ee0af28f）

- 角色：独立验收子代理（只读源工程，脚本与临时库只写 `temp/p2-09-verify/`，未改 src/tests/docs/migrations/package.json）。
- **结论：通过，0 阻断**。六条验收标准 6/6；自写检查 **232 项：231 严格通过 + 1 项按详设 §1.3 的 1e-4 浮点容差判等价**。
- 分项通过数（子代理自写脚本，非本人 vitest）：纯函数 **24/25**（唯一失败项即 `round4` 上舍入 +3.33e-5，判等价）、端到端+边界 **96/96**、幂等 **5/5**（另 CLI 连跑同验）、CLI **66/66**、生产接线 **16/16**、兼容 **29/29**。
- 与文档字面差异 **16 条：等价 8、更严 0、偏离（非阻断）8、违规 0**；红线（概设 §5.5.4）**无违反**。
- 复现物：`temp/p2-09-verify/{lib,a-pure,e2e,g-cli,h-wiring,i-compat,probes}.ts` + `logs/*.txt` + 报告 `report.md`（403 行，`temp/` 不进版本库，结论已抄进本节）。
- 验收子代理亲测的几条关键事实（与本人端到端互补，均为它独立构造）：
  - `D` 段：3 源 → 要点 P1；追加第 4 源 → 新要点 P2 + P1 收口（`valid_to`/`superseded_by`/`invalidated`）+ 溯源边增至 7 条 + 4 条源全 `active`；第 4 源再失效 → 出现「与历史要点同指纹的新行」（**活跃唯一，历史重复**）。
  - `E` 段：除 `degree` 外源事实逐字段一致、无 DELETE 语句、`content`/`value_hash` 未变、`valid_to` 仍 NULL、状态未降级。
  - `G` 段：`--dry-run` 前后 fact/edge 全字段快照逐行一致；`--rate`/未知参数/未知子命令/缺子命令 exit 2；库不存在 exit 1。
  - `H` 段：真 `startHarvestRunner` + `runMemoryAnnotate`，无手动调 `consolidate` 也自动出要点；`consolidate:false` 确实不跑。
  - `I` 段：只有 P2-08 数据的旧库上跑巩固不报错、之后 `searchFacts` 正常。

### 独立验收的 12 条非阻断建议（NB-1~NB-12）处置

| 编号 | 建议 | 处置 |
|---|---|---|
| NB-1 | `round4` 上舍入可能比精确均值高 ≤5e-5，与注释「永远不高于」字面不符 | **接受口径**：按详设 §1.3 的 1e-4 容差判等价；本节与 D8 明确「按 4 位小数比较」。不改代码（改 floor 会让 0.7 落成 0.6999，更差） |
| NB-2 | 限速是「组/秒」而详设写「条/秒」，实际行速约 80 行/秒 | 记 I-27，等 P2-17 调度器统一限速口径 |
| NB-3 | `maxGroups` 每次从头取，多轮下第一组反复 skipped、后面的组轮不到 | 记 I-27；生产默认不封顶、CLI 未暴露，暂无影响 |
| NB-4 | 详设补注写「排序去重」，代码只排序 | **已修文档**：补注改成「排序（去重由写入端身份索引保证）」，不为不可达分支加代码 |
| NB-5 | `listEpisodicGroups` 注释说「仍在有效期内」，SQL 只看 `epistemic_status` | 记 I-27；`invalidate` 必同步改状态，该状态仅能直接 SQL 构造，加 `valid_to IS NULL` 属收紧口径，与详设 §8.3.1 原 SQL 字面一致优先 |
| NB-6 | 源集合回退会产出与历史要点同指纹的新行 | 记 I-27（与本人开工前的自留疑点同一件事）；活跃唯一与连续幂等不受影响 |
| NB-7 | 每轮全量、无 dirty 社区增量、10k 未基准 | 已记 I-23 |
| NB-8 | 派生要点满足 `isFeatureEligible` → P3 GAT 风险 | 已记 I-24 |
| NB-9 | 「由 n 次观测归纳」的 n 实为不同取值数 | 已记 I-25 |
| NB-10 | 台账在验收报告落盘前已标 DONE（20:52 < 21:00） | **接受批评**：本次顺序错了；今后先收验收结论再改 §1/§3；已在 I-27 记下 |
| NB-11 | 旧要点的 `derived_from` 边仍活跃，UI 画图会出现指向失效要点的边 | 已记 I-26 |
| NB-12 | `--rate ''` 被 `Number('')=0` 接受为不限速 | 记 I-27；非验收项 |

### 未覆盖（子代理声明，本人认可）

全量 `pnpm verify`/`pnpm build` 未由子代理复跑（避免抢产物；由本人跑，见上文 exit 0）、UI 路径（本任务无 UI 改动）、10k 性能基准、并发/多进程、GAT 特征路径、调度器与增量、故障注入（`consolidate.failed` 分支仅静态确认）、MCP `tools.ts` 的 zod/JSON-RPC 完整包装路径、`export` 语义、极端取值（换行/超长/非 ASCII/超大组）。
