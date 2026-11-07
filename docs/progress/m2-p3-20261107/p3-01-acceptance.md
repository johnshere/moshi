# P3-01 验收标准：子图契约与契约测试

状态：DESIGN_DONE（2026-11-07）
设计：`docs/progress/m2-p3-20261107/p3-01-design.md`
实现：impl-contract；独立验收：verify-contract（复用 verify-p1-16）
纪律：只读验收；不改仓库文件；不 commit/push；失败一次打回，二次失败终止。

## AC-1 payload 组装正确

- `src/domain/subgraph.ts` 导出 `SUBGRAPH_SCHEMA`、`NODE_FEAT_DIM = EMBED_DIM + 10 = 522`、`MAX_NODES=64`、`MAX_EDGES=192`、`buildSubgraphPayload`。
- 用 fixture 的输入构造 3 节点 2 边 payload：schema、query_vector、nodes（fact_id/embedding/ftype/confidence/importance/epistemic_status/degree）、edges（src/dst 为下标、etype/weight/confidence）、options 全部正确。
- 同一输入两次构造深相等；不读 DB、无副作用。

## AC-2 非法输入

以下均抛 `MoshiError('E_INPUT')`，文案含字段名：

- 节点 0 条或 >64；边 >192；重复 `factId`。
- `embedding` 非 null 且长度≠512 / 含 NaN/Infinity；`queryVector` 同。
- 边引用不存在的 factId；`confidence`/`importance`/`weight` 非有限数；`degree` 负数/非整数。
- 未知 ftype/epistemicStatus/etype。

## AC-3 Node 侧一致性

- `tests/unit/subgraphContract.test.ts` 至少 8 个用例：字段、下标、options、非法输入、与 fixture 深相等、`NODE_FEAT_DIM`。
- fixture `tests/fixtures/subgraph-contract.json` 存在，3 节点 2 边，`node_feat_dim=522`；TS 输出与 fixture 的 `payload` 深相等。

## AC-4 Python 契约

- `sidecar/tests/test_contract.py` 保留 P3-00 的 5 个边契约用例，新增节点契约用例，总数 ≥8。
- 读取同一 fixture，构造参考 522 维：`x.shape==(1,64,522)`、`mask.sum()==3`、`edge_index.shape==(2,192)`、`edge_mask.sum()==2`、`NODE_FEAT_DIM == fixture['node_feat_dim'] == 522`。
- 节点 padding 行全 0；边 padding 列全 0；`mask` 仅 0/1；`edge_index` 真实列指向有效节点。
- 缺失 embedding 的参考规则（零向量 + confidence 折半）、`disputed→active`、degree `log1p/ log1p(64)` clamp 有断言。
- 不 skip、不空断言；不依赖 `features.py`/`model.py`（P3-02 才落地）。

## AC-5 不改越界

- 不改 `src/core/read/subgraph.ts`、`src/domain/edgeFeatures.ts` 的既有语义、冲突/裁决/EVAL/sidecar 协议。
- 不新增 `features.py`/`model.py`；不读 `fact_vec`/真实 `~/.moshi`。
- diff 仅 P3-01 约定文件 + 进度/台账。

## AC-6 工程门禁

- `pnpm exec vitest run tests/unit/subgraphContract.test.ts` 全过。
- `sidecar/.venv/Scripts/python.exe -m pytest sidecar/tests/test_contract.py -q` 全过。
- `pnpm verify`、`pnpm build`、`git diff --check`、`python -m py_compile sidecar/tests/test_contract.py` 全过。
- 记录实际用例数与退出码。

## AC-7 文档

- `docs/progress/p3-01-progress.md` 含状态、改动文件、测试命令/结果、未决风险、未 commit 声明。
- 不伪造通过；若 Python 契约只能读 fixture 而非 Node 运行产物，必须在报告中明确边界（设计允许 fixture 作为两侧共享契约，但 TS 侧必须证明由 `buildSubgraphPayload` 生成）。
