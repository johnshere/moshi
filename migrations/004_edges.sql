-- 边抽取（P2-22 / 详设 §5.12.6）
--
-- 台账 §4 写的是 `003_edges.sql`，但 003 已被 P2-20 的 `003_protocol.sql` 占用，
-- 这里顺延为 004（见台账 §5.2 D-70）。
--
-- provenance 记录"这条边由哪条规则生成"，是边精度抽样的唯一依据：
--   rule:tool_seq / rule:procedure / rule:co_occur / rule:supersedes
ALTER TABLE edge ADD COLUMN provenance TEXT;

CREATE INDEX idx_edge_provenance ON edge(provenance);
