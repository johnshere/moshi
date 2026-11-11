/**
 * 审计仓储（详设 §2.3 / I10）。
 *
 * 审计只追加，不提供 update / delete。任何"改了就忘"的路径都是 I10 的漏洞。
 */
import type { Edge, Entity } from '../../domain/types.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from './db.js';
import { rowToEdge, rowToEntity } from './mappers.js';

export interface AuditInput {
  /** `annotation` 只由直写撤销写（P2-23）：撤销要连带回滚队列快照，同样得留痕 */
  tbl: 'fact' | 'edge' | 'entity' | 'archive_meta' | 'annotation' | 'privacy' | 'query_log' | 'trace_log';
  rowId: string;
  field?: string | null;
  before?: unknown;
  after?: unknown;
  source?: string | null;
  reason?: string | null;
  ts?: string;
}

export interface AuditRecord {
  id: string;
  tbl: string;
  rowId: string;
  field: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  source: string | null;
  reason: string | null;
  ts: string;
}

const jsonOrNull = (v: unknown): string | null =>
  v === undefined ? null : v === null ? null : JSON.stringify(v);

export function appendAudit(db: Db, input: AuditInput): string {
  const id = newId('audit');
  db.prepare(
    `INSERT INTO audit (id, tbl, row_id, field, before_json, after_json, source, reason, ts)
     VALUES (@id, @tbl, @row_id, @field, @before, @after, @source, @reason, @ts)`,
  ).run({
    id,
    tbl: input.tbl,
    row_id: input.rowId,
    field: input.field ?? null,
    before: jsonOrNull(input.before),
    after: jsonOrNull(input.after),
    source: input.source ?? null,
    reason: input.reason ?? null,
    ts: input.ts ?? nowIso(),
  });
  return id;
}

export function auditByRow(db: Db, tbl: string, rowId: string): AuditRecord[] {
  const rows = db
    .prepare('SELECT * FROM audit WHERE tbl = ? AND row_id = ? ORDER BY ts ASC, id ASC')
    .all(tbl, rowId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r['id']),
    tbl: String(r['tbl']),
    rowId: String(r['row_id']),
    field: (r['field'] as string | null) ?? null,
    beforeJson: (r['before_json'] as string | null) ?? null,
    afterJson: (r['after_json'] as string | null) ?? null,
    source: (r['source'] as string | null) ?? null,
    reason: (r['reason'] as string | null) ?? null,
    ts: String(r['ts']),
  }));
}

/** I10 抽样：改过 confidence 但没有审计行的 fact */
export function confidenceChangesWithoutAudit(db: Db): { fact_id: string; confidence: number }[] {
  return db
    .prepare(
      `SELECT f.id AS fact_id, f.confidence AS confidence
         FROM fact f
        WHERE NOT EXISTS (
          SELECT 1 FROM audit a
           WHERE a.tbl = 'fact' AND a.row_id = f.id AND a.field = 'confidence'
        )`,
    )
    .all() as { fact_id: string; confidence: number }[];
}

/** I1 检查：audit 里不该出现 content 变更（触发器已经拦住了，这里是二次对账） */
export function contentAuditRows(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM audit WHERE tbl = 'fact' AND field = 'content'")
    .get() as { n: number };
  return row.n;
}

// ════════════════════════════════════════════════════════════════════════
// 隐私 purge / 总览 / 全库导出（P2-19A-12）
//
// 说明：task-19 的 write scope 只允许改 auditRepo.ts（infra 层），而 core/app
// 不允许出现裸 db.prepare；因此隐私相关的批量读/删 SQL 暂放这里。
// 后续拆到独立的 `src/infra/sqlite/privacyRepo.ts`（见 p2-19a-privacy-progress）。
// ════════════════════════════════════════════════════════════════════════

export type PurgeScope = 'all' | 'facts' | 'sessions' | 'archive';

export const PURGE_SCOPES: readonly PurgeScope[] = ['all', 'facts', 'sessions', 'archive'];

export function isPurgeScope(value: unknown): value is PurgeScope {
  return typeof value === 'string' && (PURGE_SCOPES as readonly string[]).includes(value);
}

export interface PrivacyTableCounts {
  facts: number;
  edges: number;
  entities: number;
  annotations: number;
  sessions: number;
}

export interface PrivacyOverviewCounts extends PrivacyTableCounts {
  archive_topics: number;
  facts_pruned: number;
  facts_invalidated: number;
}

function countRows(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { n: number };
  return row.n;
}

/** 各 scope 在 dry_run 时的「将删除」行数。archive 文件数由 core 层扫盘后叠加。 */
export function countPurgeRows(db: Db, scope: PurgeScope): PrivacyTableCounts {
  const zero: PrivacyTableCounts = { facts: 0, edges: 0, entities: 0, annotations: 0, sessions: 0 };
  if (scope === 'archive') return zero;
  const out = { ...zero };
  if (scope === 'all' || scope === 'facts') {
    out.facts = countRows(db, 'SELECT COUNT(*) AS n FROM fact');
    out.edges = countRows(db, 'SELECT COUNT(*) AS n FROM edge');
  }
  if (scope === 'all' || scope === 'sessions') {
    out.annotations = countRows(db, 'SELECT COUNT(*) AS n FROM annotation');
    out.sessions = countRows(db, 'SELECT COUNT(*) AS n FROM session');
  }
  if (scope === 'all') {
    out.entities = countRows(db, 'SELECT COUNT(*) AS n FROM entity');
  }
  return out;
}

export function readPrivacyOverviewCounts(db: Db): PrivacyOverviewCounts {
  return {
    facts: countRows(db, 'SELECT COUNT(*) AS n FROM fact'),
    edges: countRows(db, 'SELECT COUNT(*) AS n FROM edge'),
    entities: countRows(db, 'SELECT COUNT(*) AS n FROM entity'),
    annotations: countRows(db, 'SELECT COUNT(*) AS n FROM annotation'),
    sessions: countRows(db, 'SELECT COUNT(*) AS n FROM session'),
    archive_topics: countRows(db, 'SELECT COUNT(*) AS n FROM archive_meta'),
    facts_pruned: countRows(db, "SELECT COUNT(*) AS n FROM fact WHERE epistemic_status = 'pruned'"),
    facts_invalidated: countRows(
      db,
      "SELECT COUNT(*) AS n FROM fact WHERE epistemic_status = 'invalidated'",
    ),
  };
}

export interface PrivacyPurgeAuditInput {
  scope: PurgeScope;
  /** 计划/实际删除计数（dry_run=false 时与 deleted 一致），archive_files 已含文件数 */
  counts: PrivacyTableCounts & { archive_files: number };
}

/** 先写审计再删（概设 §5.5.1：物理删除必须留痕）。返回 audit id。 */
export function appendPrivacyPurgeAudit(db: Db, input: PrivacyPurgeAuditInput): string {
  return appendAudit(db, {
    tbl: 'privacy',
    rowId: 'purge',
    field: 'privacy.purge',
    source: 'api',
    reason: input.scope,
    after: { scope: input.scope, counts: input.counts, dry_run: false },
  });
}

/** 最近一次真实 purge 的时间（dry_run 不写 audit，因此不会被计入）。 */
export function readLastPurgeAt(db: Db): string | null {
  const row = db
    .prepare(
      `SELECT ts FROM audit
        WHERE tbl = 'privacy' AND field = 'privacy.purge'
        ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get() as { ts: string } | undefined;
  return row?.ts ?? null;
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function deleteFtsRows(db: Db): void {
  if (tableExists(db, 'fact_fts')) db.prepare('DELETE FROM fact_fts').run();
}

function deleteVecRows(db: Db): void {
  // 向量表可能不存在（sidecar/vec 未就绪）；fact_vec 不归 SQLite FK 管，单独清
  if (tableExists(db, 'fact_vec')) db.prepare('DELETE FROM fact_vec').run();
}

/**
 * 按 scope 物理删除。调用方**必须**先 `appendPrivacyPurgeAudit` 并用同一事务包住。
 * 删除顺序照顾 FK：evidence_log/feedback/layout → fts/vec → edge → fact；
 * episode 在 fact 之后；alias 在 entity 之前；entity.merged_into 先置空。
 * 保留：meta / ontology / audit。
 */
export function deletePrivacyData(db: Db, scope: PurgeScope): PrivacyTableCounts {
  const deleted: PrivacyTableCounts = {
    facts: 0,
    edges: 0,
    entities: 0,
    annotations: 0,
    sessions: 0,
  };
  const run = (sql: string): number => db.prepare(sql).run().changes;
  if (scope === 'archive') {
    // 只清归档台账（文件由 core 层按白名单删除）
    run('DELETE FROM archive_meta');
    return deleted;
  }

  if (scope === 'all' || scope === 'facts') {
    run('DELETE FROM evidence_log');
    run('DELETE FROM feedback');
    run('DELETE FROM layout');
    deleteFtsRows(db);
    deleteVecRows(db);
    deleted.edges = run('DELETE FROM edge');
    // fact.superseded_by 自引用 FK：先断开再删
    db.prepare('UPDATE fact SET superseded_by = NULL WHERE superseded_by IS NOT NULL').run();
    deleted.facts = run('DELETE FROM fact');
    // 派生物：社区摘要由事实内容生成，留着会泄漏已删事实
    run('DELETE FROM community_summary');
    if (scope === 'all') {
      run('DELETE FROM adjudication');
      run('DELETE FROM training_sample');
    }
  }

  if (scope === 'all' || scope === 'sessions') {
    if (scope === 'sessions') {
      // 只清会话时不删事实；fact.source_episode 是 FK，先断开再删 episode
      db.prepare('UPDATE fact SET source_episode = NULL WHERE source_episode IS NOT NULL').run();
    }
    deleted.annotations = run('DELETE FROM annotation');
    run('DELETE FROM quarantine');
    run('DELETE FROM episode');
    deleted.sessions = run('DELETE FROM session');
    if (scope === 'all') run('DELETE FROM query_log');
  }

  if (scope === 'all') {
    run('DELETE FROM alias');
    db.prepare('UPDATE entity SET merged_into = NULL WHERE merged_into IS NOT NULL').run();
    deleted.entities = run('DELETE FROM entity');
    run('DELETE FROM archive_meta');
  }
  return deleted;
}

/** 库文件本身与 -wal 的大小（MB，保留 2 位）；path 即 Db 打开的文件。 */
export function readUserVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** purge 后尝试把 WAL 截断回主库，让 size_after 反映真实占用（失败不影响结果）。 */
export function checkpointWal(db: Db): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // 只读库/并发读会失败：忽略
  }
}

// ── 全库导出分页读（fact 走 factRepo.listFactsPage，其余三表在此补） ──

export interface ExportPageRow<T> {
  rowid: number;
  value: T;
}

export function pageExportEdges(
  db: Db,
  afterRowid: number,
  limit: number,
): ExportPageRow<Edge>[] {
  const rows = db
    .prepare('SELECT rowid AS rid, * FROM edge WHERE rowid > ? ORDER BY rowid LIMIT ?')
    .all(afterRowid, limit) as Record<string, unknown>[];
  return rows.map((row) => ({ rowid: Number(row['rid']), value: rowToEdge(row) }));
}

export function pageExportEntities(
  db: Db,
  afterRowid: number,
  limit: number,
): ExportPageRow<Entity>[] {
  const rows = db
    .prepare('SELECT rowid AS rid, * FROM entity WHERE rowid > ? ORDER BY rowid LIMIT ?')
    .all(afterRowid, limit) as Record<string, unknown>[];
  return rows.map((row) => ({ rowid: Number(row['rid']), value: rowToEntity(row) }));
}

export interface ArchiveTopicMetadata {
  slug: string;
  title: string;
  revision: number;
  last_exported_at: string | null;
  dirty: number;
  human_edited: number;
  status: string;
}

/** 导出 `?include=archive` 用：只带台账元数据，不带归档正文（原文不出境）。 */
export function readArchiveTopicMetadata(db: Db): ArchiveTopicMetadata[] {
  return db
    .prepare(
      `SELECT slug, title, revision, last_exported_at, dirty, human_edited, status
         FROM archive_meta ORDER BY slug`,
    )
    .all() as ArchiveTopicMetadata[];
}

export interface AnnotationExportRow {
  id: string;
  dedupKey: string;
  payloadJson: string;
  channel: string;
  receivedAt: string;
  harvestedAt: string | null;
  error: string | null;
}

export function pageExportAnnotations(
  db: Db,
  afterRowid: number,
  limit: number,
): ExportPageRow<AnnotationExportRow>[] {
  const rows = db
    .prepare(
      `SELECT rowid AS rid, id, dedup_key, payload_json, channel, received_at, harvested_at, error
         FROM annotation WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .all(afterRowid, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    rowid: Number(row['rid']),
    value: {
      id: String(row['id']),
      dedupKey: String(row['dedup_key']),
      payloadJson: String(row['payload_json']),
      channel: String(row['channel']),
      receivedAt: String(row['received_at']),
      harvestedAt: (row['harvested_at'] as string | null) ?? null,
      error: (row['error'] as string | null) ?? null,
    },
  }));
}
