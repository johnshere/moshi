/**
 * archive_meta 仓储（详设 §2.2 / §9.4；台账 P1-15 / P2-15）。
 *
 * 导出记账：slug / path / content_hash / revision / last_exported_at / human_edited / status。
 * `topic_id` 是 TEXT 主键，调用方传字符串键（数字社区 id 统一 String() 化，
 * 避免 1 与 '1.0' 写成两行）。
 *
 * 三态 `human_edited`（详设 §9.4 L2841，P2-15）：
 *   0 = 正常，自动导出可覆盖
 *   1 = 检测到人工改动，已写 `<slug>.proposed.md`，等待三选一
 *   2 = 永久人工，不再自动导出、也不再生成 `.proposed.md`
 *
 * 本模块是 archive_meta 唯一的 SQL 入口：core/app 不写裸 SQL（lint:lifecycle 红线）。
 */
import type { Db } from './db.js';

/** `human_edited` 三态；0 自动可覆盖 / 1 待合并 / 2 永久人工 */
export type HumanEdited = 0 | 1 | 2;

/** 合并/分裂状态（P2-16 用）；本任务不改写 */
export type ArchiveStatus = 'active' | 'merged' | 'split';

export interface ArchiveMetaRow {
  /** 字符串键（与写入时 String(topicId) 一致） */
  topicId: string;
  slug: string;
  /** 相对 archive_dir 的路径，如 `topics/本机开发环境/本机开发环境.md` */
  path: string;
  title: string | null;
  contentHash: string | null;
  revision: number;
  lastExportedAt: string | null;
  humanEdited: HumanEdited;
  status: ArchiveStatus;
}

export interface ArchiveMetaWrite {
  topicId: string;
  slug: string;
  title: string;
  contentHash: string;
  revision: number;
  exportedAt: string;
  /** 相对 archive_dir 的路径；缺省 `topics/<slug>/<slug>.md`（P2-15 嵌套布局） */
  path?: string;
}

/**
 * 只更新传入字段（`undefined` = 不动）。用于三态切换 / revision 自增等局部写，
 * 不会顺手覆盖调用方没打算改的列。
 */
export interface ArchiveMetaPatch {
  slug?: string;
  path?: string;
  title?: string | null;
  contentHash?: string | null;
  revision?: number;
  lastExportedAt?: string | null;
  dirty?: 0 | 1;
  humanEdited?: HumanEdited;
  status?: ArchiveStatus;
}

const ROW_COLUMNS = `topic_id, slug, path, title, content_hash, revision, last_exported_at, human_edited, status`;

interface RawRow {
  topic_id: string;
  slug: string;
  path: string;
  title: string | null;
  content_hash: string | null;
  revision: number;
  last_exported_at: string | null;
  human_edited: number;
  status: string;
}

function mapRow(row: RawRow): ArchiveMetaRow {
  return {
    topicId: row.topic_id,
    slug: row.slug,
    path: row.path,
    title: row.title,
    contentHash: row.content_hash,
    revision: row.revision,
    lastExportedAt: row.last_exported_at,
    humanEdited: row.human_edited === 2 ? 2 : row.human_edited === 1 ? 1 : 0,
    status: row.status === 'merged' || row.status === 'split' ? row.status : 'active',
  };
}

export function getArchiveMeta(db: Db, topicId: string): ArchiveMetaRow | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM archive_meta WHERE topic_id = ?`).get(topicId) as RawRow | undefined;
  return row === undefined ? null : mapRow(row);
}

/** 按 slug 查（三选一 API 的路径参数是 slug，不是 topic_id） */
export function getArchiveMetaBySlug(db: Db, slug: string): ArchiveMetaRow | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM archive_meta WHERE slug = ?`).get(slug) as RawRow | undefined;
  return row === undefined ? null : mapRow(row);
}

/** 归档列表（GET /api/archive/topics）；最近导出在前，未导出过的排最后 */
export function listArchiveMeta(db: Db, limit = 200): ArchiveMetaRow[] {
  const rows = db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM archive_meta
       ORDER BY (last_exported_at IS NULL) ASC, last_exported_at DESC, slug ASC
       LIMIT ?`,
    )
    .all(limit) as RawRow[];
  return rows.map(mapRow);
}

/** 已占用的 slug（新主题命名时判冲突） */
export function listSlugs(db: Db): string[] {
  return (db.prepare('SELECT slug FROM archive_meta').all() as { slug: string }[]).map((r) => r.slug);
}

/**
 * 首次插入或覆盖导出记账；dirty 归 0（导出即视为已同步）。
 *
 * 注意：`ON CONFLICT DO UPDATE` **不碰 human_edited**——已存在行的人工编辑状态只能由
 * `updateArchiveMetaState` 显式改写，否则每次导出都会把 `1/2` 悄悄重置成 0。
 */
export function upsertArchiveMeta(db: Db, input: ArchiveMetaWrite): void {
  const relativePath = input.path ?? `topics/${input.slug}/${input.slug}.md`;
  db.prepare(
    `INSERT INTO archive_meta (topic_id, slug, path, title, content_hash, revision, last_exported_at, dirty, human_edited, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'active')
     ON CONFLICT(topic_id) DO UPDATE SET
       slug = excluded.slug, path = excluded.path, title = excluded.title,
       content_hash = excluded.content_hash, revision = excluded.revision,
       last_exported_at = excluded.last_exported_at, dirty = 0`,
  ).run(input.topicId, input.slug, relativePath, input.title, input.contentHash, input.revision, input.exportedAt);
}

const PATCH_COLUMNS: Readonly<Record<keyof ArchiveMetaPatch, string>> = {
  slug: 'slug',
  path: 'path',
  title: 'title',
  contentHash: 'content_hash',
  revision: 'revision',
  lastExportedAt: 'last_exported_at',
  dirty: 'dirty',
  humanEdited: 'human_edited',
  status: 'status',
};

/** 只写传入字段；返回实际更新的行数（topic 不存在 = 0，不抛） */
export function updateArchiveMetaState(db: Db, topicId: string, patch: ArchiveMetaPatch): number {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof ArchiveMetaPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${PATCH_COLUMNS[key]} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return 0;
  values.push(topicId);
  const info = db.prepare(`UPDATE archive_meta SET ${sets.join(', ')} WHERE topic_id = ?`).run(...values);
  return Number(info.changes);
}

/**
 * 合并后把存活主题的记账迁到新社区 id（P2-16，详设 §9.5）。
 *
 * 只改 `topic_id`，slug / path / revision 全保留——「slug 取存活时间更长的那个」。
 * 调用方必须先确认目标 topic_id 尚无 archive_meta（否则会撞主键），本函数返回
 * 受影响行数（0 = 源不存在）。
 */
export function reassignArchiveTopic(db: Db, fromTopicId: string, toTopicId: string): number {
  const info = db.prepare('UPDATE archive_meta SET topic_id = ? WHERE topic_id = ?').run(toTopicId, fromTopicId);
  return Number(info.changes);
}

export interface ArchiveMetaPlaceholder {
  topicId: string;
  slug: string;
  title: string;
  /** 相对 archive_dir 的路径；缺省 `topics/<slug>/<slug>.md` */
  path?: string;
}

/**
 * 分裂产生的新主题骨架（P2-16）：先占住 slug / path，正文等下一次导出再渲染。
 * `content_hash` / `last_exported_at` 为 NULL，`dirty=1` 提示还没导出过。
 */
export function createArchiveMetaPlaceholder(db: Db, input: ArchiveMetaPlaceholder): void {
  const relativePath = input.path ?? `topics/${input.slug}/${input.slug}.md`;
  db.prepare(
    `INSERT INTO archive_meta (topic_id, slug, path, title, content_hash, revision, last_exported_at, dirty, human_edited, status)
     VALUES (?, ?, ?, ?, NULL, 0, NULL, 1, 0, 'active')`,
  ).run(input.topicId, input.slug, relativePath, input.title);
}
