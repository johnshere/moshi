# P3-01 进度

状态：DONE（独立验收 PASS，AC-1..AC-7；commit 0bc52c7）
实施：impl-contract
验收：verify-contract（复用 verify-p1-16）
设计：`docs/progress/m2-p3-20261107/p3-01-design.md`
验收标准：`docs/progress/m2-p3-20261107/p3-01-acceptance.md`

## 已完成

- `src/domain/subgraph.ts`：`moshi-subgraph/1` payload 组装 + 校验（纯函数，不读 DB）。
- `tests/fixtures/subgraph-contract.json`：3 节点 2 边契约 fixture（含测试专用 `node_feat_dim=522`）。
- `tests/unit/subgraphContract.test.ts`：20 个用例（组装/下标/options/确定性/无副作用/fixture 深相等/非法输入/clamp/上限边界）。
- `sidecar/tests/test_contract.py`：保留 P3-00 的 5 个边契约用例，新增 9 个节点契约用例，共 14 个。
- 未 commit / push。

## 实现要点

### TS（`src/domain/subgraph.ts`）

- 常量：`SUBGRAPH_SCHEMA='moshi-subgraph/1'`、`NODE_FEAT_DIM=EMBED_DIM+10=522`、`MAX_NODES=64`、`MAX_EDGES=EDGE_PAD_MAX=192`（边上限与边特征 padding 同源，不再重复写 192）。
- `buildSubgraphPayload({queryVector, nodes, edges, options?})`：
  - `edges.src/dst` 由 fact_id 映射为 `nodes` 输入顺序下标；fixture/测试证明节点换序时下标跟着换。
  - `options` 默认 `{self_attn:false, cross_attn:true}`，显式值可覆盖。
  - payload 不含 `node_feat_dim`（测试元数据只在 fixture 顶层）。
  - 不读 DB、不读 `fact_vec`、不做 L2 归一化；embedding/queryVector 复制成新数组，入参无副作用，两次构造深相等。
- 非法输入统一 `MoshiError('E_INPUT')` 且文案含字段名：
  - 节点 0 / >64、边 >192、重复或空白 factId；
  - embedding/queryVector 非 null 且长度≠512、含 NaN/Infinity；
  - confidence/importance/weight 非有限数；degree 负数/非整数；
  - 未知 ftype/epistemicStatus/etype；边引用不存在的 factId；options 非布尔。
- `confidence`/`importance`/`weight` clamp 到 `[0,1]`；`degree` 原样保留（归一化在 Python 侧）。

### fixture（`tests/fixtures/subgraph-contract.json`）

- 顶层 `{schema:'moshi-subgraph/1', node_feat_dim:522, payload:{...}}`；`payload` 是正式 payload。
- 3 节点：semantic/active/degree 4、episodic/archived/degree 2、conditional/disputed/degree 0；embedding 为固定 512 维单位向量（下标 0=0.6、1=0.8；下标 0=0.8、1=-0.6；下标 1=0.6、2=0.8；L2 范数=1）。
- 2 边：`0→1 depends_on weight 1.0 conf 0.7`、`1→2 co_occur weight 1.0 conf 0.9`。
- `query_vector:null`、`options {self_attn:false,cross_attn:true}`。
- 由 `buildSubgraphPayload` 生成落盘；TS 单测用独立硬编码输入重新组装并与 `payload` 深相等——fixture 不是唯一事实来源。

### Python（`sidecar/tests/test_contract.py`）

- P3-00 边契约 5 例原样保留（改的只是共用的 fixture 路径常量名与模块 docstring）。
- 新增 9 个节点契约用例，测试内参考实现（不建 `features.py`/`model.py`）：
  - 522 维拼接：`[0,512)` embedding、`[512,515)` ftype one-hot、`[515]` confidence、`[516]` importance、`[517,521)` epistemic one-hot（disputed→active）、`[521]` `log1p(degree)/log1p(64)` clamp 到 1。
  - 缺失 embedding：零向量 + confidence 折半（用 fixture 副本构造，断言同时验证未缺失节点不折半）。
  - padding/掩码：`x (1,64,522)`、`mask (1,64)` 且 sum=3、`edge_index (2,192)`、`edge_mask (1,192)` 且 sum=2；节点 padding 行全 0、边 padding 列全 0；mask 仅 0/1；真实边列指向有效节点。
  - `NODE_FEAT_DIM == fixture['node_feat_dim'] == 522`；fixture embedding 单位范数。
- 不 skip、不空断言；无 skip/xfail。

## 契约边界（重要）

- Python 侧读的是**两侧共享 fixture**，不是 Node 运行时产物；TS 侧通过独立输入组装 + 与 fixture `payload` 深相等证明 fixture 确由 `buildSubgraphPayload` 生成。真实 Node→sidecar 端到端留给 P3-02/P3-03。
- 边特征 `edge_attr` 仍由 P3-00 的独立 fixture 验证；P3-01 payload 不含 `edge_attr`，组装层在 P3-02 接入。

## 测试命令与结果（本机实测）

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run tests/unit/subgraphContract.test.ts` | 20 passed（1 file），exit 0 |
| `sidecar/.venv/Scripts/python.exe -m pytest sidecar/tests/test_contract.py -q` | 14 passed（5 边 + 9 节点；Python 3.13.7 / pytest 9.2.0 / numpy 2.5.4），exit 0 |
| `pnpm verify` | exit 0；typecheck/typecheck:ui/lint:deps/lifecycle/writes/archive 全过；`Test Files 120 passed (120)`、`Tests 1476 passed (1476)` |
| `pnpm build` | exit 0（UI vite build + tsc + copy-assets） |
| `sidecar/.venv/Scripts/python.exe -m py_compile sidecar/tests/test_contract.py` | exit 0 |
| `git diff --check` | exit 0（新增文件另查无行尾空白） |
| `pnpm exec eslint src/domain/subgraph.ts tests/unit/subgraphContract.test.ts` | exit 0 |

## 改动文件

新增：

- `src/domain/subgraph.ts`
- `tests/fixtures/subgraph-contract.json`
- `tests/unit/subgraphContract.test.ts`

修改：

- `sidecar/tests/test_contract.py`
- `docs/progress/p3-01-progress.md`（本文件）

未改：`src/core/read/subgraph.ts`、`src/domain/edgeFeatures.ts`、`sidecar/moshi_sidecar/*`、`docs/详设.md`、冲突/裁决/EVAL/sidecar 协议。未读真实 `~/.moshi`/`fact_vec`。

## 未决 / 风险

- `MAX_EDGES` 在 `src/domain/subgraph.ts` 引用 `EDGE_PAD_MAX`（单一权威）；但 `src/core/read/subgraph.ts` 仍有自己的 `MAX_NODES/MAX_EDGES` 常量，本卡按边界未改；P3-02 接线时需保证组装层与 BFS 裁剪上限一致。
- 522 维参考实现只在测试文件内；P3-02 迁到 `sidecar/moshi_sidecar/features.py` 时以本文件为对照。
- fixture embedding 已 L2 归一化（设计 §5）；Node 侧只透传，Python 参考实现不做归一化——真实查询向量的归一化责任在 P3-02。
- `docs/详设.md` §4.5 状态行本轮未改（属 P3-00 落点，且 P3-01 边界不含详设）；其中“端到端契约尚待 P3-01/P3-02”在 P3-02 完成后应再收口。
- pytest 不在 `pnpm verify` 链路内，需用 sidecar venv 单独跑。
