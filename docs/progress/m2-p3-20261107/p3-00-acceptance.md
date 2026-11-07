# P3-00 验收标准

验收者只读 repo、独立执行；不得修改实施者文件；结论写 PASS/FAIL + 证据。

## AC-1 文档

- `docs/详设.md` §4.5 的 16 维表完整：0–5 one-hot、6 weight、7 confidence、8 hop、9 方向、10–15 保留恒 0；顺序与 `ETYPE` 一致。
- 无 TBD/占位；白名单（允许/禁入字段）写明。

## AC-2 TS 实现

- 新增 `src/domain/edgeFeatures.ts`，导出 `EDGE_FEAT_DIM=16`、`edgeFeatures`、`edgeFeaturesPadded`（或等价）。
- 6 种 etype one-hot 正确；weight/confidence clamp；hop 1→0.5、2→1.0、null→0；direction +1/-1/0；reserved 全 0。
- padding 到 192 全 0；超过 192 截断；不读 DB、不依赖 sidecar。

## AC-3 契约

- `sidecar/tests/test_contract.py` 存在骨架，能独立运行（pytest），断言 `edge_attr` 形状 `(1,192,16)` 与 padding 全 0。
- P3-00 不要求完整 Node→Python 子图契约（P3-01 做）；但测试不得 skip 或空断言。
- 不依赖 `features.py`/model。

## AC-4 单测

- `tests/unit/edgeFeatures.test.ts` 覆盖 AC-2 全部维度与 padding/截断/白名单。
- 测试不与现有 `subgraph.test.ts` 冲突；不改 `src/core/read/subgraph.ts` 行为。

## AC-5 工程门禁

- `pnpm verify` 全绿；`pnpm build` 0；`git diff --check` 无错误。
- Python 契约测试可运行（环境缺 pytest 时记录命令与原因，不判 FAIL；但文件必须无语法错误，`py_compile` 通过）。

## AC-6 交付

- 实施者更新 `docs/progress/p3-00-progress.md`：改动文件、测试命令/结果、契约样例路径。
- 报告 commit 前 diff 范围；不得自行 commit/push。
- 验收者独立复跑关键测试，报告 PASS/FAIL、AC 逐项、证据路径。
