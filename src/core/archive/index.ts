/**
 * 归档全量导出（详设 §9.1–§9.4；台账 P1-15）。
 *
 * 流程：selectTopics → 逐个 renderTopic → 与 archive_meta 比对 content_hash：
 * hash 未变不写盘（增量失效），变了才更新 revision/content_hash/last_exported_at。
 * 单主题 < 300ms、10k 事实全量 < 60s 由实现线性遍历保证（无 N+1 重查询热点）。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { nowIso } from '../../domain/time.js';
import { getArchiveMeta, listSlugs, upsertArchiveMeta } from '../../infra/sqlite/archiveRepo.js';
import { selectTopics, slugFor } from './topics.js';
import { renderTopic, type ArchiveDoc } from './render.js';

/** 渲染 + 写回 archive_meta（hash 未变不写盘）。返回（topicId, 是否写盘） */
export function archiveTopic(db: Db, topicId: number, opts: { now?: string; title?: string } = {}): { doc: ArchiveDoc; written: boolean } {
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
  const doc: ArchiveDoc = { ...rendered, slug };

  const unchanged = prev !== null && prev.contentHash === doc.contentHash;
  if (unchanged) {
    return { doc, written: false };
  }

  upsertArchiveMeta(db, {
    topicId: key,
    slug: doc.slug,
    title: doc.title,
    contentHash: doc.contentHash,
    revision: doc.revision,
    exportedAt: now,
  });
  return { doc, written: true };
}

export interface ArchiveAllResult {
  docs: ArchiveDoc[];
  /** content_hash 变化的文档（需要写盘的那部分）；`docs` 里其余是未变主题 */
  changedDocs: ArchiveDoc[];
  written: number;
  elapsedMs: number;
}

/** 全量导出：所有达标主题；返回文档与写盘数 */
export function archiveAll(db: Db, opts: { now?: string } = {}): ArchiveAllResult {
  const started = Date.now();
  const topics = selectTopics(db);
  const docs: ArchiveDoc[] = [];
  const changedDocs: ArchiveDoc[] = [];
  let written = 0;
  for (const t of topics) {
    const { doc, written: w } = archiveTopic(db, t.communityId, {
      now: opts.now,
      title: t.label ?? undefined,
    });
    docs.push(doc);
    if (w) {
      written += 1;
      changedDocs.push(doc);
    }
  }
  return { docs, changedDocs, written, elapsedMs: Date.now() - started };
}
