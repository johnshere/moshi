-- moshi:foreign_keys_off
-- ============ V-05 Fact 语义分层 ============
-- 只扩 fact 的语义/生命周期字段，不拆表：
--   ftype 增加 procedural；新增 retention_class / volatility / admission_reason /
--   ttl_seconds / source_kind / recheck_kind / expired_at。
--
-- ftype 的 CHECK 不能原地扩值，所以重建 fact 表。仓库迁移仍旧只增不改；
-- 这个迁移在空库与已有数据的库上都必须能跑（测试库会被整库重建，但单测会造
-- v5 带数据的库来验证迁移）。
--
-- 依赖顺序：先删引用 fact 的触发器/视图，再建新表、复制、替换，最后重建索引/
-- 触发器/视图。fact_fts 只按 fact_id 关联，不引用 fact 表，不需要重建。

DROP TRIGGER IF EXISTS trg_fact_content_immutable;
DROP TRIGGER IF EXISTS trg_fact_frozen_immutable;
DROP TRIGGER IF EXISTS trg_rev_fact_ins;
DROP TRIGGER IF EXISTS trg_rev_fact_upd;
DROP TRIGGER IF EXISTS trg_rev_fact_del;

DROP VIEW IF EXISTS v_fact_degree;
DROP VIEW IF EXISTS v_active_fact;
DROP VIEW IF EXISTS v_orphan_ratio;

CREATE TABLE fact_new (
  id                TEXT PRIMARY KEY,
  content           TEXT NOT NULL,
  ftype             TEXT NOT NULL CHECK (ftype IN ('semantic','episodic','procedural','conditional')),

  -- V-05 正交分层：与 ftype 不混轴；NULL = 未分类（历史行/待回填）
  retention_class   TEXT CHECK (retention_class IN ('durable','event','cache','session')),
  volatility        TEXT CHECK (volatility IN ('static','slow','volatile','historical')),
  admission_reason  TEXT CHECK (admission_reason IN ('non_rederivable','expensive',
                                                     'context_needed','human_intent',
                                                     'cross_object')),
  ttl_seconds       INTEGER CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),
  source_kind       TEXT NOT NULL DEFAULT 'observation'
                    CHECK (source_kind IN ('observation','user_statement','decision',
                                           'reflection','document','derived',
                                           'agent_inference')),
  recheck_kind      TEXT NOT NULL DEFAULT 'none'
                    CHECK (recheck_kind IN ('none','command','manual','on_read')),
  expired_at        TEXT,

  -- 置信侧：可重估、可覆盖，每次变更必须留 source + audit（概设 §3.6.3）
  confidence        REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  confidence_source TEXT NOT NULL DEFAULT 'llm_claim'
                    CHECK (confidence_source IN ('llm_claim','tool_obs','user_confirm',
                                                 'gat_delta','human','derived','procedure')),
  strength          REAL NOT NULL DEFAULT 0.5 CHECK (strength BETWEEN 0 AND 1),
  importance        REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  pool              TEXT NOT NULL DEFAULT 'utility'
                    CHECK (pool IN ('utility','value_floor')),
  epistemic_status  TEXT NOT NULL DEFAULT 'active'
                    CHECK (epistemic_status IN ('active','archived','invalidated',
                                                'pruned','disputed')),

  -- 语义侧：两区（D3）。frozen 不可变，ext 可改
  attrs             TEXT NOT NULL
                    CHECK (json_valid(attrs) AND json_extract(attrs,'$.frozen') IS NOT NULL),

  -- 身份 / 作用域 / 失效收口
  canonical_key     TEXT NOT NULL,               -- D5：禁止 NULL
  value_hash        TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'global',
  superseded_by     TEXT REFERENCES fact(id),
  valid_at          TEXT NOT NULL,
  valid_to          TEXT,
  recorded_at       TEXT NOT NULL,

  -- 派生 / 统计 / 溯源
  community_id      INTEGER,
  degree            INTEGER NOT NULL DEFAULT 0,
  access_count      INTEGER NOT NULL DEFAULT 0,
  last_access_at    TEXT,
  last_decay_at     TEXT NOT NULL,
  source_episode    TEXT REFERENCES episode(id),
  span_start        INTEGER,
  span_end          INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  -- P2-23 直写溯源（迁移 005）
  origin            TEXT,
  session_id        TEXT,
  turn              INTEGER,
  batch_id          TEXT,

  CHECK (valid_to IS NULL OR valid_to > valid_at),
  CHECK (length(content) > 0)
);

INSERT INTO fact_new (
  id, content, ftype, retention_class, volatility, admission_reason, ttl_seconds,
  source_kind, recheck_kind, expired_at,
  confidence, confidence_source, strength, importance, pool, epistemic_status,
  attrs, canonical_key, value_hash, scope, superseded_by, valid_at, valid_to,
  recorded_at, community_id, degree, access_count, last_access_at, last_decay_at,
  source_episode, span_start, span_end, created_at, updated_at,
  origin, session_id, turn, batch_id
)
SELECT
  id, content, ftype, NULL, NULL, NULL, NULL,
  'observation', 'none', NULL,
  confidence, confidence_source, strength, importance, pool, epistemic_status,
  attrs, canonical_key, value_hash, scope, superseded_by, valid_at, valid_to,
  recorded_at, community_id, degree, access_count, last_access_at, last_decay_at,
  source_episode, span_start, span_end, created_at, updated_at,
  origin, session_id, turn, batch_id
FROM fact;

DROP TABLE fact;
-- 重建窗口里 `fact` 不存在，而 edge 上的 trg_degree_* 触发器仍引用它；
-- 默认的 ALTER TABLE RENAME 会尝试解析这些引用而报 "no such table: main.fact"。
-- legacy_alter_table 让 RENAME 只改表名、不重写引用（引用本来就在等这个名字）。
PRAGMA legacy_alter_table = ON;
ALTER TABLE fact_new RENAME TO fact;
PRAGMA legacy_alter_table = OFF;

CREATE UNIQUE INDEX idx_fact_identity ON fact(canonical_key, scope, value_hash)
  WHERE valid_to IS NULL;
CREATE INDEX idx_fact_status_strength ON fact(epistemic_status, strength);
CREATE INDEX idx_fact_scope_community ON fact(scope, community_id);
CREATE INDEX idx_fact_valid_range ON fact(valid_at, valid_to);
CREATE INDEX idx_fact_key ON fact(canonical_key);
CREATE INDEX idx_fact_source_episode ON fact(source_episode);
CREATE INDEX idx_fact_retention ON fact(retention_class, volatility);
CREATE INDEX idx_fact_expires ON fact(expired_at) WHERE expired_at IS NOT NULL;
CREATE INDEX idx_fact_batch ON fact(batch_id) WHERE batch_id IS NOT NULL;

-- I1：content 不可变
CREATE TRIGGER trg_fact_content_immutable
BEFORE UPDATE OF content ON fact
WHEN NEW.content IS NOT OLD.content
BEGIN SELECT RAISE(ABORT, 'E_IMMUTABLE: fact.content is append-only'); END;

-- I2：attrs.frozen 不可变（D3）
CREATE TRIGGER trg_fact_frozen_immutable
BEFORE UPDATE OF attrs ON fact
WHEN json_extract(NEW.attrs,'$.frozen') IS NOT json_extract(OLD.attrs,'$.frozen')
BEGIN SELECT RAISE(ABORT, 'E_IMMUTABLE: fact.attrs.frozen is immutable'); END;

-- 任何写入都推高 schema_rev（派生投影的新鲜度判据）
CREATE TRIGGER trg_rev_fact_ins AFTER INSERT ON fact
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_fact_upd AFTER UPDATE ON fact
WHEN NEW.content IS NOT OLD.content
  OR NEW.confidence IS NOT OLD.confidence
  OR NEW.epistemic_status IS NOT OLD.epistemic_status
  OR NEW.valid_at IS NOT OLD.valid_at
  OR NEW.valid_to IS NOT OLD.valid_to
  OR NEW.pool IS NOT OLD.pool
  OR NEW.scope IS NOT OLD.scope
  OR NEW.retention_class IS NOT OLD.retention_class
  OR NEW.volatility IS NOT OLD.volatility
  OR NEW.admission_reason IS NOT OLD.admission_reason
  OR NEW.ttl_seconds IS NOT OLD.ttl_seconds
  OR NEW.source_kind IS NOT OLD.source_kind
  OR NEW.recheck_kind IS NOT OLD.recheck_kind
  OR NEW.expired_at IS NOT OLD.expired_at
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE TRIGGER trg_rev_fact_del AFTER DELETE ON fact
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

CREATE VIEW v_fact_degree AS
SELECT f.id AS fact_id,
       (SELECT COUNT(*) FROM edge e
         WHERE e.valid_to IS NULL AND (e.src = f.id OR e.dst = f.id)) AS degree
FROM fact f;

CREATE VIEW v_active_fact AS
SELECT * FROM fact
WHERE epistemic_status IN ('active','disputed')
  AND (valid_to IS NULL OR valid_to > strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE VIEW v_orphan_ratio AS
SELECT CAST(SUM(CASE WHEN degree = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS ratio,
       COUNT(*) AS total
FROM fact WHERE epistemic_status IN ('active','disputed');
