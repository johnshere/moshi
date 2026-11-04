/**
 * 自检数据采集（P2-18 / 详设 §11.4）。
 *
 * 所有诊断 SQL 都收口在 infra 这一层：`core/diag` 只做纯计算（不变量布尔判定、
 * 模块度、近似重复比），HTTP / CLI 只做组装与展示。这样单测可以只喂"原始计数"，
 * 不用起 HTTP 或 CLI。
 *
 * 输出刻意用 snake_case 原始值（行数、计数），而不是"健康/异常"结论——结论在
 * `core/diag/invariants.ts` 里形成，便于直接钉住 I1–I10 的判定口径。
 */
import { statSync } from 'node:fs';
import type { Db } from './db.js';
import { getMeta } from './metaRepo.js';

// ── DB 基础信息 ────────────────────────────────────────────────────────────

export interface DiagDbInfo {
  integrity: string;
  user_version: number;
  size_mb: number | null;
  wal_mb: number | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fileSizeMb(file: string): number | null {
  try {
    return round2(statSync(file).size / (1024 * 1024));
  } catch {
    // 只读库 / 文件被移走：大小未知，不影响其它检查
    return null;
  }
}

/** 一个数字标量（COUNT/SUM 之类），空结果按 0 */
function scalar(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function tableExists(db: Db, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS v FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

export function readDbInfo(db: Db): DiagDbInfo {
  const integrity = String(db.pragma('integrity_check', { simple: true }));
  const rawVersion = Number(db.pragma('user_version', { simple: true }));
  const file = db.name;
  return {
    integrity,
    user_version: Number.isFinite(rawVersion) ? rawVersion : 0,
    size_mb: file === '' ? null : fileSizeMb(file),
    wal_mb: file === '' ? null : fileSizeMb(`${file}-wal`),
  };
}

// ── 索引状态 ──────────────────────────────────────────────────────────────

export interface DiagIndexInputs {
  fact_rows: number;
  /** null = fact_fts 不存在（老库/降级） */
  fts_rows: number | null;
  /** null = 向量路被标记禁用，或 fact_vec 不存在（sqlite-vec 缺席） */
  vec_rows: number | null;
  vector_disabled: boolean;
  degree_mismatch: number;
}

export function readIndexInputs(db: Db): DiagIndexInputs {
  const factRows = scalar(db, 'SELECT COUNT(*) AS n FROM fact');
  const ftsRows = tableExists(db, 'fact_fts')
    ? scalar(db, 'SELECT COUNT(*) AS n FROM fact_fts')
    : null;
  const vectorDisabled =
    db.prepare("SELECT 1 AS v FROM meta WHERE key = 'vector_disabled'").get() !== undefined;
  const vecRows =
    vectorDisabled || !tableExists(db, 'fact_vec')
      ? null
      : scalar(db, 'SELECT COUNT(*) AS n FROM fact_vec');
  const degreeMismatch = scalar(
    db,
    `SELECT COUNT(*) AS n
       FROM fact f JOIN v_fact_degree v ON v.fact_id = f.id
      WHERE f.degree <> v.degree`,
  );
  return {
    fact_rows: factRows,
    fts_rows: ftsRows,
    vec_rows: vecRows,
    vector_disabled: vectorDisabled,
    degree_mismatch: degreeMismatch,
  };
}

// ── 不变量原始输入（I1–I10） ───────────────────────────────────────────────

export interface ConfidenceAuditSample {
  /** 抽样检查的 confidence 审计行数 */
  checked: number;
  /** 其中 JSON 不可解析 / 越界的行数 */
  missing: number;
}

export interface DiagInvariantInputs {
  content_audit_rows: number;
  frozen_trigger: boolean;
  duplicate_identities: number;
  duplicate_active_edges: number;
  active_status_violations: number;
  invalidated_without_valid_to: number;
  degree_mismatch: number;
  supersedes_violations: number;
  fts_rows: number | null;
  vec_rows: number | null;
  fact_rows: number;
  vector_disabled: boolean;
  confidence_audit_sample: ConfidenceAuditSample;
}

function parseConfidence(json: string | null): number | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * I10 的抽样对账：审计只能证明"写过的变更留了痕"，无法反推"没留痕的变更"。
 * 因此这里检查最近 50 条 confidence 审计行的 JSON 形状（before/after 必须是
 * 合法 [0,1] 数字）——形状坏了说明审计链路本身漏写。
 */
function readConfidenceAuditSample(db: Db): ConfidenceAuditSample {
  const rows = db
    .prepare(
      `SELECT before_json, after_json
         FROM audit
        WHERE tbl = 'fact' AND field = 'confidence'
        ORDER BY ts DESC, id DESC
        LIMIT 50`,
    )
    .all() as { before_json: string | null; after_json: string | null }[];
  let missing = 0;
  for (const row of rows) {
    const after = parseConfidence(row.after_json);
    const before = parseConfidence(row.before_json);
    if (after === null || after < 0 || after > 1) {
      missing += 1;
    } else if (before !== null && (before < 0 || before > 1)) {
      missing += 1;
    }
  }
  return { checked: rows.length, missing };
}

export function readInvariantInputs(db: Db): DiagInvariantInputs {
  const indexes = readIndexInputs(db);
  const frozenTrigger =
    db
      .prepare(
        "SELECT 1 AS v FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_fact_frozen_immutable'",
      )
      .get() !== undefined;
  return {
    content_audit_rows: scalar(
      db,
      "SELECT COUNT(*) AS n FROM audit WHERE tbl = 'fact' AND field = 'content'",
    ),
    frozen_trigger: frozenTrigger,
    duplicate_identities: scalar(
      db,
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM fact GROUP BY canonical_key, scope, value_hash HAVING COUNT(*) > 1
       )`,
    ),
    duplicate_active_edges: scalar(
      db,
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM edge WHERE valid_to IS NULL GROUP BY src, dst, etype HAVING COUNT(*) > 1
       )`,
    ),
    active_status_violations: scalar(
      db,
      `SELECT COUNT(*) AS n FROM fact
        WHERE valid_to IS NULL AND epistemic_status NOT IN ('active','disputed')`,
    ),
    invalidated_without_valid_to: scalar(
      db,
      "SELECT COUNT(*) AS n FROM fact WHERE epistemic_status = 'invalidated' AND valid_to IS NULL",
    ),
    degree_mismatch: indexes.degree_mismatch,
    supersedes_violations: scalar(
      db,
      `SELECT COUNT(*) AS n
         FROM edge e
         JOIN fact s ON s.id = e.src
         JOIN fact d ON d.id = e.dst
        WHERE e.etype = 'supersedes'
          AND s.valid_to IS NOT NULL
          AND d.valid_at <= s.valid_to`,
    ),
    fts_rows: indexes.fts_rows,
    vec_rows: indexes.vec_rows,
    fact_rows: indexes.fact_rows,
    vector_disabled: indexes.vector_disabled,
    confidence_audit_sample: readConfidenceAuditSample(db),
  };
}

// ── 归档台账 ──────────────────────────────────────────────────────────────

export interface DiagArchiveSummary {
  topics: number;
  dirty: number;
  human_edited: number;
}

export function readArchiveSummary(db: Db): DiagArchiveSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS topics,
              COALESCE(SUM(dirty = 1), 0) AS dirty,
              COALESCE(SUM(human_edited <> 0), 0) AS human_edited
         FROM archive_meta`,
    )
    .get() as { topics: number; dirty: number; human_edited: number } | undefined;
  return {
    topics: row?.topics ?? 0,
    dirty: row?.dirty ?? 0,
    human_edited: row?.human_edited ?? 0,
  };
}

// ── 图质量原始输入（详设 §2.10 六项） ─────────────────────────────────────

export interface DiagCommunityStat {
  community_id: number;
  fact_count: number;
  /** 社区内节点在"两端都有社区"的活跃边子图里的度数（模块度用） */
  degree: number;
  /** 社区内部活跃边数（每条边只计一次，按 src 的社区归属） */
  internal_edges: number;
}

export interface DiagNearDupPair {
  a: string;
  b: string;
}

export interface DiagQualityInputs {
  orphan_ratio: number | null;
  stale_chains: number;
  near_dup_pairs: DiagNearDupPair[];
  key_entity_coverage: number | null;
  scope_leak: number;
  communities: DiagCommunityStat[];
  /** 两端社区都非空的活跃边数（模块度的 m） */
  community_edge_count: number;
}

export function readQualityInputs(db: Db, nearDupLimit = 100): DiagQualityInputs {
  const orphan = db.prepare('SELECT ratio, total FROM v_orphan_ratio').get() as
    | { ratio: number | null; total: number }
    | undefined;
  const orphanRatio = orphan === undefined || orphan.total === 0 ? null : orphan.ratio;

  const staleChains = scalar(
    db,
    `SELECT COUNT(DISTINCT e.src) AS n
       FROM edge e
       JOIN fact s ON s.id = e.src
       JOIN fact d ON d.id = e.dst
      WHERE e.etype = 'depends_on' AND e.valid_to IS NULL
        AND s.epistemic_status IN ('active','disputed')
        AND d.epistemic_status IN ('invalidated','pruned')`,
  );

  // 同 canonical_key 下不同 value_hash 的活跃事实对：是否近似重复要靠向量算，
  // 这里只取候选对，cosine 判断在 core/diag/quality.ts。
  const nearDupPairs = db
    .prepare(
      `SELECT f1.id AS a, f2.id AS b
         FROM fact f1
         JOIN fact f2 ON f2.canonical_key = f1.canonical_key
                      AND f2.value_hash > f1.value_hash
          AND f2.id > f1.id
        WHERE f1.epistemic_status IN ('active','disputed')
          AND f2.epistemic_status IN ('active','disputed')
        ORDER BY f1.id, f2.id
        LIMIT ?`,
    )
    .all(nearDupLimit) as DiagNearDupPair[];

  const coverageRow = db
    .prepare(
      `WITH top AS (
         SELECT json_extract(attrs,'$.frozen.subject.entity_id') AS eid, COUNT(*) AS n
           FROM fact
          WHERE epistemic_status IN ('active','disputed')
          GROUP BY 1 ORDER BY n DESC LIMIT 50
       )
       SELECT CAST(SUM(CASE WHEN EXISTS(
                SELECT 1 FROM fact f2
                 WHERE json_extract(f2.attrs,'$.frozen.subject.entity_id') = top.eid
                   AND f2.epistemic_status IN ('active','disputed')) THEN 1 ELSE 0 END) AS REAL)
              / COUNT(*) AS ratio
         FROM top`,
    )
    .get() as { ratio: number | null } | undefined;

  const scopeLeak = scalar(
    db,
    `SELECT COUNT(*) AS n
       FROM query_log q
       JOIN evidence_log e ON e.query_id = q.id
       JOIN fact f ON f.id = e.fact_id
      WHERE q.flags_json LIKE '%"scope":"global"%'
        AND f.scope LIKE 'project:%'`,
  );

  const factCounts = db
    .prepare(
      `SELECT community_id, COUNT(*) AS n
         FROM fact WHERE community_id IS NOT NULL
        GROUP BY community_id`,
    )
    .all() as { community_id: number; n: number }[];

  const degrees = db
    .prepare(
      `WITH ends AS (
         SELECT e.src AS id FROM edge e
           JOIN fact s ON s.id = e.src
           JOIN fact d ON d.id = e.dst
          WHERE e.valid_to IS NULL
            AND s.community_id IS NOT NULL AND d.community_id IS NOT NULL
         UNION ALL
         SELECT e.dst FROM edge e
           JOIN fact s ON s.id = e.src
           JOIN fact d ON d.id = e.dst
          WHERE e.valid_to IS NULL
            AND s.community_id IS NOT NULL AND d.community_id IS NOT NULL
       )
       SELECT f.community_id AS community_id, COUNT(*) AS n
         FROM ends JOIN fact f ON f.id = ends.id
        GROUP BY f.community_id`,
    )
    .all() as { community_id: number; n: number }[];

  const internalEdges = db
    .prepare(
      `SELECT s.community_id AS community_id, COUNT(*) AS n
         FROM edge e
         JOIN fact s ON s.id = e.src
         JOIN fact d ON d.id = e.dst
        WHERE e.valid_to IS NULL
          AND s.community_id IS NOT NULL
          AND d.community_id IS NOT NULL
          AND s.community_id = d.community_id
        GROUP BY s.community_id`,
    )
    .all() as { community_id: number; n: number }[];

  const communityEdgeCount = scalar(
    db,
    `SELECT COUNT(*) AS n
       FROM edge e
       JOIN fact s ON s.id = e.src
       JOIN fact d ON d.id = e.dst
      WHERE e.valid_to IS NULL
        AND s.community_id IS NOT NULL AND d.community_id IS NOT NULL`,
  );

  const byId = new Map<number, DiagCommunityStat>();
  for (const row of factCounts) {
    byId.set(row.community_id, {
      community_id: row.community_id,
      fact_count: row.n,
      degree: 0,
      internal_edges: 0,
    });
  }
  for (const row of degrees) {
    const stat = byId.get(row.community_id);
    if (stat !== undefined) stat.degree = row.n;
  }
  for (const row of internalEdges) {
    const stat = byId.get(row.community_id);
    if (stat !== undefined) stat.internal_edges = row.n;
  }
  const communities = [...byId.values()].sort(
    (x, y) => y.fact_count - x.fact_count || x.community_id - y.community_id,
  );

  return {
    orphan_ratio: orphanRatio,
    stale_chains: staleChains,
    near_dup_pairs: nearDupPairs,
    key_entity_coverage: coverageRow?.ratio ?? null,
    scope_leak: scopeLeak,
    communities,
    community_edge_count: communityEdgeCount,
  };
}

// ── 心跳 / 评测 ───────────────────────────────────────────────────────────

/** 最近一次 harvest 时间；当前版本尚未写入（P2-17 调度器接管前为 null） */
export function readLastHarvestAt(db: Db): string | null {
  return getMeta(db, 'last_harvest_at');
}

/** `meta.last_eval` 的原始 JSON 文本（解析/校验在 core） */
export function readLastEvalRaw(db: Db): string | null {
  return getMeta(db, 'last_eval');
}
