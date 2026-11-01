/**
 * `moshi export`（详设 §9.1–§9.4；台账 P1-21）。
 *
 * 把 `core/archive` 的归档结果落到 `storage.archive_dir`：一个主题一个 `<slug>.md`，
 * 内容是 frontmatter（topic_id / slug / revision / derived_at / content_hash / 统计）
 * 加渲染正文。只有 `content_hash` 变了的主题才写盘——增量语义在 `archiveAll` 里，
 * 这里只负责把 `changedDocs` 落文件。
 *
 * 主题为 0 不是错误：`selectTopics` 要求社区划分（P2-11）产出 `community_id`，
 * 没划分时真实库必然导出 0 篇，命令如实打印并退出 0。
 */
import path from 'node:path';
import { archiveAll } from '../../../core/archive/index.js';
import type { ArchiveDoc } from '../../../core/archive/render.js';
import { expandHome } from '../../config.js';
import { safeEnsureDir, safeWriteFile } from '../../../infra/fs/safeWrite.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { ensureDataDirs } from '../../lifecycle.js';
import type { Command } from '../types.js';

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

export const exportCommand: Command = {
  name: 'export',
  summary: '导出主题归档文档（moshi export --all）',
  async run(ctx) {
    const args = ctx.args;
    const outAt = args.indexOf('--out');
    const outDir =
      outAt >= 0 && args[outAt + 1] !== undefined
        ? expandHome(args[outAt + 1]!, ctx.home)
        : ctx.cfg.storage.archive_dir;

    const paths = ensureDataDirs(ctx.cfg);
    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });
      const started = Date.now();
      const res = archiveAll(db);

      if (res.docs.length === 0) {
        ctx.stdout('导出 0 篇：没有达标主题（社区未划分时 selectTopics 为空，属预期）\n');
        return 0;
      }

      // 白名单：只允许写 archive_dir 与数据根；`--out` 指到别处会在这里被拒（E_ACCESS）
      const roots = [ctx.cfg.storage.archive_dir, paths.root];
      safeEnsureDir(outDir, roots);
      for (const doc of res.changedDocs) {
        safeWriteFile(path.join(outDir, archiveFileName(doc)), `${frontmatterOf(doc)}\n\n${doc.body}\n`, roots);
      }

      const unchanged = res.docs.length - res.changedDocs.length;
      ctx.stdout(
        `导出 ${res.docs.length} 篇（写盘 ${res.changedDocs.length}、未变 ${unchanged}）→ ${outDir}，${Date.now() - started}ms\n`,
      );
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
