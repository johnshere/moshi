-- 003：采集协议 v1（P2-20）
-- 给 annotation 增加 origin 字段，区分埋点/归纳/直写/解析器来源。

ALTER TABLE annotation ADD COLUMN origin TEXT;
CREATE INDEX idx_annotation_origin ON annotation(origin) WHERE origin IS NOT NULL;
