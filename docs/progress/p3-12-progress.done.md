# P3-12 Phase 3 验收 · 进度

状态：DONE（数据受限收口，2026-11-07 m2；D-166）

## 目标

跑通台账 §2 的 P3 验收命令：`moshi eval gate && moshi eval run --flags gat=on,gat=off`，
通过标准：双门槛达标 + 入包差异率 > 5% + golden 不退化；产出验收记录与第一份消融数据。

## 验收证据（dev 数据面 `temp/moshi-p3`，真实 `~/.moshi` 未动）

| 检查 | 读数 |
| --- | --- |
| `moshi eval gate` | `{"ok":true,"samples":{"current":582,"required":500},"density":{"current":32.94,"required":20,"window":200,"observed":200}}`，exit 0 |
| `adjudication` / `feedback` / `query_log` | 616（带 outcome 582）/ 3198 / 544 |
| golden `gat=off` | 32/32 |
| golden `gat=on` | 32/32（不退化） |
| 入包差异率 | **0.0%（32 题，阈值 5%，未达）**，exit 1 |

## 数据面构造

- `tools/seed-devdb.ts --sessions 120`：24 天 × 5 会话/天，6 包/日，同日两访同 repo 生成 upheld，四遍查询套件；
- 训练：`samples build` → `samples export` → `sidecar/train.py`（rank_samples 2442 ≥ 2000，λ 爬到 0.3）；
- 配置 `temp/moshi-p3.toml`（独立管道 `\\.\pipe\moshi-p3`，score 5s / encode 120s，仅本机验收）。

## 差异率 0% 的根因（有证据，转 P4-02 / I-57）

- 训练后的 δ 饱和于 `delta_cap=-0.15`，on/off 入包集合完全相同；
- 随机分批下同 query 正负对仅覆盖约 22% 的 batch，pairwise 项近乎失效；
- 分组批量对照实验（4 组/batch、20 epoch）pair loss 正常下降，但 focus δ 标签均值无分离（−0.069 vs −0.067）→ 合成反馈中无可学的相关性信号。

## 结论

gate、golden 不退化、差异统计机制均已交付并实测；入包差异率作为模型质量指标未达标，
按用户裁决记「数据受限通过」，第 3 项由 P4-02 消融 runner 用真实积累数据跟踪（D-166）。
