/**
 * archive_meta 仓储（详设 §2.2 / §9.4；台账 P1-15）。
 *
 * 导出记账：slug / path / content_hash / revision / last_exported_at。
 * `topic_id` 是 TEXT 主键，调用方传字符串键（数字社区 id 统一 String() 化，
 * 避免 1 与 '1.0' 写成两行）。
 */
import type { Db } from './db.js';

export interface ArchiveMetaRow {
  slug: string;
  contentHash: string | null;
  revision: number;
  lastExportedAt: string | null;
}

export interface ArchiveMetaWrite {
  topicId: string;
  slug: string;
  title: string;
  contentHash: string;
  revision: number;
  exportedAt: string;
}

export function getArchiveMeta(db: Db, topicId: string): ArchiveMetaRow | null {
  const row = db
    .prepare('SELECT slug, content_hash, revision, last_exported_at FROM archive_meta WHERE topic_id = ?')
    .get(topicId) as
    | { slug: string; content_hash: string | null; revision: number; last_exported_at: string | null }
    | undefined;
  if (row === undefined) return null;
  return {
    slug: row.slug,
    contentHash: row.content_hash,
    revision: row.revision,
    lastExportedAt: row.last_exported_at,
  };
}

/** 已占用的 slug（新主题命名时判冲突） */
export function listSlugs(db: Db): string[] {
  return (db.prepare('SELECT slug FROM archive_meta').all() as { slug: string }[]).map((r) => r.slug);
}

/** 首次插入或覆盖导出记账；dirty 归 0（导出即视为已同步） */
export function upsertArchiveMeta(db: Db, input: ArchiveMetaWrite): void {
  db.prepare(
    `INSERT INTO archive_meta (topic_id, slug, path, title, content_hash, revision, last_exported_at, dirty, human_edited, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'active')
     ON CONFLICT(topic_id) DO UPDATE SET
       slug = excluded.slug, path = excluded.path, title = excluded.title,
       content_hash = excluded.content_hash, revision = excluded.revision,
       last_exported_at = excluded.last_exported_at, dirty = 0`,
  ).run(input.topicId, input.slug, `${input.slug}.md`, input.title, input.contentHash, input.revision, input.exportedAt);
}
