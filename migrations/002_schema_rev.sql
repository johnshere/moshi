-- 002：schema_rev 补齐 UPDATE / DELETE / 边 / 社区 的递增（台账 P1-25）
--
-- 001 里只有 trg_rev_fact_ins：AFTER INSERT ON fact。
-- 于是这些"库已经变了"的路径都不推高 schema_rev：
--   - 改一条事实的 confidence / epistemic_status / valid_to（生命周期后半段全靠 UPDATE）
--   - 删事实
--   - 增删边（PPR 与子图全变，缓存却还命中）
--   - 重算社区摘要（归档主题的输入变了）
-- 缓存（§6.11）与派生投影（ontology / community / archive）都拿 schema_rev 当新鲜度判据，
-- 漏推就等于"永不失效"。
--
-- fact 的 UPDATE 触发器带 WHEN 白名单：degree 回写（trg_degree_ins/del）也会 UPDATE fact，
-- 它不该算"内容变了"，否则每加一条边要推两次 rev。

CREATE TRIGGER trg_rev_fact_upd AFTER UPDATE ON fact
WHEN NEW.content IS NOT OLD.content
  OR NEW.confidence IS NOT OLD.confidence
  OR NEW.epistemic_status IS NOT OLD.epistemic_status
  OR NEW.valid_at IS NOT OLD.valid_at
  OR NEW.valid_to IS NOT OLD.valid_to
  OR NEW.pool IS NOT OLD.pool
  OR NEW.scope IS NOT OLD.scope
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_fact_del AFTER DELETE ON fact
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_edge_ins AFTER INSERT ON edge
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_edge_upd AFTER UPDATE ON edge
WHEN NEW.src IS NOT OLD.src
  OR NEW.dst IS NOT OLD.dst
  OR NEW.etype IS NOT OLD.etype
  OR NEW.valid_to IS NOT OLD.valid_to
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_edge_del AFTER DELETE ON edge
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_community_ins AFTER INSERT ON community_summary
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_community_upd AFTER UPDATE ON community_summary
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_community_del AFTER DELETE ON community_summary
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;
