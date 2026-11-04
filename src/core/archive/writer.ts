/**
 * 归档落盘与三选一（详设 §9.4 L2815-2841；台账 P2-15）。
 *
 * 职责边界：
 *   - guard.ts 只做判定；本模块负责把正文变成文件、维护 archive_meta、写 _history。
 *   - CLI / HTTP 都调这里，不允许自己拼 frontmatter 或直接写盘。
 *   - 写盘一律走 `safeWriteFile`（白名单 + `.tmp` rename 原子写），不物理删除任何文件。
 *
 * content_hash 口径：只对稳定正文算（不含 frontmatter，也不含尾部「## 本次更新」派生段）。
 * 因此从磁盘文本重算 hash 时必须先剥掉这两段，否则与 `render.ts` 的 contentHash 永不相等。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MoshiError } from '../../domain/errors.js';
import { sha256Hex } from '../../domain/hash.js';
import { nowIso } from '../../domain/time.js';
import { safeEnsureDir, safeWriteFile, type WriteRoots } from '../../infra/fs/safeWrite.js';
import {
  getArchiveMetaBySlug,
  updateArchiveMetaState,
  type HumanEdited,
} from '../../infra/sqlite/archiveRepo.js';
import type { Db } from '../../infra/sqlite/db.js';
import type { ArchiveDoc } from './render.js';

export type ProposalAction = 'accept_auto' | 'keep_human' | 'promote_human';

/** frontmatter；`derived_at` 每次导出都变，但它不进 content_hash（P1-15） */
export function frontmatterOf(doc: ArchiveDoc): string {
  return [
    '---',
    `topic_id: ${doc.topicId}`,
    `slug: ${doc.slug}`,
    `title: ${doc.title}`,
    `revision: ${doc.revision}`,
    `derived_at: ${doc.derivedAt}`,
    `content_hash: ${doc.contentHash}`,
    `fact_count: ${doc.factCount}`,
    `edge_count: ${doc.edgeCount}`,
    `confidence_avg: ${doc.confidenceAvg.toFixed(3)}`,
    `strength_avg: ${doc.strengthAvg.toFixed(3)}`,
    '---',
  ].join('\n');
}

export function archiveFileName(doc: ArchiveDoc): string {
  return `${doc.slug}.md`;
}

/** 完整文件内容 = frontmatter + 空行 + 渲染正文 + 尾换行 */
export function documentText(doc: ArchiveDoc): string {
  return `${frontmatterOf(doc)}\n\n${doc.body}\n`;
}

/** 相对 archive_dir 的正文路径（详设 §9.4 嵌套布局） */
export function topicRelativePath(slug: string): string {
  return `topics/${slug}/${slug}.md`;
}

/** archive_meta.path 是相对 archive_dir 的路径；meta 无记录时用默认嵌套路径 */
export function mainFilePath(archiveDir: string, slug: string, relativePath?: string | null): string {
  return path.join(archiveDir, relativePath ?? topicRelativePath(slug));
}

/** 待决文件与主文件同目录：`<slug>.proposed.md` */
export function proposedFilePath(mainFile: string, slug: string): string {
  return path.join(path.dirname(mainFile), `${slug}.proposed.md`);
}

/** 历史版本：`_history/<slug>@<YYYY-MM-DD>.md` */
export function historyFilePath(archiveDir: string, slug: string, date: string): string {
  return path.join(archiveDir, '_history', `${slug}@${date}.md`);
}

/**
 * 只读一篇归档正文（`GET /api/archive/topics/:slug` 用；详设 §4.3）。
 *
 * `archive_meta.path` 来自 DB，不能直接信任：先解析成绝对路径，再断言它仍在
 * `archiveDir` 内（越界按「文件缺失」返回 null，不读库外文件）。文件不存在同样返回
 * null，页面据此降级——只读接口不写库、不建目录、不抛 404（404 只用于 slug 不存在）。
 */
export function readArchiveMarkdown(archiveDir: string, relativePath: string | null | undefined): string | null {
  if (relativePath === null || relativePath === undefined || relativePath === '') return null;
  const root = path.resolve(archiveDir);
  const file = path.resolve(root, relativePath);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  return readTextFile(file);
}

/** 读文本；不存在返回 null（ENOENT），其余 IO 错误照抛 */
export function readTextFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 从磁盘文件文本重算稳定正文 hash；文件不存在返回 null */
export function readDiskBodyHash(file: string): string | null {
  const text = readTextFile(file);
  return text === null ? null : bodyHashOfDocument(text);
}

/**
 * 剥 frontmatter + 尾部「## 本次更新」后算 hash。
 *
 * 兼容人工编辑造成的细微结构差异：frontmatter 缺失时整段当正文；「本次更新」只认行首
 * 两空行 + 标题的派生段（人的正文里若有同名二级标题但不在文件末尾，也不会被剥掉）。
 */
export function bodyHashOfDocument(text: string): string {
  // 行尾统一成 LF 再算：Windows 编辑器把文件改成 CRLF 不算内容变化
  let rest = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (rest.startsWith('---\n')) {
    const end = rest.indexOf('\n---\n', 4);
    if (end >= 0) rest = rest.slice(end + 5).replace(/^\n/, '');
  }
  const marker = '\n\n## 本次更新\n\n';
  const at = rest.lastIndexOf(marker);
  if (at >= 0) rest = rest.slice(0, at);
  // render 的稳定正文不含尾换行；文件尾多出的换行不算内容变化
  rest = rest.replace(/\n+$/, '');
  return sha256Hex(rest);
}

export interface WriteAutoResult {
  path: string;
  historyPath: string | null;
}

/** 自动版写盘（原子）+ 每 5 版复制一份到 _history */
export function writeAutoDocument(
  doc: ArchiveDoc,
  opts: { archiveDir: string; mainFile: string; roots: WriteRoots },
): WriteAutoResult {
  const text = documentText(doc);
  safeEnsureDir(path.dirname(opts.mainFile), opts.roots);
  safeWriteFile(opts.mainFile, text, opts.roots);

  let historyPath: string | null = null;
  if (doc.revision > 0 && doc.revision % 5 === 0) {
    historyPath = historyFilePath(opts.archiveDir, doc.slug, doc.derivedAt.slice(0, 10));
    safeEnsureDir(path.dirname(historyPath), opts.roots);
    safeWriteFile(historyPath, text, opts.roots);
  }
  return { path: opts.mainFile, historyPath };
}

/** 自动版写入待决文件（不覆盖主文件） */
export function writeProposedDocument(doc: ArchiveDoc, opts: { mainFile: string; roots: WriteRoots }): string {
  const target = proposedFilePath(opts.mainFile, doc.slug);
  safeEnsureDir(path.dirname(target), opts.roots);
  safeWriteFile(target, documentText(doc), opts.roots);
  return target;
}

export interface ApplyProposalInput {
  slug: string;
  action: ProposalAction;
  archiveDir: string;
  roots: WriteRoots;
  now?: string;
}

export interface ApplyProposalResult {
  slug: string;
  topicId: string;
  action: ProposalAction;
  humanEdited: HumanEdited;
  revision: number;
  contentHash: string;
  /** 主文件绝对路径 */
  path: string;
  historyPath: string | null;
}

/**
 * 三选一执行（详设 §9.4 L2836-2839）。
 *
 * - accept_auto：`.proposed.md` 原样覆盖主文件，revision+1、human_edited=0
 * - keep_human：只把人工版正文 hash 记为基线并置 human_edited=2（不写盘、不删文件）
 * - promote_human：人工版 hash 记为基线、human_edited=0（改动仍留在磁盘上）
 */
export function applyProposal(db: Db, input: ApplyProposalInput): ApplyProposalResult {
  const meta = getArchiveMetaBySlug(db, input.slug);
  if (meta === null) {
    throw new MoshiError('E_NOT_FOUND', `归档主题不存在：${input.slug}`, {
      reason: 'slug_not_found',
      slug: input.slug,
    });
  }
  const mainFile = mainFilePath(input.archiveDir, meta.slug, meta.path);
  const mainText = readTextFile(mainFile);
  if (mainText === null) {
    throw new MoshiError('E_INPUT', `归档主文件不存在：${mainFile}`, {
      reason: 'archive_file_missing',
      slug: meta.slug,
      path: meta.path,
    });
  }
  const now = input.now ?? nowIso();

  if (input.action === 'accept_auto') {
    const proposedFile = proposedFilePath(mainFile, meta.slug);
    const proposedText = readTextFile(proposedFile);
    if (proposedText === null) {
      throw new MoshiError('E_INPUT', `没有待合并的 .proposed.md：${proposedFile}`, {
        reason: 'proposed_missing',
        slug: meta.slug,
      });
    }
    const contentHash = bodyHashOfDocument(proposedText);
    safeEnsureDir(path.dirname(mainFile), input.roots);
    safeWriteFile(mainFile, proposedText, input.roots);

    const revision = meta.revision + 1;
    updateArchiveMetaState(db, meta.topicId, {
      contentHash,
      revision,
      lastExportedAt: now,
      humanEdited: 0,
      dirty: 0,
    });

    let historyPath: string | null = null;
    if (revision > 0 && revision % 5 === 0) {
      historyPath = historyFilePath(input.archiveDir, meta.slug, now.slice(0, 10));
      safeEnsureDir(path.dirname(historyPath), input.roots);
      safeWriteFile(historyPath, proposedText, input.roots);
    }
    return {
      slug: meta.slug,
      topicId: meta.topicId,
      action: input.action,
      humanEdited: 0,
      revision,
      contentHash,
      path: mainFile,
      historyPath,
    };
  }

  if (input.action === 'keep_human') {
    const contentHash = bodyHashOfDocument(mainText);
    updateArchiveMetaState(db, meta.topicId, { contentHash, humanEdited: 2 });
    return {
      slug: meta.slug,
      topicId: meta.topicId,
      action: input.action,
      humanEdited: 2,
      revision: meta.revision,
      contentHash,
      path: mainFile,
      historyPath: null,
    };
  }

  if (input.action === 'promote_human') {
    const contentHash = bodyHashOfDocument(mainText);
    updateArchiveMetaState(db, meta.topicId, { contentHash, humanEdited: 0, dirty: 0 });
    return {
      slug: meta.slug,
      topicId: meta.topicId,
      action: input.action,
      humanEdited: 0,
      revision: meta.revision,
      contentHash,
      path: mainFile,
      historyPath: null,
    };
  }

  throw new MoshiError('E_INPUT', `未知的 action：${String(input.action)}`, {
    reason: 'action_invalid',
  });
}
