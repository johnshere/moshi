# P2-22 边抽取（轨迹 / 共现 / 取代）施工记录

- 起止：2026-11-02 08:31 ~ 08:41（接 P2-21 之后连续施工）
- 依据：台账 §4 P2-22、详设 §5.12.6（doc:1917-1928）

## 目标

事实落库后按四条规则自动长出边，否则 Phase 2 验收的「两遍扫描后 edge 计数不变」永远空转（P2-21 收口时 edge 表增长为 0）。

## 开工前的事实核查

- `migrations/001_init.sql:131` 已有 `edge` 表与 `idx_edge_active`（`(src,dst,etype) WHERE valid_to IS NULL` 唯一）→ 幂等天然有底，缺的是抽取逻辑和 provenance。
- 台账说建 `003_edges.sql`，但 003 被 P2-20 的 `003_protocol.sql` 占着 → 改 `004_edges.sql`，`TARGET_VERSION` 3→4（记入 D-70）。
- `fact.attrs.frozen` 才有 subject/predicate（`canonical_key` 是哈希反解不出）→ 规则必须走 `json_extract`。
- `lint:lifecycle` 禁止 core 持有 db 句柄 → 候选查询必须放 `factRepo`。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `migrations/004_edges.sql` | `ALTER TABLE edge ADD COLUMN provenance TEXT` + `idx_edge_provenance` |
| `src/infra/sqlite/migrate.ts` | `TARGET_VERSION` 3→4 |
| `src/infra/sqlite/edgeRepo.ts` | `NewEdge.provenance`，INSERT 带列 |
| `src/infra/sqlite/factRepo.ts` | 新增 `FactRef` 与四个候选查询 |
| `src/infra/sqlite/mappers.ts` / `src/domain/types.ts` | `Edge.provenance` |
| `src/core/write/edges.ts`（新） | 四条规则 + 配额 + 去重 |
| `src/core/write/harvest.ts` | `applyEdges()`，`HarvestResult.edges` |
| `tests/unit/edges.test.ts`（新） | 11 例 |

## 规则映射（详设是 turn 层语言，事实层重述）

| 规则 | 事实层判定 | etype | 置信 |
| --- | --- | --- | --- |
| 工具序列 | 同 episode、`confidence_source='tool_obs'`、`valid_at` 相邻且差 ≤5 min | `depends_on` | 0.7 |
| 过程步骤 | `attrs.ext.steps[]` 相邻项按 subject 名解析到同 episode 事实 | `depends_on` | 0.85 |
| 同实体共现 | 同 `frozen.subject.entity_id`、`valid_at` 差 ≤1h | `co_occur` | 0.5（weight 按距离衰减） |
| 时间序取代 | 同 entity+predicate，旧值 `valid_to` 非空且更早 | `supersedes` | 0.9 |

配额：依赖边（工具序列 + 过程步骤）共用 2 条、共现 5 条，按候选时间距离截断；`supersedes` 不占配额且只连最近一条（避免旧值链）。

## 踩到的坑

1. `sed` 式的 -replace 把 `frozenSubjectName()` 的函数体削掉一半，留下孤立的 `const subject ...` 与多余 `}` → tsc `TS1128`、esbuild `Unexpected "}"`。逐段重写比正则整块替换安全。
2. `source_episode` 有 FK，测试夹具裸插 episode 必须先建父行（`insertIfAbsent` 自己生成 id，用不了固定 `ep_1`）。
3. 工具序列规则只看"对方是不是 tool_obs"会把 `llm_claim` 事实也连上去，抢走 2 条依赖配额 → 必须同时要求 `fact.confidenceSource === 'tool_obs'`。
4. `factRepo` 返回 camelCase，残留 `peer.valid_at` 静默变成 `undefined`（`msOf` 兜成 0），不会报错但边全错 → 类型检查兜住（`CandidateRow = FactRef`）。
5. 候选查询放 core 触发 4 处 `no-raw-db-handle` → SQL 全下沉 `factRepo`。

## 验收

```
pnpm verify  → 53 files / 615 tests 全绿
pnpm build   → 通过
tests/unit/edges.test.ts → 11 passed
```

覆盖：四规则各命中/不命中、配额截断、同批两遍零新增（活跃唯一）、10 条新事实 → 4 条边（≥3 的验收口径）。

## 留给后面的

- 精度抽样 20 条 ≥80%（§4 验收第三项）没有真实库样本，靠规则确定性单测间接覆盖；等 P2-23/P3 有真实 LLM 输出后再抽。
- `co_occur` 只进图扩展不进答案（台账「坑」），检索侧的过滤在 P3 做。
- `logic` / `mutually_exclusive` / `derived_from` 三种 etype 属 P1-24 裁决与 P3 推理支路，本次未产出。
