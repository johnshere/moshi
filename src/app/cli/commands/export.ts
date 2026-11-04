/**
 * `moshi export`（详设 §9.1–§9.4；台账 P1-21 / P2-15 / P2-19-A）。
 *
 * 本命令只做参数解析、打开库、调 `exportArchive` 与打印：渲染/判定/落盘全在
 * `core/archive`（guard + writer + ledger）。CLI 与 `POST /api/archive/export`、
 * 调度器（P2-17）走同一条写盘路径，人工编辑保护不会因为入口不同而漏掉。
 *
 * 参数（P2-19-A 项 4 补齐 `--slug` / `--all`，详设 §4.8）：
 *   - 无 `--slug`：全量导出（旧行为，等价 `--all`）；
 *   - `--slug <slug>`：只导出该归档主题，slug 不存在退出码 1；
 *   - `--all` 与 `--slug` 互斥，同时给退出码 2。
 *
 * 导出前快照（P2-19-A 项 2，概设 §9.4）：
 *   - 仅在「本次确实有文档要写盘」时，先用 `db.backup()` 做一次库快照，
 *     打印 `已快照 -> <path>`；`--no-backup` 可关。
 *   - 「是否有文档要写盘」在真写盘前无法从 `exportArchive` 结果得知，这里用
 *     `willWriteArchiveDocs()` 按 guard 的同一组输入预判（revision/hash/三态
 *     都取自 archive_meta 与磁盘正文），不改归档判定逻辑本身。
 *
 * 输出首行保持旧契约：`导出 N 篇（写盘 W、未变 U）→ outDir，Xms`；
 * 有待合并主题时另起一行，但首行字段不受影响（旧测试与外部脚本依赖）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { exportArchive } from '../../../core/archive/index.js';
import { decideArchiveWrite } from '../../../core/archive/guard.js';
import { renderTopic } from '../../../core/archive/render.js';
import { selectTopics, slugFor } from '../../../core/archive/topics.js';
import { mainFilePath, readDiskBodyHash } from '../../../core/archive/writer.js';
import { nowIso } from '../../../domain/time.js';
import {
  getArchiveMeta,
  getArchiveMetaBySlug,
  listSlugs,
  type ArchiveMetaRow,
} from '../../../infra/sqlite/archiveRepo.js';
import type { Db } from '../../../infra/sqlite/db.js';
import { safeEnsureDir } from '../../../infra/fs/safeWrite.js';
import { expandHome } from '../../config.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { ensureDataDirs } from '../../lifecycle.js';
import type { Command } from '../types.js';

const USAGE = [
  '用法：moshi export [--all | --slug <slug>] [--out <dir>] [--no-backup]',
  '',
  '  （无参数）        全量导出所有达标主题',
  '  --all             同无参数（显式全量）',
  '  --slug <slug>     只导出该归档 slug 对应的主题',
  '  --out <dir>       落盘目录；缺省为 config 的 archive_dir',
  '  --no-backup       有文档要写盘时不生成导出前快照',
  '',
].join('\n');

interface SnapshotPaths {
  backups: string;
  root: string;
}

/** 快照文件名时间戳，与调度器 backup job 同口径（本地时间，秒级） */
function snapshotStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(
    at.getMinutes(),
  )}${pad(at.getSeconds())}`;
}

/**
 * 生成一次导出前快照（`db.backup` 落到 `<data_dir>/backups/`）。
 *
 * 命名加 `export-` 前缀，便于和每日 backup job 的 `moshi-<stamp>.db` 区分；
 * 同秒重复执行时追加序号，不覆盖已有快照。
 */
async function snapshotBeforeExport(
  db: Db,
  paths: SnapshotPaths,
  now: Date,
): Promise<string> {
  safeEnsureDir(paths.backups, [paths.root]);
  const base = `moshi-export-${snapshotStamp(now)}`;
  let file = path.join(paths.backups, `${base}.db`);
  for (let i = 2; existsSync(file); i += 1) file = path.join(paths.backups, `${base}-${i}.db`);
  await db.backup(file);
  return file;
}

/**
 * 预判本次导出是否会写主文件（`exportArchive` 的 `changedDocs` 是否非空）。
 *
 * 与 `archiveTopic` 的判定路径保持一致：同样的 `prev` 三态、同样的渲染输入
 * （now/revision/lastExportedAt/title）、同样的磁盘 hash 与 guard 输入，
 * 只把「写」换成「返回 true」。为空库/全未变/全待合并时返回 false。
 */
function willWriteArchiveDocs(
  db: Db,
  opts: { archiveDir: string; slug?: string; now: string },
): boolean {
  if (opts.slug !== undefined) {
    const meta = getArchiveMetaBySlug(db, opts.slug);
    if (meta === null) return false;
    const topicId = Number(meta.topicId);
    if (!Number.isFinite(topicId)) return false;
    return topicWillWrite(db, topicId, meta.title, opts);
  }

  for (const topic of selectTopics(db)) {
    if (topicWillWrite(db, topic.communityId, topic.label, opts)) return true;
  }
  return false;
}

function topicWillWrite(
  db: Db,
  topicId: number,
  title: string | null,
  opts: { archiveDir: string; now: string },
): boolean {
  const key = String(topicId);
  const prev: ArchiveMetaRow | null = getArchiveMeta(db, key);
  // 合并/分裂后的历史文档不自动导出（P2-16），与 archiveTopic 一致
  if (prev !== null && prev.status !== 'active') return false;

  const taken = new Set(listSlugs(db));
  const rendered = renderTopic(db, topicId, {
    now: opts.now,
    revision: (prev?.revision ?? 0) + 1,
    lastExportedAt: prev?.lastExportedAt ?? null,
    ...(title === null ? {} : { title }),
  });
  const slug = prev?.slug ?? slugFor(title, topicId, taken);
  const mainFile = mainFilePath(opts.archiveDir, slug, prev?.path ?? null);
  const decision = decideArchiveWrite({
    targetHash: rendered.contentHash,
    diskHash: readDiskBodyHash(mainFile),
    metaHash: prev?.contentHash ?? null,
    humanEdited: prev?.humanEdited ?? 0,
    revision: prev?.revision ?? 0,
  });
  return decision.action === 'write';
}

export const exportCommand: Command = {
  name: 'export',
  summary: '导出主题归档文档（moshi export [--all | --slug <slug>]）',
  async run(ctx) {
    const args = ctx.args;
    let outDir = ctx.cfg.storage.archive_dir;
    let slug: string | undefined;
    let all = false;
    let backup = true;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] as string;
      if (arg === '--out' || arg === '--slug') {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          ctx.stderr(`${arg} 需要一个值\n${USAGE}`);
          return 2;
        }
        if (arg === '--out') outDir = expandHome(value, ctx.home);
        else slug = value;
        i += 1;
        continue;
      }
      if (arg === '--all') {
        all = true;
        continue;
      }
      if (arg === '--no-backup') {
        backup = false;
        continue;
      }
      ctx.stderr(`未知参数：${arg}\n${USAGE}`);
      return 2;
    }

    if (all && slug !== undefined) {
      ctx.stderr(`--all 与 --slug 互斥，只能选一个\n${USAGE}`);
      return 2;
    }

    const paths = ensureDataDirs(ctx.cfg);
    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });
      const now = nowIso();
      // 白名单：只允许写 archive_dir 与数据根；`--out` 指到别处会在 writer 里被拒（E_ACCESS）
      const roots = [ctx.cfg.storage.archive_dir, paths.root];

      if (backup && willWriteArchiveDocs(db, { archiveDir: outDir, ...(slug === undefined ? {} : { slug }), now })) {
        let snapshot: string;
        try {
          snapshot = await snapshotBeforeExport(db, paths, new Date());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.stderr(`快照失败：${msg}；已中止导出（确认无需快照可加 --no-backup）\n`);
          return 1;
        }
        ctx.stdout(`已快照 -> ${snapshot}\n`);
      }

      const res = exportArchive(db, { archiveDir: outDir, roots, ...(slug === undefined ? {} : { slug }), now });

      if (res === null) {
        ctx.stderr(`尚未观察到归档主题：${slug}\n`);
        return 1;
      }

      if (res.exported === 0) {
        ctx.stdout('导出 0 篇：没有达标主题（社区未划分时 selectTopics 为空，属预期）\n');
        return 0;
      }

      ctx.stdout(
        `导出 ${res.exported} 篇（写盘 ${res.written}、未变 ${res.unchanged}）→ ${res.dir}，${res.elapsedMs}ms\n`,
      );
      if (res.proposed > 0) {
        ctx.stdout(`待合并 ${res.proposed} 篇（已写 .proposed.md，等待三选一）→ ${res.dir}\n`);
      }
      if (res.ledgerDifferences > 0) {
        ctx.stdout(`台账与 DB 有 ${res.ledgerDifferences} 处差异（以 DB 为准，已重建）→ ${res.ledgerPath}\n`);
      }
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
