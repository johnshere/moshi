# P4-02 消融 runner（七项）· 进度

状态：DONE（2026-11-07 m2；独立验收 AC-1..AC-9 PASS）

## 目标

`moshi eval ablations`：七项消融各产出对比数据（gat / self_attn / cross_attn / vector / bm25 / ppr / 结构化vs扁平），每项只变一个开关。

## 口径

- 基线 = 该开关的“完整/默认”状态，变体只动该开关：gat（off→on）、self_attn（off→on）、cross_attn（on→off）、vector/bm25/ppr（on→off）、structured（结构化→扁平）。
- self_attn / cross_attn 两侧都 `gat=on`，保证只有该开关变化。
- 指标：golden 通过数（按题型）、入包差异率、P95 延迟。
- 结构化 vs 扁平：判题仍按 fact 期望；扁平 = 清空 `dependency_summary` / `conflicts`，等价于只给平铺事实列表。
- 每次运行独立复制库：`gat=on` 会按 δ 写回置信（P3-08），共用库会让前一项污染后一项基线；空库也在临时目录建空 base，不写用户库。
- 数据面沿用 `temp/moshi-p3.toml`（真实 `~/.moshi` 不动）。

## 实施清单

- [x] `SearchRuntime` 增加 `channels` / `modelOptions`；`flags_json` 如实记录
- [x] `subgraph-payload` 透传 self_attn / cross_attn
- [x] sidecar `/score` 支持 `cross_attn=false`（不传 query_vector）
- [x] `core/ops/ablation.ts`：七项定义 + 汇总 + 表格
- [x] `moshi eval ablations` CLI + 单测（7 passed）
- [x] pytest `test_score.py` 8 passed（新增 cross_attn 用例）
- [x] `pnpm verify` 129 files / 1562 tests 全绿；`pnpm build` exit 0
- [x] 独立验收（免费模型子代理）：AC-1..AC-9 全 PASS

## dev 数据面实测（32 题；`temp/moshi-p3.toml`，2026-11-07）

| axis | 变化 | 通过 | 单跳 | 多跳 | 时态 | 拒答 | P95ms | 入包差异 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gat | off → on | 32→32 | 8→8 | 8→8 | 8→8 | 8→8 | 38→55 | 1.2% |
| self_attn | off → on（均 gat=on） | 32→32 | 8→8 | 8→8 | 8→8 | 8→8 | 58→55 | 0.0% |
| cross_attn | on → off（均 gat=on） | 32→32 | 8→8 | 8→8 | 8→8 | 8→8 | 54→56 | 0.0% |
| vector | on → off | 32→32 | 8→8 | 8→8 | 8→8 | 8→8 | 33→16 | 11.1% |
| bm25 | on → off | 32→32 | 8→8 | 8→8 | 8→8 | 8→8 | 34→31 | 0.0% |
| ppr | on → off | 32→32 | 8→8 | 8→8 | 8→8 | 8→8 | 34→24 | 3.1% |
| structured | 结构化 → 扁平 | 32→24 | 8→8 | 8→0 | 8→8 | 8→8 | 31→34 | - |

降级题次：`no_model` 集中在 8 道拒答题的空子图（`nodes≥1` 才打分）；`no_vector` 为低相似/拒答，属既有降级口径；`no_ppr` 偶发超时。

## 数据解读边界（重要）

- 三项模型消融（gat / self_attn / cross_attn）的通过数与入包差异**不能作为结构开关有效性的结论**：8 道拒答题空子图两侧都没真正过模型，且当前权重 δ 饱和于 −0.15（D-166 / I-57）。它们只证明 runner 可跑通、数据可产出。
- 检索类三项（vector / bm25 / ppr）与 structured 项是真实生效的对比。
- 后续用真实积累数据重训后再跑本命令，才用于 P4-05 质量基线判断。
