-- ============ P2 接入层：query_log 带上「谁在用」 ============
-- 一行 query_log 就是一次召回：以前只知道「查了什么」，不知道「谁查的」。
-- 接入点会越来越多（Magpie 钩子、MCP、CLI、UI、eval、导入），日志页要按接入点
-- 分组统计，必须把这层身份落到行上。
--
-- 全部可空：迁移前的历史行保持 NULL（界面显示「未标注（历史）」），
-- 不回填、不猜测——猜错比留空更贵。
--
-- caller_kind 是枚举的落库形态（gateway/mcp/cli/ui/eval/import/unknown），
-- caller_id 是 `<kind>:<product>:<instance>`，两者都建索引供日志页按接入点分页。
ALTER TABLE query_log ADD COLUMN caller_id   TEXT;
ALTER TABLE query_log ADD COLUMN caller_kind TEXT;
ALTER TABLE query_log ADD COLUMN plugin_id   TEXT;
ALTER TABLE query_log ADD COLUMN corr_id     TEXT;
ALTER TABLE query_log ADD COLUMN status      TEXT;
ALTER TABLE query_log ADD COLUMN in_bytes    INTEGER;
ALTER TABLE query_log ADD COLUMN out_bytes   INTEGER;

CREATE INDEX idx_query_log_caller_ts ON query_log(caller_id, ts);
CREATE INDEX idx_query_log_kind_ts   ON query_log(caller_kind, ts);
CREATE INDEX idx_query_log_corr      ON query_log(corr_id);
