/**
 * 隐私 purge / 隐私总览编排（P2-19A-12；概设 §5.5.1、详设 §4.3）。
 *
 * 分工：
 * - 所有 SQL 在 `src/infra/sqlite/auditRepo.ts`（core 禁裸 db.prepare，且本卡
 *   write scope 只放开 auditRepo.ts）；
 * - 本文件只做 scope 编排、审计先行、归档文件白名单枚举/删除、体积统计。
 *
 * 硬约束：
 * 1. **先写 audit 再删**：audit 写入失败 → 事务回滚，一行不删；
 * 2. 单事务覆盖全部 DB 删除；
 * 3. 归档只删 `topics/**\/*.md` 与 `_history/**` 的普通文件，绝不删目录；
 * 4. 保留 meta / ontology / audit。
 */
import { statSync } from 'node:fs';
import type { Db } from '../../infra/sqlite/db.js';
import {
  appendPrivacyPurgeAudit,
  checkpointWal,
  countPurgeRows,
  deletePrivacyData,
  readLastPurgeAt,
  readPrivacyOverviewCounts,
  type PrivacyOverviewCounts,
  type PrivacyTableCounts,
  type PurgeScope,
} from '../../infra/sqlite/auditRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import {
  archiveBytes,
  collectArchiveFiles,
  removeArchiveFile,
} from '../../infra/fs/safeRemove.js';

/** 详设未配置 retention 段：闲置清理阈值先按常量 60 天（概设 §5.5.1） */
export const PRUNE_IDLE_DAYS = 60;

export interface PurgePreview extends PrivacyTableCounts {
  archive_files: number;
}

export interface PurgeResult {
  deleted: PrivacyTableCounts;
  archiveFilesRemoved: number;
  sizeBeforeMb: number;
  sizeAfterMb: number;
  elapsedMs: number;
}

export interface PrivacyDbJson {
  path: string;
  size_mb: number;
  wal_mb: number;
}

export interface PrivacyArchiveJson {
  dir: string;
  topics: number;
  bytes: number;
}

export interface PrivacyRetentionJson {
  prune_idle_days: number;
  half_life_days: number;
}

export interface PrivacyOverview {
  schema: 'moshi-privacy/1';
  db: PrivacyDbJson;
  counts: PrivacyOverviewCounts;
  archive: PrivacyArchiveJson;
  retention: PrivacyRetentionJson;
  last_purge_at: string | null;
}

const MB = 1024 * 1024;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fileMb(file: string): number {
  try {
    return round2(statSync(file).size / MB);
  } catch {
    return 0;
  }
}

/** 库文件 + WAL 体积；path 用 better-sqlite3 的 `Db.name`（打开时传入的绝对路径）。 */
export function privacyStorage(db: Db): PrivacyDbJson {
  const file = db.name;
  return { path: file, size_mb: fileMb(file), wal_mb: fileMb(`${file}-wal`) };
}

function archiveFilesForScope(scope: PurgeScope, archiveDir: string): string[] {
  if (scope !== 'all' && scope !== 'archive') return [];
  return collectArchiveFiles(archiveDir);
}

/** dry_run：只算数，不写任何行、不删任何文件。 */
export function planPurge(
  db: Db,
  opts: { scope: PurgeScope; archiveDir: string },
): PurgePreview {
  const counts = countPurgeRows(db, opts.scope);
  return {
    ...counts,
    archive_files: archiveFilesForScope(opts.scope, opts.archiveDir).length,
  };
}

/**
 * 实跑 purge：audit → 单事务删 DB → 删归档白名单文件 → checkpoint → 体积对比。
 * 审计失败时 `withTransaction` 抛错，DB 与文件都保持原样。
 */
export function runPurge(
  db: Db,
  opts: { scope: PurgeScope; archiveDir: string },
): PurgeResult {
  const started = Date.now();
  const before = privacyStorage(db);
  const preview = planPurge(db, opts);

  const deleted = withTransaction(db, () => {
    appendPrivacyPurgeAudit(db, { scope: opts.scope, counts: preview });
    return deletePrivacyData(db, opts.scope);
  });

  // 文件删除在 DB 事务之后（文件系统不可回滚）；audit 已先落，确保有痕
  let removed = 0;
  for (const file of archiveFilesForScope(opts.scope, opts.archiveDir)) {
    if (removeArchiveFile(file, opts.archiveDir)) removed += 1;
  }

  checkpointWal(db);
  const after = privacyStorage(db);
  return {
    deleted,
    archiveFilesRemoved: removed,
    sizeBeforeMb: before.size_mb,
    sizeAfterMb: after.size_mb,
    elapsedMs: Date.now() - started,
  };
}

/** 隐私总览（GET /api/privacy/overview）。 */
export function collectPrivacyOverview(
  db: Db,
  opts: { archiveDir: string; halfLifeDays: number },
): PrivacyOverview {
  const counts = readPrivacyOverviewCounts(db);
  const files = collectArchiveFiles(opts.archiveDir);
  return {
    schema: 'moshi-privacy/1',
    db: privacyStorage(db),
    counts,
    archive: {
      dir: opts.archiveDir,
      topics: counts.archive_topics,
      bytes: archiveBytes(files),
    },
    retention: {
      prune_idle_days: PRUNE_IDLE_DAYS,
      half_life_days: opts.halfLifeDays,
    },
    last_purge_at: readLastPurgeAt(db),
  };
}
