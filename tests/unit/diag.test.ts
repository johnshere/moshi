/**
 * 自检页 / doctor 契约测试（P2-18 / 详设 §11.4、§2.4、§2.10）。
 *
 * 钉住三件事：
 * ① `/api/diag` 的响应字段与口径（不是"能跑"而是"字段全、数值对"）；
 * ② 不变量 I1–I10 在人为破坏后确实变红，修复后变绿；
 * ③ `doctor --fix` 只治派生数据（degree / FTS），事实与审计一行不动。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate, TARGET_VERSION } from '../../src/infra/sqlite/migrate.js';
import { setMeta } from '../../src/infra/sqlite/metaRepo.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { tableCounts } from '../../src/infra/sqlite/maintenance.js';
import { setVectorDisabled } from '../../src/infra/vec/index.js';
import { loadConfig } from '../../src/app/config.js';
import { diagRoutes } from '../../src/app/http/routes/diag.js';
import { applyDoctorFixes, doctorExitCode } from '../../src/app/cli/commands/doctor.js';
import { collectDiagReport } from '../../src/core/diag/collect.js';
import { computeModularity, computeNearDupRatio } from '../../src/core/diag/quality.js';
import type { DiagReport } from '../../src/core/diag/types.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

const MODEL = { embed: 'test-embed', gat: 'off' as const, weights_path: 'Z:/definitely/missing.pt' };

const opened: Db[] = [];
const dirs: string[] = [];
const apps: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of opened.splice(0)) closeDb(db);
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-diag-'));
  dirs.push(dir);
  return dir;
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 夹具绕过了仓储层的 FTS 同步；测试里显式补一次，避免 I9 假红 */
function syncIndexes(db: Db): void {
  setVectorDisabled(db, true);
  syncMissingFts(db);
}

function reportOf(db: Db): DiagReport {
  return collectDiagReport(db, MODEL);
}

async function diagApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(diagRoutes, {
    prefix: '/api/diag',
    db,
    cfg: loadConfig({ home: tempDir() }),
  });
  apps.push({ close: () => app.close() });
  return app;
}

describe('GET /api/diag', () => {
  it('空库响应字段齐备，不变量全绿', async () => {
    const db = freshDb();
    const app = await diagApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/diag' });
    expect(res.statusCode).toBe(200);
    const body = res.json<DiagReport>();

    expect(body.db.integrity).toBe('ok');
    expect(body.db.user_version).toBe(TARGET_VERSION);
    expect(typeof body.db.size_mb).toBe('number');
    expect(['ok', 'off']).toContain(body.indexes.vec);
    expect(body.indexes.fts).toBe('ok');
    expect(body.indexes.degree_mismatch).toBe(0);
    expect(Object.values(body.invariants).every((ok) => ok)).toBe(true);
    expect(typeof body.model.embed).toBe('string');
    expect(body.model.gat).toBe('off');
    expect(body.model.weights).toBe(false);
    expect(body.archive).toEqual({
      topics: 0,
      dirty: 0,
      human_edited: 0,
      proposed_pending: 0,
      merged_or_split: 0,
    });
    expect(body.quality).toEqual({
      orphan_ratio: null,
      modularity: null,
      stale_chains: 0,
      near_dup_ratio: 0,
      key_entity_coverage: null,
      scope_leak: 0,
      layout_freshness: null,
    });
    expect(body.last_harvest_at).toBeNull();
    expect(body.last_eval).toBeNull();
  });

  it('/api/diag/quality 返回七项指标（六项 + 布局新鲜度）', async () => {
    const db = freshDb();
    const app = await diagApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/diag/quality' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual([
      'key_entity_coverage',
      'layout_freshness',
      'modularity',
      'near_dup_ratio',
      'orphan_ratio',
      'scope_leak',
      'stale_chains',
    ]);
  });

  it('archive 补项：待合并提案 / 合并分裂计数；layout 新鲜度按 layout.computed_at 口径', () => {
    const db = freshDb();
    const factId = insertFact(db, { id: 'fact_layout' });
    const insertArchive = db.prepare(
      `INSERT INTO archive_meta (topic_id, slug, path, title, content_hash, revision, last_exported_at, dirty, human_edited, status)
       VALUES (?, ?, ?, 't', 'h', 1, '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
    );
    insertArchive.run('topic_auto', 'auto', 'auto.md', 0, 0, 'active');
    insertArchive.run('topic_pending', 'pending', 'pending.md', 1, 1, 'active');
    insertArchive.run('topic_merged', 'merged', 'merged.md', 0, 2, 'merged');

    // 布局落后于写入 24 小时：正数表示有新内容尚未上屏
    db.prepare(
      `INSERT INTO layout (fact_id, x, y, z, layout_version, computed_at)
       VALUES (?, 1, 2, 3, 1, '2026-01-01T00:00:00.000Z')`,
    ).run(factId);
    db.prepare('UPDATE fact SET updated_at = ? WHERE id = ?').run(
      '2026-01-02T00:00:00.000Z',
      factId,
    );

    const report = reportOf(db);
    expect(report.archive).toEqual({
      topics: 3,
      dirty: 1,
      human_edited: 2,
      proposed_pending: 1,
      merged_or_split: 1,
    });
    expect(report.quality.layout_freshness).toBe(24);
  });
});

describe('不变量判定', () => {
  it('I7：degree 漂移变红，--fix 重算后变绿，且事实/审计不变', () => {
    const db = freshDb();
    const a = insertFact(db, { id: 'fact_a' });
    const b = insertFact(db, { id: 'fact_b' });
    insertEdge(db, a, b, 'logic');
    syncIndexes(db);

    db.prepare('UPDATE fact SET degree = 5 WHERE id = ?').run(a);
    const before = tableCounts(db);
    const beforeConfidence = db
      .prepare('SELECT confidence FROM fact ORDER BY id')
      .all() as { confidence: number }[];

    const broken = reportOf(db);
    expect(broken.invariants.I7).toBe(false);
    expect(broken.indexes.degree_mismatch).toBe(1);

    const fixed = applyDoctorFixes(db);
    expect(fixed.degree_fixed).toBeGreaterThan(0);

    const after = reportOf(db);
    expect(after.invariants.I7).toBe(true);
    expect(after.indexes.degree_mismatch).toBe(0);
    expect(tableCounts(db)).toEqual(before);
    expect(db.prepare('SELECT confidence FROM fact ORDER BY id').all()).toEqual(beforeConfidence);
    // 该测试环境没有 embedding，向量路被标记 off → 降级但可用（4），而非全绿（0）
    expect(doctorExitCode(reportOf(db))).toBe(4);
    expect(doctorExitCode({ ...broken, invariants: { ...broken.invariants, I1: false } })).toBe(3);
  });

  it('I9：FTS 缺行变红，--fix 补齐后变绿', () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_1' });
    insertFact(db, { id: 'fact_2' });
    syncIndexes(db);
    expect(reportOf(db).invariants.I9).toBe(true);

    db.prepare("DELETE FROM fact_fts WHERE fact_id = 'fact_1'").run();
    const broken = reportOf(db);
    expect(broken.indexes.fts).toBe('stale');
    expect(broken.invariants.I9).toBe(false);

    const fixed = applyDoctorFixes(db);
    expect(fixed.fts_added).toBe(1);
    expect(reportOf(db).invariants.I9).toBe(true);
  });

  it('I1/I2/I3 在人为绕过约束后变红', () => {
    const db = freshDb();
    // I1：content 审计行（正常路径不可能出现）→ 说明有旁路写
    db.prepare(
      `INSERT INTO audit (id, tbl, row_id, field, before_json, after_json, ts)
       VALUES ('audit_bad', 'fact', 'fact_x', 'content', '"a"', '"b"', '2026-01-01T00:00:00.000Z')`,
    ).run();
    expect(reportOf(db).invariants.I1).toBe(false);

    // I2：冻结触发器被删 → 结构防线不在
    db.prepare('DROP TRIGGER trg_fact_frozen_immutable').run();
    expect(reportOf(db).invariants.I2).toBe(false);

    // I3：唯一索引被删后能插入重复身份
    db.prepare('DROP INDEX idx_fact_identity').run();
    const subject = { entity_id: 'entity_dup', name: 'dup' };
    insertFact(db, { canonicalKey: 'ck_dup', valueHash: 'vh_dup', subject });
    insertFact(db, { canonicalKey: 'ck_dup', valueHash: 'vh_dup', subject });
    expect(reportOf(db).invariants.I3).toBe(false);
  });

  it('I5/I6/I8 按事实形状判定', () => {
    const db = freshDb();
    // I5：valid_to 为空却不在 active/disputed
    insertFact(db, { id: 'fact_archived', epistemicStatus: 'archived' });
    expect(reportOf(db).invariants.I5).toBe(false);

    // I6：invalidated 没有 valid_to
    insertFact(db, { id: 'fact_invalid', epistemicStatus: 'invalidated' });
    expect(reportOf(db).invariants.I6).toBe(false);

    // I8：supersedes 的 dst 有效性早于 src 的失效时刻
    const src = insertFact(db, {
      id: 'fact_src',
      validAt: '2026-01-01T00:00:00.000Z',
      validTo: '2026-03-01T00:00:00.000Z',
    });
    const dst = insertFact(db, {
      id: 'fact_dst',
      validAt: '2026-02-01T00:00:00.000Z',
      validTo: null,
    });
    insertEdge(db, src, dst, 'supersedes');
    expect(reportOf(db).invariants.I8).toBe(false);
  });

  it('I10：confidence 审计行的 JSON 形状参与抽样判定', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO audit (id, tbl, row_id, field, before_json, after_json, ts)
       VALUES ('audit_ok', 'fact', 'fact_x', 'confidence', '0.5', '0.7', '2026-01-01T00:00:00.000Z')`,
    ).run();
    expect(reportOf(db).invariants.I10).toBe(true);
    db.prepare(
      `INSERT INTO audit (id, tbl, row_id, field, before_json, after_json, ts)
       VALUES ('audit_bad', 'fact', 'fact_y', 'confidence', '0.5', 'oops', '2026-01-02T00:00:00.000Z')`,
    ).run();
    expect(reportOf(db).invariants.I10).toBe(false);
  });
});

describe('质量指标', () => {
  it('孤立比 / stale 链 / 关键实体覆盖按 SQL 口径计算', () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_alone' });
    const src = insertFact(db, { id: 'fact_s' });
    const dst = insertFact(db, {
      id: 'fact_d',
      epistemicStatus: 'invalidated',
      validAt: '2026-01-01T00:00:00.000Z',
      validTo: '2026-02-01T00:00:00.000Z',
    });
    insertEdge(db, src, dst, 'depends_on');
    syncIndexes(db);

    const report = reportOf(db);
    expect(report.quality.stale_chains).toBe(1);
    // 2 条活跃事实中 1 条孤立（fact_d 已 invalidated 不计）
    expect(report.quality.orphan_ratio).toBeCloseTo(0.5, 4);
    expect(report.quality.key_entity_coverage).toBe(1);
    expect(report.quality.scope_leak).toBe(0);
  });

  it('模块度按社区内部边/度数计算', () => {
    const modularity = computeModularity({
      edge_count: 3,
      communities: [
        { community_id: 0, fact_count: 2, degree: 3, internal_edges: 1 },
        { community_id: 1, fact_count: 2, degree: 3, internal_edges: 1 },
      ],
    });
    expect(modularity).toBeCloseTo(0.1667, 4);
    expect(computeModularity({ edge_count: 0, communities: [] })).toBeNull();
  });

  it('近似重复比：候选对为空为 0，缺向量为 null', () => {
    expect(computeNearDupRatio([])).toBe(0);
    expect(
      computeNearDupRatio([
        { a: Float32Array.from([1, 0]), b: Float32Array.from([1, 0]) },
        { a: Float32Array.from([1, 0]), b: Float32Array.from([0, 1]) },
      ]),
    ).toBe(0.5);
    expect(computeNearDupRatio([{ a: null, b: Float32Array.from([1, 0]) }])).toBeNull();
  });
});

describe('meta 心跳', () => {
  it('last_harvest_at / last_eval 从 meta 读出并校验形状', () => {
    const db = freshDb();
    setMeta(db, 'last_harvest_at', '2026-11-01T03:00:12.000Z');
    setMeta(
      db,
      'last_eval',
      JSON.stringify({ at: '2026-10-30', passed: 38, total: 40, blocking_failures: 0 }),
    );
    const report = reportOf(db);
    expect(report.last_harvest_at).toBe('2026-11-01T03:00:12.000Z');
    expect(report.last_eval).toEqual({
      at: '2026-10-30',
      passed: 38,
      total: 40,
      blocking_failures: 0,
    });

    setMeta(db, 'last_eval', '{"at": 1}');
    expect(reportOf(db).last_eval).toBeNull();
  });
});
