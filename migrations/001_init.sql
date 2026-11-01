-- 默识 schema v1（详设 §2.2 定稿 DDL）
-- 只增不改：已发布的迁移文件改一个字都会导致线上库版本与文件不一致。
-- 连接级 PRAGMA 不写在这里（每次打开连接都要设，见 infra/sqlite/db.ts）。
-- fact_vec 不在这里：它依赖 sqlite-vec 扩展，由 migrate.ts 条件创建（扩展缺失时降级）。

-- ============ 1. 元信息 ============
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 约定键：schema_rev（单调递增，任何写入 +1）、layout_version、last_harvest_at、
--         last_export_at、last_infer_at、sidecar_model_version、embed_model

INSERT INTO meta(key, value) VALUES
  ('schema_rev', '0'),
  ('layout_version', '0');

-- ============ 2. 实体与别名 ============
CREATE TABLE entity (
  id             TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  etype          TEXT NOT NULL
                 CHECK (etype IN ('pkg','process','port','path','version',
                                  'service','concept','unknown')),
  scope          TEXT NOT NULL DEFAULT 'global',
  alias_count    INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL,
  merged_into    TEXT REFERENCES entity(id),
  UNIQUE (canonical_name, etype, scope)
);
CREATE INDEX idx_entity_merged ON entity(merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE alias (
  alias      TEXT NOT NULL,
  entity_id  TEXT NOT NULL REFERENCES entity(id),
  source     TEXT NOT NULL CHECK (source IN ('rule','vector','human')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (alias, entity_id)
);
CREATE INDEX idx_alias_alias  ON alias(alias);
CREATE INDEX idx_alias_entity ON alias(entity_id);

-- ============ 3. 轨迹与会话 ============
CREATE TABLE episode (
  id         TEXT PRIMARY KEY,
  session    TEXT,
  ts         TEXT NOT NULL,
  raw_hash   TEXT NOT NULL,
  raw_path   TEXT,
  summary    TEXT,
  agent      TEXT,
  cwd        TEXT
);
CREATE INDEX idx_episode_ts      ON episode(ts);
CREATE INDEX idx_episode_session ON episode(session);

CREATE TABLE session (
  id              TEXT PRIMARY KEY,
  agent           TEXT,
  cwd             TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  turn_count      INTEGER NOT NULL DEFAULT 0,
  tool_histogram  TEXT,           -- JSON: {"Bash":42,"Read":18}
  summary         TEXT,           -- 确定性模板生成，非 LLM（§8.2）
  source_episodes TEXT,           -- JSON 数组
  summarized_at   TEXT
);
CREATE INDEX idx_session_cwd_time ON session(cwd, started_at);
CREATE INDEX idx_session_open     ON session(ended_at) WHERE ended_at IS NULL;

-- ============ 4. 事实（L0 主表） ============
CREATE TABLE fact (
  id                TEXT PRIMARY KEY,
  content           TEXT NOT NULL,
  ftype             TEXT NOT NULL CHECK (ftype IN ('semantic','episodic','conditional')),

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

  CHECK (valid_to IS NULL OR valid_to > valid_at),
  CHECK (length(content) > 0)
);
CREATE UNIQUE INDEX idx_fact_identity  ON fact(canonical_key, scope, value_hash);
CREATE INDEX idx_fact_status_strength  ON fact(epistemic_status, strength);
CREATE INDEX idx_fact_scope_community  ON fact(scope, community_id);
CREATE INDEX idx_fact_valid_range      ON fact(valid_at, valid_to);
CREATE INDEX idx_fact_key              ON fact(canonical_key);
CREATE INDEX idx_fact_source_episode   ON fact(source_episode);

-- ============ 5. 边 ============
CREATE TABLE edge (
  id          TEXT PRIMARY KEY,
  src         TEXT NOT NULL REFERENCES fact(id),
  dst         TEXT NOT NULL REFERENCES fact(id),
  etype       TEXT NOT NULL
              CHECK (etype IN ('depends_on','logic','mutually_exclusive',
                               'co_occur','supersedes','derived_from')),
  weight      REAL NOT NULL DEFAULT 1.0,
  confidence  REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  valid_at    TEXT NOT NULL,
  valid_to    TEXT,
  recorded_at TEXT NOT NULL,
  CHECK (src <> dst)
);
-- D4：同一三元组同时只能有一条活跃边
CREATE UNIQUE INDEX idx_edge_active    ON edge(src,dst,etype) WHERE valid_to IS NULL;
CREATE INDEX idx_edge_src              ON edge(src);
CREATE INDEX idx_edge_dst              ON edge(dst);
CREATE INDEX idx_edge_src_etype        ON edge(src,etype);

-- ============ 6. 社区摘要 ============
CREATE TABLE community_summary (
  community_id INTEGER NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'global',
  label        TEXT,                 -- 主题名（归档 slug 的人类可读部分）
  summary      TEXT NOT NULL,
  fact_count   INTEGER NOT NULL,
  derived_at   TEXT NOT NULL,
  source_rev   INTEGER NOT NULL,
  PRIMARY KEY (community_id, scope)
);

-- ============ 7. 写入缓冲 ============
CREATE TABLE annotation (
  id           TEXT PRIMARY KEY,
  dedup_key    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('annotate','harvest','tool_parse')),
  received_at  TEXT NOT NULL,
  harvested_at TEXT,
  error        TEXT
);
CREATE UNIQUE INDEX idx_annotation_dedup   ON annotation(dedup_key);
CREATE INDEX idx_annotation_pending ON annotation(harvested_at) WHERE harvested_at IS NULL;

CREATE TABLE quarantine (
  id           TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  reason       TEXT NOT NULL,
  ts           TEXT NOT NULL,
  resolved     TEXT CHECK (resolved IN ('accepted','dropped')),
  resolved_at  TEXT
);
CREATE INDEX idx_quarantine_open ON quarantine(resolved) WHERE resolved IS NULL;

-- ============ 8. 反馈与查询日志（D7） ============
CREATE TABLE feedback (
  id       TEXT PRIMARY KEY,
  query_id TEXT,
  fact_id  TEXT NOT NULL REFERENCES fact(id),
  verdict  TEXT NOT NULL CHECK (verdict IN ('adopt','correct','reject')),
  ts       TEXT NOT NULL,
  source   TEXT,
  note     TEXT
);
CREATE INDEX idx_feedback_fact  ON feedback(fact_id);
CREATE INDEX idx_feedback_query ON feedback(query_id);

CREATE TABLE query_log (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  session         TEXT,
  query_text      TEXT NOT NULL,
  query_hash      TEXT NOT NULL,
  route           TEXT NOT NULL CHECK (route IN ('local','global')),
  flags_json      TEXT NOT NULL,        -- 开关快照：{gat,self_attn,cross_attn,vector,bm25,ppr}
  candidates_json TEXT,                 -- {"vector":[...],"bm25":[...],"ppr":[...]}
  fused_json      TEXT,                 -- [{fact_id,rrf,entity_bonus,temporal_bonus}]
  packed_json     TEXT,                 -- 入包 fact_id 数组（有序）
  degraded_json   TEXT,
  truncated       INTEGER NOT NULL DEFAULT 0,
  coverage        TEXT,
  latency_ms      REAL NOT NULL,
  stage_ms_json   TEXT,                 -- {"route":1.2,"recognize":3.1,...}
  cached          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_query_log_ts   ON query_log(ts);
CREATE INDEX idx_query_log_hash ON query_log(query_hash);

CREATE TABLE evidence_log (
  query_id TEXT NOT NULL REFERENCES query_log(id),
  m_id     INTEGER NOT NULL,
  fact_id  TEXT NOT NULL REFERENCES fact(id),
  rank     INTEGER NOT NULL,
  score    REAL NOT NULL,
  pool     TEXT NOT NULL CHECK (pool IN ('utility','value_floor')),
  cited    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (query_id, m_id)
);
CREATE INDEX idx_evidence_fact ON evidence_log(fact_id);

-- ============ 9. 符号裁决快照（GAT 唯一非循环标签来源） ============
CREATE TABLE adjudication (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL
                   CHECK (kind IN ('mutex_win','temporal_invalidate','dependency_hold')),
  fact_ids         TEXT NOT NULL,      -- JSON 数组：裁决涉及的事实
  decided_by       TEXT NOT NULL,      -- 规则名@版本，如 mutex_by_confidence@1
  decided_at       TEXT NOT NULL,
  outcome          TEXT CHECK (outcome IN ('upheld','overturned')),
  outcome_at       TEXT,
  outcome_evidence TEXT,               -- 推翻它的新观测 fact_id
  query_id         TEXT
);
CREATE INDEX idx_adjudication_open ON adjudication(outcome) WHERE outcome IS NULL;
CREATE INDEX idx_adjudication_rule ON adjudication(decided_by);

-- ============ 10. 训练样本 ============
CREATE TABLE training_sample (
  id          TEXT PRIMARY KEY,
  query_id    TEXT,
  fact_ids    TEXT NOT NULL,           -- JSON 数组：子图节点顺序
  label_kind  TEXT NOT NULL CHECK (label_kind IN ('overturn','rank')),
  label       REAL NOT NULL,           -- overturn: 0/1；rank: 相对分
  weight      REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL CHECK (source IN ('adjudication','feedback','execution')),
  created_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX idx_sample_unused ON training_sample(used_at) WHERE used_at IS NULL;

-- ============ 11. 结构登记（D9 的判据来源） ============
CREATE TABLE ontology (
  kind            TEXT NOT NULL CHECK (kind IN ('attr_key','etype','predicate')),
  name            TEXT NOT NULL,
  value_type      TEXT,                -- string|number|bool|time|enum|json
  cardinality     TEXT CHECK (cardinality IN ('single-valued','series','set')),
  sample_count    INTEGER NOT NULL DEFAULT 0,
  distinct_values INTEGER NOT NULL DEFAULT 0,
  single_ratio    REAL,                -- 同一 canonical_key 下只有一个取值的占比
  registered_at   TEXT NOT NULL,
  promoted        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, name)
);

-- ============ 12. 派生投影 ============
CREATE TABLE layout (
  fact_id        TEXT PRIMARY KEY REFERENCES fact(id),
  x              REAL NOT NULL,
  y              REAL NOT NULL,
  z              REAL NOT NULL,
  layout_version INTEGER NOT NULL,
  computed_at    TEXT NOT NULL
);
CREATE INDEX idx_layout_version ON layout(layout_version);

CREATE TABLE archive_meta (
  topic_id         TEXT PRIMARY KEY,
  slug             TEXT NOT NULL,
  path             TEXT NOT NULL,
  title            TEXT,
  content_hash     TEXT,
  revision         INTEGER NOT NULL DEFAULT 0,
  last_exported_at TEXT,
  dirty            INTEGER NOT NULL DEFAULT 0,
  human_edited     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','merged','split'))
);
CREATE UNIQUE INDEX idx_archive_slug  ON archive_meta(slug);
CREATE INDEX idx_archive_dirty ON archive_meta(dirty) WHERE dirty = 1;

-- ============ 13. 审计 ============
CREATE TABLE audit (
  id          TEXT PRIMARY KEY,
  tbl         TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  field       TEXT,
  before_json TEXT,
  after_json  TEXT,
  source      TEXT,
  reason      TEXT,
  ts          TEXT NOT NULL
);
CREATE INDEX idx_audit_row ON audit(tbl, row_id, ts);

-- ============ 14. 全文检索（D11：预分词列） ============
CREATE VIRTUAL TABLE fact_fts USING fts5(
  fact_id UNINDEXED,
  tokens,
  tokenize = "unicode61 remove_diacritics 2"
);

-- ============ 15. 触发器（详设 §2.5） ============
-- I1：content 不可变
CREATE TRIGGER trg_fact_content_immutable
BEFORE UPDATE OF content ON fact
WHEN NEW.content IS NOT OLD.content
BEGIN SELECT RAISE(ABORT, 'E_IMMUTABLE: fact.content is append-only'); END;

-- I2：attrs.frozen 不可变（D3）
-- 依赖 canonicalJson 的稳定序列化；比较的是 JSON 文本
CREATE TRIGGER trg_fact_frozen_immutable
BEFORE UPDATE OF attrs ON fact
WHEN json_extract(NEW.attrs,'$.frozen') IS NOT json_extract(OLD.attrs,'$.frozen')
BEGIN SELECT RAISE(ABORT, 'E_IMMUTABLE: fact.attrs.frozen is immutable'); END;

-- I4 的兜底：边一旦关闭就不再复活（复活要新建行）
CREATE TRIGGER trg_edge_no_reopen
BEFORE UPDATE OF valid_to ON edge
WHEN OLD.valid_to IS NOT NULL AND NEW.valid_to IS NULL
BEGIN SELECT RAISE(ABORT, 'E_IMMUTABLE: closed edge cannot be reopened'); END;

-- degree 维护（D4）
CREATE TRIGGER trg_degree_ins AFTER INSERT ON edge
WHEN NEW.valid_to IS NULL
BEGIN
  UPDATE fact SET degree = degree + 1 WHERE id = NEW.src;
  UPDATE fact SET degree = degree + 1 WHERE id = NEW.dst;
END;

CREATE TRIGGER trg_degree_close AFTER UPDATE OF valid_to ON edge
WHEN OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL
BEGIN
  UPDATE fact SET degree = degree - 1 WHERE id IN (OLD.src, OLD.dst);
END;

CREATE TRIGGER trg_degree_del AFTER DELETE ON edge
WHEN OLD.valid_to IS NULL
BEGIN
  UPDATE fact SET degree = degree - 1 WHERE id IN (OLD.src, OLD.dst);
END;

-- 任何写入都推高 schema_rev（派生投影的新鲜度判据）
CREATE TRIGGER trg_rev_fact_ins AFTER INSERT ON fact
BEGIN
  UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'schema_rev';
END;

-- ============ 16. 视图（详设 §2.6） ============
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
