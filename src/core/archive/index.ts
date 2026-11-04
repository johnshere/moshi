/**
 * 归档全量导出（详设 §9.1–§9.4；台账 P1-15 / P2-15）。
 *
 * 流程：selectTopics → 逐个 renderTopic → guard 判定（磁盘 hash / 基线 hash / 三态）
 * → writer 落盘（或写 `.proposed.md`）→ 更新 archive_meta。
 *
 * 两种调用形态：
 *   - 传 `archiveDir`：完整 §9.4 落盘语义（CLI / 调度器）；
 *   - 不传：只维护 archive_meta（旧 P1-15 行为，供 archive.test.ts 等单元测试）。
 *
 * 写盘白名单 roots 缺省为 `[archiveDir]`；CLI 传 `[cfg.storage.archive_dir, data_dir]`，
 * 与旧实现一致（`--out` 指到别处仍会 E_ACCESS）。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { nowIso } from '../../domain/time.js';
import {
  getArchiveMeta,
  listSlugs,
  updateArchiveMetaState,
  upsertArchiveMeta,
  type HumanEdited,
} from '../../infra/sqlite/archiveRepo.js';
import type { WriteRoots } from '../../infra/fs/safeWrite.js';
import { selectTopics, slugFor } from './topics.js';
import { renderTopic, type ArchiveDoc } from './render.js';
import { decideArchiveWrite, type ArchiveWriteAction } from './guard.js';
import {
  mainFilePath,
  readDiskBodyHash,
  topicRelativePath,
  writeAutoDocument,
  writeProposedDocument,
} from './writer.js';

export interface ArchiveTopicOptions {
  now?: string;
  title?: string;
  /** 归档根目录；给定时才真正落盘（CLI / 调度器传），不传只维护 archive_meta */
  archiveDir?: string;
  /** 写盘白名单；缺省 `[archiveDir]` */
  roots?: WriteRoots;
}

export interface ArchiveTopicResult {
  doc: ArchiveDoc;
  /** 主文件是否被自动版覆盖（propose/skip 均为 false） */
  written: boolean;
  /** 本轮是否写了 `.proposed.md`（人工编辑待三选一） */
  proposed: boolean;
  action: ArchiveWriteAction;
  /** 实际生效的 revision（propose/skip 不变，write 自增） */
  revision: number;
  humanEdited: HumanEdited;
  /** 主文件绝对路径；未传 archiveDir 时为 null */
  path: string | null;
  /** `.proposed.md` 绝对路径；未生成为 null */
  proposedPath: string | null;
}

/** 渲染 + 判定 +（可选）写盘。返回本次动作与结果 */
export function archiveTopic(db: Db, topicId: number, opts: ArchiveTopicOptions = {}): ArchiveTopicResult {
  const now = opts.now ?? nowIso();
  const key = String(topicId); // archive_meta.topic_id 是 TEXT 主键：统一字符串键避免 1 vs '1.0' 类不匹配
  const prev = getArchiveMeta(db, key);

  const taken = new Set(listSlugs(db));
  const rendered = renderTopic(db, topicId, {
    now,
    title: opts.title,
    revision: (prev?.revision ?? 0) + 1,
    lastExportedAt: prev?.lastExportedAt ?? null,
  });
  const slug = prev?.slug ?? slugFor(opts.title ?? null, topicId, taken);

  // 合并/分裂后的历史文档不再自动导出（P2-16）：自动重写会抹掉「已并入 X」/「已拆分为 A / B」
  // 的标记。跳转与拆分状态只由 mergeTopics / splitTopics 写入，需人工或后续任务显式变更。
  if (prev !== null && prev.status !== 'active') {
    return {
      doc: { ...rendered, slug, revision: prev.revision },
      written: false,
      proposed: false,
      action: 'skip',
      revision: prev.revision,
      humanEdited: prev.humanEdited,
      path: opts.archiveDir === undefined ? null : mainFilePath(opts.archiveDir, slug, prev.path),
      proposedPath: null,
    };
  }

  // ── 旧行为：不传 archiveDir 不落盘，只维护 archive_meta（兼容旧测试与纯记账调用） ──
  if (opts.archiveDir === undefined) {
    const doc: ArchiveDoc = { ...rendered, slug };
    const unchanged = prev !== null && prev.contentHash === doc.contentHash;
    if (unchanged) {
      const revision = prev.revision;
      return {
        doc: { ...doc, revision },
        written: false,
        proposed: false,
        action: 'skip',
        revision,
        humanEdited: prev.humanEdited,
        path: null,
        proposedPath: null,
      };
    }
    upsertArchiveMeta(db, {
      topicId: key,
      slug: doc.slug,
      title: doc.title,
      contentHash: doc.contentHash,
      revision: doc.revision,
      exportedAt: now,
    });
    return {
      doc,
      written: true,
      proposed: false,
      action: 'write',
      revision: doc.revision,
      humanEdited: 0,
      path: null,
      proposedPath: null,
    };
  }

  // ── 完整 §9.4：读磁盘 → guard → writer ──
  const archiveDir = opts.archiveDir;
  const roots = opts.roots ?? [archiveDir];
  const relativePath = prev?.path ?? topicRelativePath(slug);
  const mainFile = mainFilePath(archiveDir, slug, prev?.path ?? null);
  const diskHash = readDiskBodyHash(mainFile);

  const decision = decideArchiveWrite({
    targetHash: rendered.contentHash,
    diskHash,
    metaHash: prev?.contentHash ?? null,
    humanEdited: prev?.humanEdited ?? 0,
    revision: prev?.revision ?? 0,
  });

  if (decision.action === 'skip') {
    return {
      doc: { ...rendered, slug, revision: decision.revision },
      written: false,
      proposed: false,
      action: 'skip',
      revision: decision.revision,
      humanEdited: decision.humanEdited,
      path: mainFile,
      proposedPath: null,
    };
  }

  if (decision.action === 'propose') {
    // 待决文件用「将被应用的版本」= 当前 revision + 1，accept_auto 时原样覆盖、revision 对齐
    const proposedDoc: ArchiveDoc = { ...rendered, slug, revision: decision.revision + 1 };
    const proposedPath = writeProposedDocument(proposedDoc, { mainFile, roots });

    if (prev === null) {
      // 归档目录里已有文件但 archive_meta 没记录：把磁盘正文当基线，等人工三选一
      upsertArchiveMeta(db, {
        topicId: key,
        slug,
        title: proposedDoc.title,
        contentHash: diskHash ?? proposedDoc.contentHash,
        revision: decision.revision,
        exportedAt: now,
        path: relativePath,
      });
    }
    updateArchiveMetaState(db, key, { humanEdited: 1, slug, path: relativePath });

    return {
      doc: proposedDoc,
      written: false,
      proposed: true,
      action: 'propose',
      revision: decision.revision,
      humanEdited: 1,
      path: mainFile,
      proposedPath,
    };
  }

  // decision.action === 'write'
  const doc: ArchiveDoc = { ...rendered, slug, revision: decision.revision };
  writeAutoDocument(doc, { archiveDir, mainFile, roots });
  upsertArchiveMeta(db, {
    topicId: key,
    slug: doc.slug,
    title: doc.title,
    contentHash: doc.contentHash,
    revision: doc.revision,
    exportedAt: now,
    path: relativePath,
  });
  // upsert 的 DO UPDATE 故意不碰 human_edited；自动写成功后在这里显式清 0
  updateArchiveMetaState(db, key, { humanEdited: 0, slug, path: relativePath });

  return {
    doc,
    written: true,
    proposed: false,
    action: 'write',
    revision: doc.revision,
    humanEdited: 0,
    path: mainFile,
    proposedPath: null,
  };
}

export interface ArchiveAllOptions {
  now?: string;
  /** 归档根目录；给定时落盘（CLI / 调度器） */
  archiveDir?: string;
  /** 写盘白名单；缺省 `[archiveDir]` */
  roots?: WriteRoots;
}

export interface ArchiveAllResult {
  docs: ArchiveDoc[];
  /** content_hash 变化并已写主文件的文档；`docs` 里其余是未变/待合并主题 */
  changedDocs: ArchiveDoc[];
  /** 本轮写了 `.proposed.md`、等待三选一的文档 */
  proposedDocs: ArchiveDoc[];
  /** 写盘（主文件）篇数 */
  written: number;
  /** 生成/刷新 `.proposed.md` 篇数 */
  proposed: number;
  /** 按主题数不变，但记录实际耗时 */
  elapsedMs: number;
}

/** 全量导出：所有达标主题；返回文档、写盘数与待合并数 */
export function archiveAll(db: Db, opts: ArchiveAllOptions = {}): ArchiveAllResult {
  const started = Date.now();
  const topics = selectTopics(db);
  const docs: ArchiveDoc[] = [];
  const changedDocs: ArchiveDoc[] = [];
  const proposedDocs: ArchiveDoc[] = [];
  let written = 0;
  let proposed = 0;
  for (const t of topics) {
    const res = archiveTopic(db, t.communityId, {
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(t.label === null ? {} : { title: t.label }),
      ...(opts.archiveDir === undefined ? {} : { archiveDir: opts.archiveDir }),
      ...(opts.roots === undefined ? {} : { roots: opts.roots }),
    });
    docs.push(res.doc);
    if (res.written) {
      written += 1;
      changedDocs.push(res.doc);
    }
    if (res.proposed) {
      proposed += 1;
      proposedDocs.push(res.doc);
    }
  }
  return { docs, changedDocs, proposedDocs, written, proposed, elapsedMs: Date.now() - started };
}
