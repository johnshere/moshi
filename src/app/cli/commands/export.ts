/**
 * `moshi export`（详设 §9.1–§9.4；台账 P1-21 / P2-15）。
 *
 * 本命令只做参数解析、打开库、调 `archiveAll` 与打印：渲染/判定/落盘全在
 * `core/archive`（guard + writer）。这样 CLI 与调度器（P2-17）走同一条写盘路径，
 * 人工编辑保护不会因为入口不同而漏掉。
 *
 * 输出首行保持旧契约：`导出 N 篇（写盘 W、未变 U）→ outDir，Xms`；
 * 有待合并主题时另起一行，但首行字段不受影响（旧测试与外部脚本依赖）。
 */
import { archiveAll } from '../../../core/archive/index.js';
import { writeArchiveLedger } from '../../../core/archive/topic.js';
import { expandHome } from '../../config.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { ensureDataDirs } from '../../lifecycle.js';
import type { Command } from '../types.js';

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
      // 白名单：只允许写 archive_dir 与数据根；`--out` 指到别处会在 writer 里被拒（E_ACCESS）
      const roots = [ctx.cfg.storage.archive_dir, paths.root];
      const res = archiveAll(db, { archiveDir: outDir, roots });
      const elapsed = Date.now() - started;

      if (res.docs.length === 0) {
        ctx.stdout('导出 0 篇：没有达标主题（社区未划分时 selectTopics 为空，属预期）\n');
        return 0;
      }

      const unchanged = res.docs.length - res.changedDocs.length - res.proposedDocs.length;
      ctx.stdout(
        `导出 ${res.docs.length} 篇（写盘 ${res.changedDocs.length}、未变 ${unchanged}）→ ${outDir}，${elapsed}ms\n`,
      );
      if (res.proposed > 0) {
        ctx.stdout(`待合并 ${res.proposed} 篇（已写 .proposed.md，等待三选一）→ ${outDir}\n`);
      }
      // 台账（详设 §9.6）：以 DB 为准重建；旧台账与 DB 的差异提示出来供 doctor 消费
      const ledger = writeArchiveLedger(db, { archiveDir: outDir, roots });
      if (!ledger.consistent) {
        ctx.stdout(`台账与 DB 有 ${ledger.differences.length} 处差异（以 DB 为准，已重建）→ ${ledger.path}\n`);
      }
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
