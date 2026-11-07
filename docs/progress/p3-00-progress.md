# P3-00 进度

状态：DONE（独立验收 PASS，AC-1..AC-6 全过；2026-11-07 16:27）
实施：impl-contract
验收：verify-contract

## 已完成

- 设计 `docs/progress/m2-p3-20261107/p3-00-design.md`
- 验收 `docs/progress/m2-p3-20261107/p3-00-acceptance.md`
- 16 维边特征 TS 实现 `src/domain/edgeFeatures.ts`
- TS 单测 `tests/unit/edgeFeatures.test.ts`（36 个用例）
- 跨语言契约 fixture `tests/fixtures/edge-features.json`（2 条边：depends_on / co_occur）
- Python 契约骨架 `sidecar/tests/test_contract.py`（5 个用例）
- `docs/详设.md` §4.5 只更新状态说明（16 维表与数字未改）

## 实现要点

- `EDGE_FEAT_DIM=16`、`EDGE_RESERVED_FROM=10`、`EDGE_PAD_MAX=192`。
- 0–5 为 `ETYPE` 顺序 one-hot；6 weight、7 confidence clamp 到 [0,1]；8 hop（1→0.5、2→1.0、null→0）；9 direction（+1/−1/0）；10–15 恒 0。
- `edgeFeatures()` 纯函数，不读 DB、不查边；`direction` 由调用方（P3-01）换算后传入。
- 运行时白名单：入参只允许 `etype/weight/confidence/hop/direction`，多传 `strength/pool/access_count/last_access_at/archive_meta/layout/community_summary` 等字段抛 `E_INPUT`；未知 etype、非有限 weight/confidence、非法 hop/direction 同样抛 `E_INPUT`。
- `edgeFeaturesPadded(edges, maxEdges=192)` 不足补 0、超长截断、空输入也返回 192 行全 0（契约形状不随边数变化）。
- Python 骨架不依赖 `features.py`/`model.py`：读同一 fixture 的逐边行，padding 成 `(1,192,16)` 并断言形状、padding 全 0、16 维布局；P3-01 再把构造器换成 Node 真实 payload。

## 改动文件

新增：

- `src/domain/edgeFeatures.ts`
- `tests/unit/edgeFeatures.test.ts`
- `tests/fixtures/edge-features.json`
- `sidecar/tests/test_contract.py`

修改：

- `docs/详设.md` §4.5 状态说明（`> **状态：…` 一行；16 维表内容与数字未动）
- `docs/progress/p3-00-progress.md`（本文件）

未碰：`src/core/write/conflict.ts`、`src/core/write/harvest.ts`、`src/infra/sqlite/adjudicationRepo.ts`（I-49 并行 WIP），`src/core/read/subgraph.ts`（P3-01 再做），未建 model、未写 `features.py` 的 522 维。

## 测试命令与结果

在仓库根目录执行：

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/unit/edgeFeatures.test.ts` | 36 passed（1 file） |
| `pnpm verify` | exit 0；typecheck / typecheck:ui / lint:deps / lint:lifecycle / lint:writes / lint:archive 全过；`Test Files 119 passed (119)`、`Tests 1456 passed (1456)`（含并行 I-49 的 11 个用例） |
| `pnpm build` | exit 0（UI vite build + tsc + copy-assets） |
| `sidecar/.venv/Scripts/python.exe -m py_compile sidecar/tests/test_contract.py` | exit 0 |
| `sidecar/.venv/Scripts/python.exe -m pytest sidecar/tests/test_contract.py -q` | `5 passed in 0.14s`（Python 3.13.7 / pytest 9.2.0 / numpy 2.5.4） |
| `npx eslint src/domain/edgeFeatures.ts tests/unit/edgeFeatures.test.ts` | exit 0 |
| `git diff --check` | exit 0（新文件另查无行尾空白） |

## 契约样例路径

- `tests/fixtures/edge-features.json`（TS 单测与 Python 契约测试共用）
  - `schema="moshi-edge-features/1"`、`dim=16`、`max_edges=192`
  - 2 条边：`depends_on`（hop=1、direction=1、conf=0.7）与 `co_occur`（hop=null、direction=0、conf=0.9）
  - `expected` 行由 `edgeFeatures()` 实算生成，TS 单测逐维复现；Python 侧据此 padding 并断言 `(1,192,16)` 与 padding 全 0。

## 未决 / 风险

- `EDGE_PAD_MAX=192` 与 `src/core/read/subgraph.ts` 的 `MAX_EDGES=192` 当前是两处常量；本卡不改 subgraph.ts，P3-01 组装子图 JSON 时以契约为准并对齐。
- Python 契约骨架目前从 fixture 构造 padding，尚未消费 Node 真实 payload——按设计属 P3-01 范围。
- `EdgeFeatureInput.weight` 为必填（沿用设计接口）；“缺省 1.0”由边存储/调用方保证。
- `pytest` 不在 `pnpm verify` 链路内，需用 sidecar venv 单独运行；本机 venv 可用。
- 未 commit / push；`git status` 中 I-49 并行改动的文件不属于本卡 diff。
