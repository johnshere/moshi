/**
 * 归档主题的分裂 / 合并与台账（详设 §9.5 / §9.6；台账 P2-16）。
 *
 * 两条硬规矩：
 *   1. **只标记不删文件**——合并掉的 slug 保留原文件，改写成「已并入 X」的跳转文档；
 *      分裂的旧主题保留原文件，只在正文顶部加「已拆分为 A / B」。
 *   2. 不读 MD 回灌图、不复制正文：跳转文档只写指针；正文 hash 只用于更新
 *      `archive_meta.content_hash` 基线，防止下一次导出把标记文档当成人改并生成 `.proposed.md`。
 *
 * 台账 `.moshi-archive.json` 由 DB 的 `archive_meta` 生成（DB 为准）；写之前先读旧台账
 * 做差异比对，把 `differences` 返回给 doctor / CLI 消费。
 */
import path from 'node:path';
import { MoshiError } from '../../domain/errors.js';
import { nowIso } from '../../domain/time.js';
import { safeEnsureDir, safeWriteFile, type WriteRoots } from '../../infra/fs/safeWrite.js';
import type { Db } from '../../infra/sqlite/db.js';
import {
  createArchiveMetaPlaceholder,
  getArchiveMeta,
  listArchiveMeta,
  listSlugs,
  reassignArchiveTopic,
  updateArchiveMetaState,
  type ArchiveMetaRow,
  type ArchiveStatus,
} from '../../infra/sqlite/archiveRepo.js';
import { slugFor } from './topics.js';
import { bodyHashOfDocument, mainFilePath, readTextFile, topicRelativePath } from './writer.js';

// ────────────────────────────── 合并 ──────────────────────────────

export interface MergeTopicsInput {
  /** 参与合并的旧社区 topic_id；至少一个，合并后它们不再是独立主题 */
  oldTopicIds: readonly number[];
  /** 合并后的新社区 topic_id（一般由巩固任务重新分配的社区 id） */
  newTopicId: number;
  archiveDir: string;
  roots: WriteRoots;
  now?: string;
}

export interface MergedTopicRef {
  /** 旧 topic_id（字符串键，与 archive_meta 一致） */
  topicId: string;
  slug: string;
  path: string;
}

export interface MergeTopicsResult {
  /** 存活的记账已经迁到新 topic_id，slug/path 取存活更久的那个 */
  survivor: { topicId: string; slug: string; path: string };
  /** 被合并掉的主题：文件仍在，内容已改为「已并入 X」跳转 */
  merged: MergedTopicRef[];
}

/**
 * 「存活时间更长」= `last_exported_at` 更早（详设 §9.5 L2850）。
 * 从未导出过（NULL）视为最新，不参与竞争；同一时刻导出按 topic_id 升序稳定选择。
 */
function exportedRank(meta: ArchiveMetaRow): string {
  return meta.lastExportedAt ?? '\uFFFF';
}

/**
 * 合并：源主题里挑出存活更久的 slug 迁到 `newTopicId`；其余写跳转文档并标 `merged`。
 * 不删除任何文件，也不删除 archive_meta 行（被合并的旧行保留，status='merged'）。
 */
export function mergeTopics(db: Db, input: MergeTopicsInput): MergeTopicsResult {
  const newKey = String(input.newTopicId);
  const oldKeys = [...new Set(input.oldTopicIds.map(String))];
  if (oldKeys.length === 0) {
    throw new MoshiError('E_INPUT', '合并至少需要一个旧 topic_id', { reason: 'old_topics_empty' });
  }
  if (oldKeys.includes(newKey)) {
    throw new MoshiError('E_INPUT', `新 topic_id 不能同时是旧 topic_id：${newKey}`, {
      reason: 'new_topic_in_old',
    });
  }
  if (getArchiveMeta(db, newKey) !== null) {
    throw new MoshiError('E_INPUT', `新 topic_id 已有归档记账，无法合并：${newKey}`, {
      reason: 'merge_target_has_meta',
      topicId: newKey,
    });
  }

  const metas: ArchiveMetaRow[] = [];
  for (const key of oldKeys) {
    const meta = getArchiveMeta(db, key);
    if (meta === null) {
      throw new MoshiError('E_NOT_FOUND', `归档主题不存在：${key}`, {
        reason: 'topic_not_in_archive',
        topicId: key,
      });
    }
    metas.push(meta);
  }

  const survivor = [...metas].sort((a, b) => {
    const byTime = exportedRank(a).localeCompare(exportedRank(b));
    if (byTime !== 0) return byTime;
    return Number(a.topicId) - Number(b.topicId);
  })[0]!;

  // 存活主题的记账迁到新社区 id；slug/path/revision/content_hash 全部保留
  reassignArchiveTopic(db, survivor.topicId, newKey);
  updateArchiveMetaState(db, newKey, { status: 'active' });

  const merged: MergedTopicRef[] = [];
  for (const meta of metas) {
    if (meta.topicId === survivor.topicId) continue;
    const target = mainFilePath(input.archiveDir, meta.slug, meta.path);
    const text = redirectDocument(meta, {
      slug: survivor.slug,
      title: survivor.title ?? survivor.slug,
      path: survivor.path,
    });
    safeEnsureDir(path.dirname(target), input.roots);
    safeWriteFile(target, text, input.roots);
    updateArchiveMetaState(db, meta.topicId, {
      status: 'merged',
      contentHash: bodyHashOfDocument(text),
      dirty: 0,
    });
    merged.push({ topicId: meta.topicId, slug: meta.slug, path: meta.path });
  }

  return {
    survivor: { topicId: newKey, slug: survivor.slug, path: survivor.path },
    merged,
  };
}

/** 跳转文档：frontmatter 只写指针 + 正文一行「已并入」；不复制任何原文 */
function redirectDocument(
  meta: ArchiveMetaRow,
  survivor: { slug: string; title: string; path: string },
): string {
  return [
    '---',
    `topic_id: ${meta.topicId}`,
    `slug: ${meta.slug}`,
    `title: ${meta.title ?? meta.slug}`,
    'status: merged',
    `merged_into: ${survivor.slug}`,
    '---',
    '',
    `# 已并入 ${survivor.title}`,
    '',
    `本主题已合并到「${survivor.title}」，归档见 \`${survivor.path}\`。本文件仅作跳转，不再更新。`,
    '',
  ].join('\n');
}

// ────────────────────────────── 分裂 ──────────────────────────────

export interface SplitTopicsInput {
  /** 被拆分的旧社区 topic_id */
  oldTopicId: number;
  /** 拆分后的新社区 topic_id 列表（≥1） */
  newTopicIds: readonly number[];
  /** 新主题展示名（用于 banner）；缺省 `topic-<id>` */
  titles?: Readonly<Record<number, string>>;
  archiveDir: string;
  roots: WriteRoots;
  now?: string;
}

export interface SplitNewTopicRef {
  topicId: string;
  slug: string;
  title: string;
  path: string;
  /** 本次是否新建了记账骨架（false = 已有记账，复用原 slug） */
  created: boolean;
}

export interface SplitTopicsResult {
  old: { topicId: string; slug: string; path: string; status: 'split'; annotated: boolean };
  newTopics: SplitNewTopicRef[];
}

/**
 * 分裂：新主题先占 slug（下一次导出渲染正文）；旧主题文档保留，正文顶部加
 * 「已拆分为 A / B」，status='split'，content_hash 基线同步为标记后的正文 hash。
 * 幂等：重复调用不会重复插入 banner，也不会重复建新主题记账。
 */
export function splitTopics(db: Db, input: SplitTopicsInput): SplitTopicsResult {
  const oldKey = String(input.oldTopicId);
  const newKeys = [...new Set(input.newTopicIds.map(String))].filter((k) => k !== oldKey);
  if (input.newTopicIds.length === 0) {
    throw new MoshiError('E_INPUT', '分裂至少需要一个新 topic_id', { reason: 'new_topics_empty' });
  }
  if (newKeys.length !== input.newTopicIds.length) {
    throw new MoshiError('E_INPUT', '新 topic_id 不能包含被拆分的旧 topic_id，也不能重复', {
      reason: 'new_topics_invalid',
    });
  }

  const oldMeta = getArchiveMeta(db, oldKey);
  if (oldMeta === null) {
    throw new MoshiError('E_NOT_FOUND', `归档主题不存在：${oldKey}`, {
      reason: 'topic_not_in_archive',
      topicId: oldKey,
    });
  }
  const oldFile = mainFilePath(input.archiveDir, oldMeta.slug, oldMeta.path);
  const oldText = readTextFile(oldFile);
  if (oldText === null) {
    throw new MoshiError('E_INPUT', `归档主文件不存在：${oldFile}`, {
      reason: 'archive_file_missing',
      slug: oldMeta.slug,
      path: oldMeta.path,
    });
  }

  const taken = new Set(listSlugs(db));
  const newTopics: SplitNewTopicRef[] = [];
  for (const key of newKeys) {
    const existing = getArchiveMeta(db, key);
    if (existing !== null) {
      newTopics.push({
        topicId: key,
        slug: existing.slug,
        title: existing.title ?? existing.slug,
        path: existing.path,
        created: false,
      });
      continue;
    }
    const numericId = Number(key);
    const title = input.titles?.[numericId] ?? `topic-${key}`;
    const slug = slugFor(title, numericId, taken);
    taken.add(slug);
    const relativePath = topicRelativePath(slug);
    createArchiveMetaPlaceholder(db, { topicId: key, slug, title, path: relativePath });
    newTopics.push({ topicId: key, slug, title, path: relativePath, created: true });
  }

  const names = newTopics.map((t) => t.title).join(' / ');
  let annotated = false;
  let contentHash: string;
  if (oldText.includes('> **已拆分为')) {
    contentHash = bodyHashOfDocument(oldText);
  } else {
    const banner = `> **已拆分为 ${names}**\n>\n> 本文件是拆分前主题的历史归档，后续内容见各新主题文档。`;
    const withBanner = insertAfterFrontmatter(oldText, banner);
    // 正文 hash 不受 frontmatter 影响，先算再回填行内 content_hash（避免文件里留旧值）
    contentHash = bodyHashOfDocument(withBanner);
    const finalText = withBanner.replace(/\ncontent_hash: .*/, `\ncontent_hash: ${contentHash}`);
    safeWriteFile(oldFile, finalText, input.roots);
    annotated = true;
  }

  updateArchiveMetaState(db, oldKey, { status: 'split', contentHash, dirty: 0 });

  return {
    old: { topicId: oldKey, slug: oldMeta.slug, path: oldMeta.path, status: 'split', annotated },
    newTopics,
  };
}

/** 在 frontmatter 之后插入 banner；没有 frontmatter 则加在文件最前面 */
function insertAfterFrontmatter(text: string, banner: string): string {
  const norm = text.replace(/\r\n/g, '\n');
  if (norm.startsWith('---\n')) {
    const end = norm.indexOf('\n---\n', 4);
    if (end >= 0) {
      const head = norm.slice(0, end + 5); // 含结尾的 ---\n
      const rest = norm.slice(end + 5).replace(/^\n+/, '');
      return `${head}\n${banner}\n\n${rest}`;
    }
  }
  return `${banner}\n\n${norm}`;
}

// ────────────────────────────── 台账 ──────────────────────────────

export const ARCHIVE_LEDGER_SCHEMA = 'moshi-archive-ledger/1';
export const ARCHIVE_LEDGER_FILE = '.moshi-archive.json';

export interface ArchiveLedgerTopic {
  topic_id: string;
  slug: string;
  /** 相对 archive_dir 的路径 */
  path: string;
  revision: number;
  content_hash: string | null;
  status: ArchiveStatus;
}

export interface ArchiveLedger {
  schema: typeof ARCHIVE_LEDGER_SCHEMA;
  generated_at: string;
  topics: ArchiveLedgerTopic[];
}

export interface LedgerDiff {
  topicId: string;
  kind: 'missing_in_ledger' | 'extra_in_ledger' | 'field_mismatch';
  field?: keyof ArchiveLedgerTopic;
  ledger?: string | number | null;
  db?: string | number | null;
}

export interface WriteArchiveLedgerResult {
  path: string;
  ledger: ArchiveLedger;
  /** 写之前旧台账与 DB 的差异（重建后归零；doctor 可用） */
  differences: LedgerDiff[];
  consistent: boolean;
}

function topicIdOrder(a: ArchiveMetaRow, b: ArchiveMetaRow): number {
  const byNumber = Number(a.topicId) - Number(b.topicId);
  if (Number.isFinite(byNumber) && byNumber !== 0) return byNumber;
  return a.topicId.localeCompare(b.topicId);
}

/** 以 DB（archive_meta）为准构建台账对象 */
export function buildArchiveLedger(db: Db, now: string = nowIso()): ArchiveLedger {
  const metas = [...listArchiveMeta(db, 1_000_000)].sort(topicIdOrder);
  return {
    schema: ARCHIVE_LEDGER_SCHEMA,
    generated_at: now,
    topics: metas.map((m) => ({
      topic_id: m.topicId,
      slug: m.slug,
      path: m.path,
      revision: m.revision,
      content_hash: m.contentHash,
      status: m.status,
    })),
  };
}

export function archiveLedgerPath(archiveDir: string): string {
  return path.join(archiveDir, ARCHIVE_LEDGER_FILE);
}

/** 读旧台账；文件不存在 / JSON 损坏 / schema 不对一律返回 null（doctor 视为需重建） */
export function readArchiveLedger(archiveDir: string): ArchiveLedger | null {
  const text = readTextFile(archiveLedgerPath(archiveDir));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<ArchiveLedger>;
    if (parsed.schema !== ARCHIVE_LEDGER_SCHEMA || !Array.isArray(parsed.topics)) return null;
    return {
      schema: ARCHIVE_LEDGER_SCHEMA,
      generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : '',
      topics: parsed.topics as ArchiveLedgerTopic[],
    };
  } catch {
    return null;
  }
}

/** 台账 ↔ DB 差异（以 DB 为准）；供 doctor / `moshi export` 提示 */
export function diffArchiveLedger(db: Db, ledger: ArchiveLedger): LedgerDiff[] {
  const dbTopics = buildArchiveLedger(db).topics;
  const dbMap = new Map(dbTopics.map((t) => [t.topic_id, t]));
  const ledgerMap = new Map(ledger.topics.map((t) => [t.topic_id, t]));
  const diffs: LedgerDiff[] = [];

  for (const [topicId, dbTopic] of dbMap) {
    const ledgerTopic = ledgerMap.get(topicId);
    if (ledgerTopic === undefined) {
      diffs.push({ topicId, kind: 'missing_in_ledger' });
      continue;
    }
    for (const field of ['slug', 'path', 'revision', 'content_hash', 'status'] as const) {
      if (ledgerTopic[field] !== dbTopic[field]) {
        diffs.push({
          topicId,
          kind: 'field_mismatch',
          field,
          ledger: ledgerTopic[field],
          db: dbTopic[field],
        });
      }
    }
  }
  for (const topicId of ledgerMap.keys()) {
    if (!dbMap.has(topicId)) diffs.push({ topicId, kind: 'extra_in_ledger' });
  }
  return diffs;
}

/**
 * 重建 `<archive_dir>/.moshi-archive.json`：读旧台账 → 比差异 → 按 DB 全量写回。
 * 返回写之前的差异，便于调用方提示「台账已按 DB 重建」。
 */
export function writeArchiveLedger(
  db: Db,
  opts: { archiveDir: string; roots: WriteRoots; now?: string },
): WriteArchiveLedgerResult {
  const target = archiveLedgerPath(opts.archiveDir);
  const previous = readArchiveLedger(opts.archiveDir);
  const differences = previous === null ? [] : diffArchiveLedger(db, previous);
  const ledger = buildArchiveLedger(db, opts.now);
  safeEnsureDir(opts.archiveDir, opts.roots);
  safeWriteFile(target, `${JSON.stringify(ledger, null, 2)}\n`, opts.roots);
  return { path: target, ledger, differences, consistent: differences.length === 0 };
}
