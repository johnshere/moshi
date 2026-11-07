# P3-02 特征张量化与 padding（进度）

状态：DONE（2026-11-07）
依据：任务详述 P3-02；详设 §4.5 / §7.2；决策 D-153（契约升 `/2` + `edge_attr` 入 payload）、D-154（direction 规则）、D-155（hop 来自 BFS 层数）。

## 决策（实施前已与用户确认，用户回「1」）

| # | 决策 | 内容 |
| --- | --- | --- |
| D-153 | 边特征来源 = Node 组装 | `moshi-subgraph/2` 的 `edges[]` 增加 `edge_attr: number[16]`，由 Node 调 `edgeFeatures()` 计算；Python 只校验 + padding，不重写 16 维规则 |
| D-154 | `direction` 规则 | 有向 etype（`depends_on`/`supersedes`/`derived_from`）按 `dst` 下标 > `src` 下标取 +1，否则 −1；无向 etype（`logic`/`mutually_exclusive`/`co_occur`）取 0 |
| D-155 | `hop` 来源 | `core/read/subgraph.ts` 的 BFS 层数（第一层扩展 = 1 跳，第二层 = 2 跳）；`SubgraphEdge` 增加 `hop: 1 \| 2` |

## 改动清单

- [x] `src/core/read/subgraph.ts`：`SubgraphEdge.hop`
- [x] `src/domain/subgraph.ts`：schema → `/2`；`SubgraphEdgeInput.hop`；payload 边 `edge_attr`
- [x] `tests/fixtures/subgraph-contract.json`：版本 + `edge_attr`
- [x] `tests/unit/subgraphContract.test.ts`：断言同步 + 新增用例
- [x] `sidecar/moshi_sidecar/features.py`：常量 + `build_node_features` / `build_edge_attr` / `build_batch`
- [x] `sidecar/tests/test_features.py`
- [x] `sidecar/tests/test_contract.py`：schema /2 + `edge_attr` 契约
- [x] `docs/详设.md` §4.5 / §7.2；台账 §1/§3/§6；决策记录 D-153..155

## 验收（独立验收代理 PASS，AC-1..AC-8）

| 命令 | 读数 |
| --- | --- |
| `pnpm exec vitest run tests/unit/subgraphContract.test.ts` | 23 passed |
| `sidecar/.venv/Scripts/python.exe -m pytest sidecar/tests/test_features.py sidecar/tests/test_contract.py -q` | 32 passed |
| `pnpm verify` | 120 files / 1479 tests passed |
| `pnpm build` | exit 0 |

独立验收补充发现：代码注释/详设中的决策编号曾偏移为 D-152..154（D-152 已被 P1-01 占用），已统一为 D-153..155 并复核。
