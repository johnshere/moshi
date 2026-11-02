-- ============ P2-23 直写闸门 ============
-- 直写（`mcp.allow_direct_write = true` 且调用方要求落库）绕过了 harvest 的入队缓冲，
-- 所以每一行都必须自带「是谁、哪一轮、哪一批」写进来的——否则概设 §3.1.3③ 的
-- 「按批次整批撤销」无从下手，撤销时也无法只删直写的行而不碰别的来源。
--
-- 只加列不改表：列全部可空，历史行保持 NULL = "不是直写来的"，语义天然区分。

ALTER TABLE fact       ADD COLUMN origin     TEXT;
ALTER TABLE fact       ADD COLUMN session_id TEXT;
ALTER TABLE fact       ADD COLUMN turn       INTEGER;
ALTER TABLE fact       ADD COLUMN batch_id   TEXT;

ALTER TABLE edge       ADD COLUMN batch_id   TEXT;

-- 直写路径同时留一条 annotation 作快照（harvest 不会再消费它），撤销时连带回滚
ALTER TABLE annotation ADD COLUMN batch_id   TEXT;

-- 撤销按批次号整体扫，三个部分索引够用；不建唯一约束（一批多行）
CREATE INDEX idx_fact_batch       ON fact(batch_id)       WHERE batch_id IS NOT NULL;
CREATE INDEX idx_edge_batch       ON edge(batch_id)       WHERE batch_id IS NOT NULL;
CREATE INDEX idx_annotation_batch ON annotation(batch_id) WHERE batch_id IS NOT NULL;
