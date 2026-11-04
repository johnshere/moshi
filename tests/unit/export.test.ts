/**
 * `moshi export` 单测（详设 §9.1–§9.4；台账 P1-21 / P2-15）。
 *
 * 验收（P2-15 改为嵌套布局）：达标主题导出成 `topics/<slug>/<slug>.md`
 * （frontmatter + 正文）；content_hash 未变第二次不写盘；没有达标主题时导出 0 篇
 * 且退出码 0、不建归档目录；`--out` 越出白名单被拒。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../../src/infra/sqlite/factRepo.js';
import { insertEdge } from '../fixtures/factories.js';
import { runCli } from '../../src/app/cli/index.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'moshi-export-'));
}

function seedTopic(db: Db, communityId: number, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `f_topic${communityId}_${i}`;
    ids.push(id);
    insertFact(db, {
      id,
      content: `主题 ${communityId} 的第 ${i} 条事实：moshi 使用 pnpm 管理依赖`,
      ftype: 'semantic',
      confidence: 0.9,
      confidenceSource: 'tool_obs',
      strength: 0.6,
      importance: 0.5,
      pool: 'utility',
      epistemicStatus: 'active',
      attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id }, ext: {} },
      canonicalKey: `ck_${id}`,
      valueHash: `vh_${id}`,
      scope: 'global',
      supersededBy: null,
      validAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      validTo: null,
      recordedAt: '2026-10-01T00:00:00.000Z',
      communityId,
      degree: 0,
      accessCount: 0,
      lastAccessAt: null,
      lastDecayAt: '2026-10-01T00:00:00.000Z',
      sourceEpisode: null,
      span: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  }
  // 成链：依赖链完整度 = 1.0 ≥ 0.5，主题才入选
  for (let i = 0; i + 1 < ids.length; i += 1) insertEdge(db, ids[i]!, ids[i + 1]!);
  return ids;
}

function openHomeDb(home: string): Db {
  const { db } = openDb({ file: path.join(home, '.moshi', 'moshi.db') });
  migrate(db, { backupsDir: path.join(home, '.moshi', 'backups') });
  opened.push(db);
  return db;
}

/** 递归收集目录下所有 .md 的绝对路径（嵌套布局下不能只 readdir 根目录） */
function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listMarkdown(p));
    else if (ent.name.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('moshi export（P1-21 / P2-15）', () => {
  it('达标主题导出为 topics/<slug>/<slug>.md；content_hash 未变第二次不写盘', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 7, 10);

    const first: string[] = [];
    const code1 = await runCli(['export', '--all'], { home, stdout: (s) => first.push(s) });
    expect(code1).toBe(0);
    expect(first.join('')).toContain('导出 1 篇（写盘 1、未变 0）');

    const outDir = path.join(home, 'Documents', '默识归档');
    const files = listMarkdown(outDir);
    expect(files).toHaveLength(1);
    const rel = path.relative(outDir, files[0]!).split(path.sep).join('/');
    expect(rel).toMatch(/^topics\/[^/]+\/[^/]+\.md$/);
    const slug = rel.split('/')[1]!;
    expect(path.basename(files[0]!)).toBe(`${slug}.md`);

    const text = readFileSync(files[0]!, 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('topic_id: 7');
    expect(text).toContain('content_hash:');
    expect(text).toContain('## 关键事实');

    // archive_meta.path 存相对 archive_dir 的嵌套路径（Lead 裁决第 2 条）
    const meta = db.prepare('SELECT path FROM archive_meta WHERE topic_id = ?').get('7') as { path: string };
    expect(meta.path).toBe(rel);

    const second: string[] = [];
    const code2 = await runCli(['export', '--all'], { home, stdout: (s) => second.push(s) });
    expect(code2).toBe(0);
    expect(second.join('')).toContain('写盘 0');
  });

  it('没有达标主题 → 导出 0 篇，退出码 0，且不建归档目录', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 3, 7); // 7 < MIN_FACTS(8)
    const out: string[] = [];
    const code = await runCli(['export', '--all'], { home, stdout: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toContain('导出 0 篇');
    expect(existsSync(path.join(home, 'Documents', '默识归档'))).toBe(false);
  });

  it('--out 越出白名单 → E_ACCESS', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 9, 8);
    await expect(runCli(['export', '--all', '--out', path.join(home, '..', 'escape')], { home })).rejects.toThrow(
      /写盘白名单外/,
    );
  });
});

/** 导出前快照落在 `<data_dir>/backups/`，与每日 backup job 同目录 */
function backupsDir(home: string): string {
  return path.join(home, '.moshi', 'backups');
}

function listDbFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
}

function snapshotPathOf(log: string): string | null {
  const match = log.match(/已快照 -> (.+)\n/);
  return match?.[1] ?? null;
}

describe('moshi export 导出前快照（P2-19-A 项 2）', () => {
  it('本次有文档写盘 → 先快照（文件数 +1）并打印 已快照', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 7, 10);

    const out: string[] = [];
    expect(await runCli(['export', '--all'], { home, stdout: (s) => out.push(s) })).toBe(0);
    const log = out.join('');
    expect(log).toContain('导出 1 篇（写盘 1、未变 0）');

    const snapshot = snapshotPathOf(log);
    expect(snapshot).not.toBeNull();
    expect(existsSync(snapshot!)).toBe(true);
    expect(path.dirname(snapshot!)).toBe(backupsDir(home));
    expect(listDbFiles(backupsDir(home))).toHaveLength(1);
  });

  it('--no-backup → 有写盘也不产生快照', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 7, 10);

    const out: string[] = [];
    expect(await runCli(['export', '--all', '--no-backup'], { home, stdout: (s) => out.push(s) })).toBe(0);
    expect(out.join('')).toContain('导出 1 篇（写盘 1、未变 0）');
    expect(out.join('')).not.toContain('已快照');
    expect(listDbFiles(backupsDir(home))).toHaveLength(0);
  });

  it('内容未变（写盘 0）→ 不再产生快照', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 7, 10);

    expect(await runCli(['export', '--all'], { home })).toBe(0);
    expect(listDbFiles(backupsDir(home))).toHaveLength(1);

    const second: string[] = [];
    expect(await runCli(['export', '--all'], { home, stdout: (s) => second.push(s) })).toBe(0);
    expect(second.join('')).toContain('写盘 0');
    expect(second.join('')).not.toContain('已快照');
    expect(listDbFiles(backupsDir(home))).toHaveLength(1);
  });

  it('--slug 单篇导出同样在写盘前快照', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 7, 10);
    expect(await runCli(['export', '--all'], { home })).toBe(0);
    const meta = db.prepare('SELECT slug FROM archive_meta WHERE topic_id = ?').get('7') as { slug: string };

    // 改一条事实内容 → 渲染 hash 变化，--slug 会真正写盘
    db.prepare("UPDATE fact SET content = content || '（更新）'").run();
    const out: string[] = [];
    expect(await runCli(['export', '--slug', meta.slug], { home, stdout: (s) => out.push(s) })).toBe(0);
    expect(out.join('')).toContain('写盘 1');
    expect(snapshotPathOf(out.join(''))).not.toBeNull();
    expect(listDbFiles(backupsDir(home))).toHaveLength(2);
  });
});

describe('moshi export --slug / --all（P2-19-A 项 4）', () => {
  it('--slug 只导出指定主题；内容未变时写盘 0', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 7, 10);
    // 先全量导出一次，建出 archive_meta
    const first: string[] = [];
    expect(await runCli(['export', '--all'], { home, stdout: (s) => first.push(s) })).toBe(0);
    expect(first.join('')).toContain('导出 1 篇（写盘 1、未变 0）');

    const meta = db.prepare('SELECT slug FROM archive_meta WHERE topic_id = ?').get('7') as { slug: string };
    const out: string[] = [];
    const code = await runCli(['export', '--slug', meta.slug], { home, stdout: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toContain('导出 1 篇（写盘 0、未变 1）');
  });

  it('--slug 不存在 → 退出码 1，stderr 给出可读提示', async () => {
    const home = tmpHome();
    openHomeDb(home);
    const err: string[] = [];
    const code = await runCli(['export', '--slug', '不存在的主题'], { home, stderr: (s) => err.push(s) });
    expect(code).toBe(1);
    expect(err.join('')).toContain('尚未观察到归档主题：不存在的主题');
  });

  it('--slug 与 --all 互斥 → 退出码 2，不落盘', async () => {
    const home = tmpHome();
    const db = openHomeDb(home);
    seedTopic(db, 7, 10);
    const err: string[] = [];
    const code = await runCli(['export', '--all', '--slug', 'x'], { home, stderr: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join('')).toContain('互斥');
    expect(existsSync(path.join(home, 'Documents', '默识归档'))).toBe(false);
  });

  it('--slug 缺值 → 退出码 2', async () => {
    const home = tmpHome();
    openHomeDb(home);
    const err: string[] = [];
    expect(await runCli(['export', '--slug'], { home, stderr: (s) => err.push(s) })).toBe(2);
    expect(err.join('')).toContain('--slug 需要一个值');
  });
});
