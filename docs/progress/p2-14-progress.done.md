# P2-14 schema 校验与 diff 施工记录

- 状态：DONE（代码/单测/lint 通过；`pnpm typecheck` 剩一条报错在并发任务 WIP 文件 `src/app/http/server.ts`，与 P2-14 无关，见 §验收）
- 任务：task-3（owner: diag）
- 开工：2026-11-04 21:36
- 完成：2026-11-04 21:47
- 依据：任务台账 §4 P2-14（L957-963）；详设 §2.6（L265-292）/ §8.5（L2702-2739，schema_infer 与 /api/diag 待晋升）；概设 §2.6
- 上一节点：P1-14 schema infer（已 DONE）

## 开工核查

- `ontology` 表已存在（001_init.sql L266-277，PK `(kind,name)`，`promoted` 默认 0）；`value_type` 注释口径为 `string|number|bool|time|enum|json`，按此实现，未用 `src/domain/types.ts` 里那个未落地的 `OntologyEntry.valueType` 口径。
- 已登记键的唯一判据：`ontology.promoted=1`。`schema infer`（P1-14）只写 predicate 行且 `attr_keys` 恒为 `[]`；`upstream` 无 attr_key 晋升入口，故 P2-14 只承担「登记约束 + 未登记计数」，不新增晋升执行器。
- `lint:lifecycle` 禁止 `src/core`/`src/app` 直接持 `db` 句柄或拼 SQL → 校验是纯函数（`src/core/lifecycle/schema-validate.ts`），读写都在 `infra/sqlite`。
- 写通路只有两处：`harvest()` 内部 `writeOne → upsertFact`，以及 MCP 直写 `runDirectWrite → upsertFact`。两者都经过 `upsertFact`，因此把校验与待晋升记录嵌在 `upsertFact` 一处即可全覆盖。
- 详设 L612-628：`frozen` 只允许 `subject/predicate/value` 三个键，多键是结构错误；`ext` 自由。校验只约束「已登记键」。

## 实现

### 纯函数（`src/core/lifecycle/schema-validate.ts`，新建）

- 导出：`SCHEMA_VALUE_TYPES`、`SchemaValueType`、`SchemaKeyKind`、`RegisteredKeyDef`、`SchemaViolation`、`AttrsValidation`、`ValidateAttrsOptions`、`inferSchemaValueType`、`describeSchemaValue`、`matchesSchemaValueType`、`attrsFromDraft`、`validateAttrs`、`assertAttrsValid`、`validateDraft`、`pendingEntries`、`SCHEMA_SNAPSHOT_VERSION`、`SchemaSnapshotEntry`、`SchemaSnapshot`、`buildSchemaSnapshot`、`parseSchemaSnapshot`、`SchemaField`、`SchemaChange`、`SchemaDiff`、`diffSchemaSnapshots`、`renderSchemaMigration`。
- `validateAttrs(attrs, defs, opts)`：先查 `frozen` 键集合必须恰为 `{predicate,subject,value}`（多/少都是 `key:'frozen'` 错误）；再按 `defs` 校验 predicate 值类型、ext 的 attr_key 值类型；未登记 predicate → `predicate:<name>`、未登记 ext 键 → `attr_key:<key>`，排序去重后放 `unregisteredKeys`。登记类型不认识（库里有扩展值）→ 放行。
- `assertAttrsValid`：有错抛 `MoshiError('E_SCHEMA', …)`，`detail={errors, unregistered_keys}`；无错返回校验结果。错误消息形如 `attrs 违反已登记 schema：predicate:about 期望 number，实际 string`。
- 基数性：per-fact attrs 本身不携带基数性，只有调用方在 `FactDraft.cardinality` 显式声明时才与登记值比对；不声明不臆测（避免把 series 谓词的单条事实误判）。
- 快照只含「已登记键」（`loadRegisteredKeys` 过滤 `promoted=1`），按 `kind`（attr_key 先、predicate 后）再 `name` 排序；`parseSchemaSnapshot` 对坏 JSON / 版本 / kind / value_type / cardinality 抛 `E_INPUT`。
- `diffSchemaSnapshots` 输出 `added/removed/changed/unchanged`，`changed` 只按 `value_type`、`cardinality` 两字段逐项比对；`renderSchemaMigration` 生成确定性 SQL 草稿（INSERT…ON CONFLICT DO UPDATE promoted=1 / UPDATE … SET field / DELETE），字符串做单引号转义，**只渲染不执行**。

### infra（`src/infra/sqlite/ontologyRepo.ts`，追加，不改已有签名）

- `listOntologyKeys(db): OntologyKeyRow[]`：取 `kind IN ('predicate','attr_key')` 全量（含 promoted=0），供 CLI 统计/待晋升展示。
- `loadRegisteredKeys(db): RegisteredKeyDef[]`：`promoted=1` 的键，供写通路做校验。
- `recordPendingKeys(db, entries, now)`：`INSERT … (promoted=0) ON CONFLICT(kind,name) DO UPDATE SET sample_count=sample_count+1, value_type=COALESCE(value_type, excluded.value_type)`；只增样本、不重置 promoted、不覆盖已有类型。

### 写通路接线

- `src/core/write/harvest.ts`：`UpsertDeps` 新增可选 `schema?: readonly RegisteredKeyDef[]`（缺省完全跳过校验，向后兼容，harvest 单测无需改）；`upsertFact` 在 `resolveEntity` **之前**用 `attrsFromDraft`（占位 entity_id）校验，失败抛 `E_SCHEMA`，此时一条 SQL 未发、不污染 entity/alias；事务提交后若有未登记键，调用 `recordPendingKeys` 记一次待晋升观测。`HarvestContext` 同步带 `schema`，`harvest()` 每轮用 `loadRegisteredKeys(db)` 加载一次（避免 N+1），`writeOne` 透传。
- `src/app/mcp/directWrite.ts`：`runDirectWrite` 在 `withTransaction` 前 `loadRegisteredKeys(deps.db)` 一次，`upsertFact` 传 `{blockOnConflict:true, schema}`；`E_SCHEMA` 原样上抛（仍只把 `E_CONFLICT_IDENTITY` 当隔离）。

### CLI（`src/app/cli/commands/schema.ts`，新建，导出 `schemaCommand`）

- `moshi schema validate [--snapshot <file>]`：分页扫 `fact`（`listFactsPage`，200/页）逐条校验；单行 JSON：`{command,ok,facts,registered_keys,violations(≤50),violation_count,violations_truncated,unregistered:[{key,count}],snapshot?}`；有违反 → 退出码 1，干净 → 0；`--snapshot` 用 `safeWriteFile` 落当前已登记 schema 快照（roots = data_dir/archive_dir/home）。
- `moshi schema diff --from <snapshot> [--to <snapshot>|current db] [--out <file>]`：`--from` 必填，缺省 → stderr + 2；`--to` 缺省用当前库快照；输出 added/removed/changed/unchanged + 迁移脚本（`--out` 落文件，否则内联 `script`）；任何情况都不执行 DDL。
- Lead 接线（一行 + import）：`src/app/cli/index.ts` 增加 `import { schemaCommand } from './commands/schema.js';`，并把 `schemaCommand` 加入 `COMMANDS` 数组。

### 测试（`tests/unit/schema-validate.test.ts`，新建，11 例）

- 校验：已登记 predicate/attr_key 类型不符 → 错误明细 + `E_SCHEMA` detail；`frozen` 多键 → 结构错误；显式基数性冲突 → 写库前抛 `E_SCHEMA` 且 fact/entity 计数均 0；合法已登记写入 → `created` 且无待晋升行。
- 待晋升：未登记 predicate/attr_key 放行 → ontology 两行 `promoted=false`、`value_type` 推断正确、`sample_count=1`；重复观测 → `sample_count=2`；`unregisteredKeys` 排序去重。
- 快照/diff：added/removed/changed 分类 + 渲染逐字节确定 + 含 INSERT/UPDATE/DELETE 且无 PRAGMA；快照往返解析 + 坏格式抛 `E_INPUT`；当前库快照只含 promoted=1。

## 验收

实际命令与输出（本机 2026-11-04 21:44–21:46）：

```
$ pnpm vitest run tests/unit/schema-validate.test.ts
 ✓ tests/unit/schema-validate.test.ts (11 tests) 177ms
 Test Files  1 passed (1)
      Tests  11 passed (11)

$ pnpm vitest run tests/unit/schema-infer.test.ts tests/unit/harvest.test.ts
 ✓ tests/unit/harvest.test.ts (15 tests) 1853ms
 ✓ tests/unit/schema-infer.test.ts (3 tests) 1277ms
 Test Files  2 passed (2)
      Tests  18 passed (18)

$ pnpm lint:lifecycle
✔ 生命周期写路径检查通过（93 个文件）
$ pnpm lint:deps
✔ 依赖方向检查通过（140 个模块，591 条内部依赖，5 条规则）
$ pnpm lint:writes
lint:writes OK — 93 个文件，无白名单外写调用
```

真库验收（`tools/seed-graph.ts --data .dsh/temp/p2-14/home/.moshi --facts 200 --edges 100` 灌种子，经 `tsx` 直调 `schemaCommand`；Lead 接线后等价于 `moshi schema …`）：

```
$ schema validate --snapshot …/snap-before.json
{"command":"schema validate","ok":true,"facts":200,"registered_keys":0,"violations":[],"violation_count":0,"violations_truncated":false,"unregistered":[{"key":"attr_key:seeded","count":200},{"key":"predicate:about","count":200}],"snapshot":"…/snap-before.json"}
exit=0

# 手工把 about 登记为 number（模拟晋升后误登记），再校验：
$ schema validate --snapshot …/snap-mid.json
{"command":"schema validate","ok":false,"facts":200,"registered_keys":2,"violations":[{"fact_id":"fact_seed_00000","key":"predicate:about","expected":"number","actual":"string"},…],"violation_count":200,"violations_truncated":true,"unregistered":[]}
exit=1

# 改成 string、加 installed_version、删掉 seeded 登记：
$ schema validate --snapshot …/snap-after.json
{"command":"schema validate","ok":true,"facts":200,"registered_keys":2,"violations":[],"violation_count":0,"violations_truncated":false,"unregistered":[{"key":"attr_key:seeded","count":200}]}
exit=0

$ schema diff --from …/snap-mid.json --to …/snap-after.json --out …/migration.sql
{"command":"schema diff","from":"…/snap-mid.json","to":"…/snap-after.json","generated_at":"2026-11-04T13:46:00.762Z","added":[{"kind":"predicate","name":"installed_version","valueType":"string","cardinality":"single-valued"}],"removed":[{"kind":"attr_key","name":"seeded","valueType":"bool","cardinality":null}],"changed":[{"kind":"predicate","name":"about","field":"value_type","before":"number","after":"string"}],"unchanged":0,"out":"…/migration.sql"}
exit=0
```

`migration.sql` 摘录（与输出一致，未执行）：

```sql
-- 默识 schema 迁移脚本草稿（由 `moshi schema diff` 生成，未执行）
INSERT INTO ontology (kind, name, value_type, cardinality, sample_count, distinct_values, single_ratio, registered_at, promoted)
VALUES ('predicate', 'installed_version', 'string', 'single-valued', 0, 0, NULL, '2026-11-04T13:46:00.762Z', 1)
ON CONFLICT(kind, name) DO UPDATE SET value_type = excluded.value_type, cardinality = excluded.cardinality, promoted = 1;

UPDATE ontology SET value_type = 'string' WHERE kind = 'predicate' AND name = 'about';

DELETE FROM ontology WHERE kind = 'attr_key' AND name = 'seeded';
```

`pnpm typecheck` 当前还剩一条报错，但**不在 P2-14 任何文件**，是并发任务 P2-24（证据链）的 WIP：

```
src/app/http/server.ts(88,45): error TS1361: 'TraceStore' cannot be used as a value because it was imported using 'import type'.
```

（`git diff src/app/http/server.ts` 显示该文件由 P2-24 新增 `traceStore` 接线，非本任务改动。P2-14 初版在 `harvest.ts` 引入的 TS2322 已修复；上述 5 个 lint/测试命令全部通过。需 Lead 等 P2-24 落定后统一复跑 `pnpm typecheck` / `verify` / `build`。）

## 决策与遗留

- **D-P2-14-1（已登记判据）**：只有 `promoted=1` 的 ontology 行参与校验；`promoted=0` 的待晋升行不约束写入。否则首个观测值会把类型锁死，等于用一次误差换永久 schema。
- **D-P2-14-2（待晋升记录位置）**：待晋升观测放在 `upsertFact` 事务提交之后（`recordPendingKeys`），而非 harness 层——两条写通路（harvest / MCP 直写）自动覆盖，且不建新表（复用 ontology，sample_count 累加）。
- **D-P2-14-3（快照口径 / diff 分类）**：快照只含 `promoted=1` 键，因此一次晋升（0→1）在两次快照间表现为 `added`；未把 `promoted` 放进快照字段（放进去也无法从「只含已登记键」的快照间稳定表达）。`changed` 只比对 `value_type`/`cardinality`。
- **D-P2-14-4（基数性校验时机）**：atrs 不携带基数性，仅当 `FactDraft.cardinality` 显式声明且与登记值不同才报错；否则按值类型校验即可，避免误伤 series/single-valued 的正常单条写入。
- **范围例外（需 Lead 知悉）**：`src/infra/sqlite/ontologyRepo.ts` 不在 task-3 声明的 writeScopes 内，但 `lint:lifecycle` 禁止 core/app 直接持 db/拼 SQL，注册键读取与待晋升写入只能在 infra 落地，故追加了三个只增不改的导出。请 Lead 在验收时把该文件纳入本任务改动集。
- **遗留 1**：`schema infer` 只产出 predicate 待晋升，`attr_key` 目前只有「写入观测」没有「晋升判定」；等后续节点把 §8.5 的 attr_keys 统计补进 infer 后，可直接复用 `recordPendingKeys`/`loadRegisteredKeys`。
- **遗留 2**：`schema diff` 的迁移脚本是草稿，不给执行入口（按任务卡不执行 DDL）；真正执行仍走人工复核。
- 未新增 TODO/FIXME；未改台账、未改 `src/app/cli/index.ts`、`src/app/http/server.ts`、`src/app/main.ts`。
