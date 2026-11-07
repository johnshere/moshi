# P1-19 m2 进度（同一 dev 库导出主题）

- 状态：BLOCKED（等 P1-20 PASS）
- 负责人：impl-p3a8（复用）
- 设计：`docs/progress/m2-p1-20261107/p1-19-design.md`
- 验收：`docs/progress/m2-p1-20261107/p1-19-acceptance.md`

## 已定方向

- 使用 P1-20 的同一份 `temp/moshi-dev`；不新建第二库、不换回 `~/.moshi`。
- 导出 ≥1 篇主题，满足现有 `fact_count≥8`、`chain≥0.5||mutex` 门槛。
- 不降门槛；0 篇只能补真实会话，仍 0 则 BLOCKED。

## 待填

- dev DB 哈希
- selectTopics 数 / 社区数 / 最大社区
- export 文件路径、大小、主题名、fact_count、community_id、chain/mutex
- eval temporal/refusal 通过数
- bench P50/P95/P99
- 源目录哈希
- commit（Lead 填）
