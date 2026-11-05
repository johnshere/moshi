/**
 * P2-15 归档增量与人工编辑保护单测（详设 §9.4 L2815-2841）。
 *
 * 覆盖验收要求：
 *   1. 手改 MD → 再导出：主文件字节不变，生成 `<slug>.proposed.md` 且含新正文，
 *      human_edited=1、revision / content_hash 基线不变；
 *   2. 内容未变：不写盘，mtime 与 revision 均不变；
 *   3. 三选一：accept_auto / keep_human / promote_human 的三态与基线正确；
 *   4. revision 每 5 版写 `_history/<slug>@<date>.md`。
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import type { Epistemic } from '../../src/domain/enums.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../../src/infra/sqlite/factRepo.js';
import { getArchiveMeta } from '../../src/infra/sqlite/archiveRepo.js';
import { archiveAll } from '../../src/core/archive/index.js';
import { decideArchiveWrite } from '../../src/core/archive/guard.js';
import {
  applyProposal,
  bodyHashOfDocument,
  mainFilePath,
  proposedFilePath,
} from '../../src/core/archive/writer.js';

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function addFact(db: Db, id: string, opts: { community?: number; content?: string } = {}): void {
  insertFact(db, {
    id,
    content: opts.content ?? `事实 ${id}`,
    ftype: 'semantic',
    confidence: 0.8,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.6,
    pool: 'utility',
    epistemicStatus: 'active' as Epistemic,
    attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id }, ext: {} },
    canonicalKey: `ck_${id}`,
    valueHash: `vh_${id}`,
    scope: 'global',
    supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: opts.community ?? null,
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

/** 8 facts + depends_on 链 + 互斥边：满足 selectTopics（互斥边兜底完整度 0.375） */
function setupCommunity(db: Db, id = 1, n = 8): void {
  db.prepare(
    `INSERT INTO community_summary (community_id, scope, label, summary, fact_count, derived_at, source_rev)
     VALUES (?, 'global', ?, ?, ?, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(id, `主题${id}`, `摘要${id}`, n);
  for (let i = 0; i < n; i += 1) addFact(db, `c${id}_f${i}`, { community: id });
  for (const [src, dst] of [
    [`c${id}_f0`, `c${id}_f1`],
    [`c${id}_f1`, `c${id}_f2`],
  ] as const) {
    db.prepare(
      `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
       VALUES (?, ?, ?, 'depends_on', 1.0, 0.9, '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:00:00.000Z')`,
    ).run(`${src}->${dst}`, src, dst);
  }
  db.prepare(
    `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
     VALUES (?, ?, ?, 'mutually_exclusive', 1.0, 0.9, '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:00:00.000Z')`,
  ).run(`c${id}_f0-_-c${id}_f1`, `c${id}_f0`, `c${id}_f1`);
}

interface Env {
  db: Db;
  archiveDir: string;
  roots: readonly string[];
  main: string;
  slug: string;
}

function setupEnv(): Env {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-arch-guard-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  setupCommunity(db, 1, 8);
  const archiveDir = path.join(dir, 'archive');
  const res = archiveAll(db, { archiveDir, roots: [archiveDir] });
  const slug = res.docs[0]!.slug;
  return {
    db,
    archiveDir,
    roots: [archiveDir],
    main: path.join(archiveDir, 'topics', slug, `${slug}.md`),
    slug,
  };
}

describe('archive guard（纯判定）', () => {
  const base = { targetHash: 'new', diskHash: 'old', metaHash: 'old', humanEdited: 0 as const, revision: 3 };

  it('human_edited=2 → skip，不再生成 .proposed', () => {
    expect(decideArchiveWrite({ ...base, humanEdited: 2 })).toMatchObject({
      action: 'skip',
      humanEdited: 2,
      revision: 3,
      reason: 'permanent_human',
    });
  });

  it('主文件不存在 → write 且 revision+1', () => {
    expect(decideArchiveWrite({ ...base, diskHash: null, metaHash: null, humanEdited: 0 })).toMatchObject({
      action: 'write',
      humanEdited: 0,
      revision: 4,
      reason: 'missing_file',
    });
  });

  it('human_edited=1 → 只刷新 .proposed，revision 不变', () => {
    expect(decideArchiveWrite({ ...base, humanEdited: 1 })).toMatchObject({
      action: 'propose',
      humanEdited: 1,
      revision: 3,
      reason: 'pending_proposal',
    });
  });

  it('无基线（文件存在但 archive_meta 无 hash）→ propose', () => {
    expect(decideArchiveWrite({ ...base, metaHash: null })).toMatchObject({
      action: 'propose',
      humanEdited: 1,
      revision: 3,
    });
  });

  it('磁盘 hash ≠ 基线 → propose（人工改动）', () => {
    expect(decideArchiveWrite({ ...base, diskHash: 'human' })).toMatchObject({
      action: 'propose',
      reason: 'disk_mismatch',
    });
  });

  it('磁盘 = 基线 = 目标 → skip；目标变了 → write', () => {
    expect(decideArchiveWrite({ ...base, targetHash: 'old', diskHash: 'old' })).toMatchObject({
      action: 'skip',
      revision: 3,
      reason: 'unchanged',
    });
    expect(decideArchiveWrite({ ...base, targetHash: 'newer', diskHash: 'old' })).toMatchObject({
      action: 'write',
      revision: 4,
      reason: 'changed',
    });
  });
});

describe('归档增量与人工编辑保护（P2-15）', () => {
  it('手改 MD → 再导出：主文件字节不变、生成 .proposed.md、human_edited=1、revision/基线不变', () => {
    const { db, archiveDir, roots, main, slug } = setupEnv();
    expect(existsSync(main)).toBe(true);

    const baseline = getArchiveMeta(db, '1')!;
    expect(baseline.revision).toBe(1);
    expect(baseline.path).toBe(`topics/${slug}/${slug}.md`);

    const original = readFileSync(main, 'utf8');
    // 插在「本次更新」之前（该派生段不进 content_hash，插在它后面不会被识别）
    const humanText = original.replace('\n\n## 本次更新\n\n', '\n\n人工补充：仅本机适用。\n\n## 本次更新\n\n');
    expect(humanText).not.toBe(original);
    writeFileSync(main, humanText);
    const mtimeAfterHuman = statSync(main).mtimeMs;

    // 内容变化：新增一条事实
    addFact(db, 'c1_f8', { community: 1, content: '新增事实：本机使用 pwsh 7' });
    const res = archiveAll(db, { archiveDir, roots });
    expect(res.written).toBe(0);
    expect(res.proposed).toBe(1);

    // 主文件一个字节都不能被改
    expect(readFileSync(main, 'utf8')).toBe(humanText);
    expect(statSync(main).mtimeMs).toBe(mtimeAfterHuman);

    const proposed = proposedFilePath(main, slug);
    expect(existsSync(proposed)).toBe(true);
    const proposedText = readFileSync(proposed, 'utf8');
    expect(proposedText).toContain('新增事实：本机使用 pwsh 7');
    expect(proposedText).toContain('revision: 2'); // 将被应用的版本（当前 1 + 1）

    const after = getArchiveMeta(db, '1')!;
    expect(after.humanEdited).toBe(1);
    expect(after.revision).toBe(1); // 主文件没动，revision 不递增
    expect(after.contentHash).toBe(baseline.contentHash); // 基线保持上次自动版
    expect(after.lastExportedAt).toBe(baseline.lastExportedAt);
  });

  it('内容未变 → 不写盘：mtime 与 revision 均不变', () => {
    const { db, archiveDir, roots, main } = setupEnv();
    const mtime = statSync(main).mtimeMs;
    const before = getArchiveMeta(db, '1')!;

    const res = archiveAll(db, { archiveDir, roots });
    expect(res.written).toBe(0);
    expect(res.proposed).toBe(0);
    expect(statSync(main).mtimeMs).toBe(mtime);

    const after = getArchiveMeta(db, '1')!;
    expect(after.revision).toBe(before.revision);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.lastExportedAt).toBe(before.lastExportedAt);
  });

  it('accept_auto：用 .proposed.md 原样覆盖，human_edited=0、revision+1', () => {
    const { db, archiveDir, roots, main, slug } = setupEnv();
    const original = readFileSync(main, 'utf8');
    writeFileSync(main, original.replace('\n\n## 本次更新\n\n', '\n\n人工改一行。\n\n## 本次更新\n\n'));
    addFact(db, 'c1_f8', { community: 1, content: '新增事实：accept_auto' });
    archiveAll(db, { archiveDir, roots });

    const proposedText = readFileSync(proposedFilePath(main, slug), 'utf8');
    const res = applyProposal(db, {
      slug,
      action: 'accept_auto',
      archiveDir,
      roots,
      now: '2026-11-04T12:00:00.000Z',
    });
    expect(res.humanEdited).toBe(0);
    expect(res.revision).toBe(2);
    expect(readFileSync(main, 'utf8')).toBe(proposedText);
    expect(res.contentHash).toBe(bodyHashOfDocument(proposedText));

    const meta = getArchiveMeta(db, '1')!;
    expect(meta.humanEdited).toBe(0);
    expect(meta.revision).toBe(2);
    expect(meta.contentHash).toBe(bodyHashOfDocument(proposedText));

    // 接受后数据未变 → 再导出不写盘
    const third = archiveAll(db, { archiveDir, roots });
    expect(third.written).toBe(0);
    expect(third.proposed).toBe(0);
    expect(getArchiveMeta(db, '1')!.revision).toBe(2);
  });

  it('keep_human：human_edited=2，此后不再自动导出、不再刷新 .proposed', () => {
    const { db, archiveDir, roots, main, slug } = setupEnv();
    const original = readFileSync(main, 'utf8');
    writeFileSync(main, original.replace('\n\n## 本次更新\n\n', '\n\n人工版（保留）。\n\n## 本次更新\n\n'));
    addFact(db, 'c1_f8', { community: 1, content: '新增事实：keep_human' });
    archiveAll(db, { archiveDir, roots });

    const proposed = proposedFilePath(main, slug);
    const proposedBefore = readFileSync(proposed, 'utf8');
    const proposedMtime = statSync(proposed).mtimeMs;

    const res = applyProposal(db, { slug, action: 'keep_human', archiveDir, roots });
    expect(res.humanEdited).toBe(2);

    const mainText = readFileSync(main, 'utf8');
    expect(getArchiveMeta(db, '1')!.humanEdited).toBe(2);
    expect(getArchiveMeta(db, '1')!.contentHash).toBe(bodyHashOfDocument(mainText));

    // 永久人工：数据再变也不自动写、不刷新 .proposed
    addFact(db, 'c1_f9', { community: 1, content: '新增事实：keep_human 之后' });
    const res2 = archiveAll(db, { archiveDir, roots });
    expect(res2.written).toBe(0);
    expect(res2.proposed).toBe(0);
    expect(readFileSync(main, 'utf8')).toBe(mainText);
    expect(readFileSync(proposed, 'utf8')).toBe(proposedBefore);
    expect(statSync(proposed).mtimeMs).toBe(proposedMtime);
  });

  it('promote_human：人工正文受保护，后续新事实只进提案，accept_auto 后才覆盖', () => {
    const { db, archiveDir, roots, main, slug } = setupEnv();
    const original = readFileSync(main, 'utf8');
    writeFileSync(main, original.replace('\n\n## 本次更新\n\n', '\n\n人工版转正。\n\n## 本次更新\n\n'));
    addFact(db, 'c1_f8', { community: 1, content: '新增事实：promote_human' });
    archiveAll(db, { archiveDir, roots });

    const before = getArchiveMeta(db, '1')!;
    const mainText = readFileSync(main, 'utf8');
    const promoted = applyProposal(db, { slug, action: 'promote_human', archiveDir, roots });
    const mtimeAfterPromote = statSync(main).mtimeMs;

    expect(promoted.humanEdited).toBe(1);
    expect(promoted.revision).toBe(before.revision);
    expect(promoted.contentHash).toBe(bodyHashOfDocument(mainText));

    addFact(db, 'c1_f9', { community: 1, content: '新增事实：转正后自动提案' });
    const automatic = archiveAll(db, { archiveDir, roots });
    expect(automatic.written).toBe(0);
    expect(automatic.proposed).toBe(1);
    expect(readFileSync(main, 'utf8')).toBe(mainText);
    expect(statSync(main).mtimeMs).toBe(mtimeAfterPromote);

    const protectedMeta = getArchiveMeta(db, '1')!;
    expect(protectedMeta.humanEdited).toBe(1);
    expect(protectedMeta.contentHash).toBe(bodyHashOfDocument(mainText));
    expect(protectedMeta.revision).toBe(before.revision);
    expect(protectedMeta.lastExportedAt).toBe(before.lastExportedAt);

    const proposedText = readFileSync(proposedFilePath(main, slug), 'utf8');
    expect(proposedText).toContain('新增事实：转正后自动提案');
    const accepted = applyProposal(db, { slug, action: 'accept_auto', archiveDir, roots });
    expect(accepted.humanEdited).toBe(0);
    expect(accepted.revision).toBe(before.revision + 1);
    expect(readFileSync(main, 'utf8')).toBe(proposedText);
    expect(getArchiveMeta(db, '1')!.humanEdited).toBe(0);
  });

  it('revision 每 5 版写 _history/<slug>@<date>.md', () => {
    const { db, archiveDir, roots, slug } = setupEnv();
    const res = archiveAll(db, { archiveDir, roots });
    void res;
    for (let version = 2; version <= 5; version += 1) {
      addFact(db, `c1_hist${version}`, { community: 1, content: `历史版本 ${version}` });
      const r = archiveAll(db, { archiveDir, roots, now: `2026-11-0${version}T10:00:00.000Z` });
      expect(r.written).toBe(1);
    }
    const meta = getArchiveMeta(db, '1')!;
    expect(meta.revision).toBe(5);
    const historyDir = path.join(archiveDir, '_history');
    const files = readdirSync(historyDir).filter((f) => f.endsWith('.md'));
    expect(files).toEqual([`${slug}@2026-11-05.md`]);
    const main = mainFilePath(archiveDir, slug, meta.path);
    expect(readFileSync(path.join(historyDir, files[0]!), 'utf8')).toBe(readFileSync(main, 'utf8'));
  });
});
