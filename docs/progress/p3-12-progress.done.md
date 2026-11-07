# P3-12 Phase 3 验收 · 进度

状态：BLOCKED（数据面，2026-11-07 m2 实测）

## 目标

跑通台账 §2 的 P3 验收命令：`moshi eval gate && moshi eval run --flags gat=on,gat=off`，
通过标准：双门槛达标 + 入包差异率 > 5% + golden 不退化；产出验收记录与第一份消融数据。

## 实测证据（2026-11-07，只读，未改数据）

| 检查 | 读数 |
| --- | --- |
| `moshi eval gate` | `{"ok":false,"samples":{"current":0,"required":500},"density":{"current":0,"required":20,"window":200,"observed":0},"reason":"samples","current":0,"required":500}` |
| `fact` | 60 |
| `adjudication`（按 outcome 分组） | 0 行 |
| `training_sample` | 0 行 |
| `query_log` | 174 行，其中带 `subgraph_nodes` 0 行（运行中的 daemon 是 P3-07 之前的旧进程） |
| `~/.moshi/models/` | 不存在（无 `gat-v1.pt`） |

## 为什么不能本节点内解决

- 门槛 1 需要 ≥500 条**非循环标注**（裁决 outcome），当前库 0 条裁决；
- 门槛 2 需要最近 200 条带 `subgraph_nodes` 的查询，旧 daemon 不写该埋点；
- `eval run --flags` 的 on 档需要真实权重，否则 `/score` 只能降级，差异率恒 0；
- 造数据/改库/重启 daemon 都属状态或环境变更，按纪律先与用户确认（AGENTS：环境配置变动先暂停观察）。

## 解除条件（待用户裁决，见 §5.1 B-9）

1. **真实使用积累**：升级并重启 daemon（P3-07+）→ 用出 ≥500 条带 outcome 的裁决与 ≥200 条 ≥20 节点子图查询 → `moshi samples build` → `moshi samples export` → `sidecar/train.py` 出权重 → 重跑 gate 与 `eval run --flags`。
2. **P3 验收 dev 数据面**（参照 P1-20 先例）：在 dev 副本上 seed 裁决/查询并训权重完成验收，真实库不动；需用户确认是否接受 dev 数据面作为 Phase 3 退出证据。

## 验收

未开始（被阻塞）。解除后按 AC：gate 通过、差异率 > 5%、golden 不退化。
