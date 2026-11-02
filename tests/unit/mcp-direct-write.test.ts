/**
 * P2-23 直写闸门（概设 §3.1.3 / 台账 P2-23 三条验收）。
 *
 * 这三条验收是同一件事的三个面：**不开闸就写不进去、开了闸也只写允许的类型、
 * 写错了能整批收回去**。测试名直接对齐台账措辞，方便验收时逐条对号。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/app/config.js';
import { callTool } from '../../src/app/mcp/tools.js';
import { revokeDirectBatch } from '../../src/app/mcp/directWrite.js';
import { runMemoryAnnotate } from '../../src/app/mcp/annotate.js';
import type { AnnotateInput } from '../../src/app/mcp/schemas.js';
import type { McpDeps } from '../../src/app/mcp/deps.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as annotationRepo from '../../src/infra/sqlite/annotationRepo.js';
import * as auditRepo from '../../src/infra/sqlite/auditRepo.js';
import * as edgeRepo from '../../src/infra/sqlite/edgeRepo.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import * as quarantineRepo from '../../src/infra/sqlite/quarantineRepo.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (opened.length > 0) closeDb(opened.pop()!);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-direct-'));
  dirs.push(dir);
  return dir;
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  opened.push(db);
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  return db;
}

/** 配置把闸门打开/关上由参数决定，其余沿用默认值（默认本身就是关闭） */
function makeDeps(db: Db, overrides: Partial<Config['mcp']> = {}): McpDeps {
  const base = loadConfig({ home: tempDir() });
  return { db, cfg: { ...base, mcp: { ...base.mcp, ...overrides } } };
}

function textOf(res: Awaited<ReturnType<typeof callTool>>): Record<string, unknown> {
  const first = res.content.find((c) => c.type === 'text');
  if (first === undefined || first.type !== 'text') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

const pnpmFact = {
  content: 'pnpm 版本是 10.15.1',
  subject: 'pnpm',
  predicate: 'installed_version',
  value: '10.15.1',
  confidence: 0.9,
};

const nodeFact = {
  content: 'node 版本是 24.19.0',
  subject: 'node',
  predicate: 'installed_version',
  value: '24.19.0',
  confidence: 0.9,
};

function factBySubject(db: Db, name: string) {
  const facts = factRepo.findActiveBySubjectName(db, name);
  expect(facts).toHaveLength(1);
  return facts[0]!;
}

/**
 * 直接调 `runMemoryAnnotate` 时要补 schema 默认值（走 `callTool` 由 zod 补，
 * 这里跳过了解析，所以手工补）。只补不影响用例语义的两个默认。
 */
function factIn(
  fact: { content: string; subject: string; predicate: string; value: unknown } & Record<
    string,
    unknown
  >,
): AnnotateInput['facts'][number] {
  return { subject_type: 'pkg', ftype: 'semantic', ...fact } as AnnotateInput['facts'][number];
}

describe('memory_annotate 直写闸门（P2-23）', () => {
  it('闸门关闭时：要求直写的调用整批拒绝，返回 E_DIRECT_WRITE_DISABLED 且不落库不入队', async () => {
    const db = freshDb();
    const deps = makeDeps(db);

    const res = await callTool(deps, 'memory_annotate', {
      direct_write: true,
      facts: [factIn(pnpmFact)],
    });

    expect(res.isError).toBe(true);
    expect(textOf(res).error).toBe('E_DIRECT_WRITE_DISABLED');
    // 整批拒绝：既没写事实，也没偷偷入队
    expect(factRepo.findActiveBySubjectName(db, 'pkg:pnpm')).toHaveLength(0);
    expect(annotationRepo.countPending(db)).toBe(0);
  });

  it('闸门关闭时：只带 relations、不写 direct_write 也被拒（边只对直写有意义）', () => {
    const db = freshDb();
    const deps = makeDeps(db);
    expect(() =>
      runMemoryAnnotate(deps, {
        facts: [factIn({ ...pnpmFact, relations: [{ etype: 'co_occur', to_key: 'pkg:node' }] })],
      }),
    ).toThrowError(/直写闸门未开/u);
    expect(annotationRepo.countPending(db)).toBe(0);
  });

  it('闸门打开后：co_occur 边落库，事实带 origin / batch_id / session_id / turn', async () => {
    const db = freshDb();
    const deps = makeDeps(db, { allow_direct_write: true });

    // 先放一个目标事实（直写路径自己建的）
    const seeded = runMemoryAnnotate(deps, { direct_write: true, facts: [factIn(nodeFact)] });
    const node = factBySubject(db, 'pkg:node');

    const res = await callTool(deps, 'memory_annotate', {
      direct_write: true,
      session_id: 'ss_01jtest',
      turn: 7,
      facts: [factIn({ ...pnpmFact, relations: [{ etype: 'co_occur', to_fact_id: node.id }] })],
    });
    expect(res.isError).toBeFalsy();
    const body = textOf(res) as { accepted: string[]; edges?: string[]; batch_id?: string };
    expect(body.accepted).toHaveLength(1);
    expect(body.batch_id).toMatch(/^b_/u);
    expect(body.edges).toHaveLength(1);

    const pnpm = factBySubject(db, 'pkg:pnpm');
    expect(pnpm.id).toBe(body.accepted[0]);
    expect(pnpm.origin).toBe('mcp_direct');
    expect(pnpm.batchId).toBe(body.batch_id);
    expect(pnpm.sessionId).toBe('ss_01jtest');
    expect(pnpm.turn).toBe(7);

    const edges = edgeRepo.neighbors(db, pnpm.id, { includeClosed: true });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.etype).toBe('co_occur');
    expect(edges[0]!.dst).toBe(node.id);

    // 直写的 annotation 快照立刻视为已消费，harvest 不会二次处理
    expect(annotationRepo.countPending(db)).toBe(0);
    expect(seeded.batch_id).toMatch(/^b_/u);
  });

  it('闸门打开后：写 supersedes 被拒（schema enum 不含它）', async () => {
    const db = freshDb();
    const deps = makeDeps(db, { allow_direct_write: true });

    const res = await callTool(deps, 'memory_annotate', {
      direct_write: true,
      facts: [factIn({ ...pnpmFact, relations: [{ etype: 'supersedes', to_key: 'pkg:node' }] })],
    });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    // 类型白名单的第一道闸是 zod：schema 之外的类型进不来
    expect(String(body.message)).toContain('Invalid enum value');
    expect(annotationRepo.countPending(db)).toBe(0);
    expect(factRepo.findActiveBySubjectName(db, 'pkg:pnpm')).toHaveLength(0);
  });

  it('闸门打开后：depends_on 不落边、进隔离区（reason=needs_review）', async () => {
    const db = freshDb();
    const deps = makeDeps(db, { allow_direct_write: true });
    runMemoryAnnotate(deps, { direct_write: true, facts: [factIn(nodeFact)] });
    const node = factBySubject(db, 'pkg:node');

    const result = runMemoryAnnotate(deps, {
      direct_write: true,
      facts: [factIn({ ...pnpmFact, relations: [{ etype: 'depends_on', to_fact_id: node.id }] })],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.quarantined).toEqual([{ index: 0, reason: 'needs_review' }]);
    expect(result.edges).toBeUndefined();
    const pnpm = factBySubject(db, 'pkg:pnpm');
    expect(edgeRepo.neighbors(db, pnpm.id, { includeClosed: true })).toHaveLength(0);
  });

  it('量级约束：单批超限整批拒绝（E_QUOTA），一条都不写', async () => {
    const db = freshDb();
    const deps = makeDeps(db, { allow_direct_write: true, direct_write_batch_max: 1 });

    const res = await callTool(deps, 'memory_annotate', {
      direct_write: true,
      facts: [pnpmFact, nodeFact],
    });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body.error).toBe('E_QUOTA');
    expect(factRepo.countFacts(db)).toBe(0);
  });

  it('量级约束：每分钟超限返回 E_QUOTA 并带 retry_after_ms', async () => {
    const db = freshDb();
    const deps = makeDeps(db, { allow_direct_write: true, direct_write_per_minute_max: 1 });

    runMemoryAnnotate(deps, { direct_write: true, facts: [factIn(nodeFact)] });
    const res = await callTool(deps, 'memory_annotate', {
      direct_write: true,
      facts: [factIn(pnpmFact)],
    });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body.error).toBe('E_QUOTA');
    expect(String(body.message)).toContain('每分钟');
    // 限速错误必须带窗口信息，否则 Agent 只能盲重试
    expect(body.retry_after_ms).toBe(60_000);
  });

  it('冲突不越权：单值谓词换值时不失效旧事实、不建审核类边，整条进隔离区', () => {
    const db = freshDb();
    const deps = makeDeps(db, { allow_direct_write: true });

    runMemoryAnnotate(deps, { direct_write: true, facts: [factIn(pnpmFact)] });
    const old = factBySubject(db, 'pkg:pnpm');

    // 同一个 (subject, predicate) 换一个值：单值谓词的裁决不能替调用方做
    const second = runMemoryAnnotate(deps, {
      direct_write: true,
      facts: [factIn({ ...pnpmFact, content: 'pnpm 版本是 10.0.0', value: '10.0.0' })],
    });

    expect(second.accepted).toEqual([]);
    expect(second.quarantined).toEqual([{ index: 0, reason: 'conflict_needs_review' }]);
    expect(factRepo.countFacts(db)).toBe(1);

    // 旧事实没被静默失效，也没有 supersedes / mutually_exclusive 这类审核边
    expect(factRepo.getFact(db, old.id)!.validTo).toBeNull();
    expect(edgeRepo.neighbors(db, old.id, { includeClosed: true })).toHaveLength(0);
    // 裁决单也不许凭空开（否则撤销后就是悬空记录）
    expect(db.prepare('SELECT COUNT(*) AS n FROM adjudication').get()).toEqual({ n: 0 });

    // 隔离区留了可复核的记录
    const open = quarantineRepo.listOpen(db);
    expect(open).toHaveLength(1);
    expect(open[0]!.reason).toBe('conflict_needs_review');

    // 撤销这一批（它一条事实都没写）后，旧事实依然有效
    revokeDirectBatch(db, second.batch_id!);
    expect(factRepo.getFact(db, old.id)!.validTo).toBeNull();
    expect(edgeRepo.neighbors(db, old.id, { includeClosed: true })).toHaveLength(0);
  });

  it('批次撤销：事实与边同时消失，annotation 一并回滚，且 audit 留痕', () => {
    const db = freshDb();
    const deps = makeDeps(db, { allow_direct_write: true });

    runMemoryAnnotate(deps, { direct_write: true, facts: [factIn(nodeFact)] });
    const node = factBySubject(db, 'pkg:node');
    const written = runMemoryAnnotate(deps, {
      direct_write: true,
      facts: [factIn({ ...pnpmFact, relations: [{ etype: 'derived_from', to_fact_id: node.id }] })],
    });

    const batchId = written.batch_id!;
    const factId = written.accepted[0]!;
    const edgeId = written.edges![0]!;
    expect(edgeRepo.getEdge(db, edgeId)).not.toBeNull();

    const out = revokeDirectBatch(db, batchId);

    expect(out.batchId).toBe(batchId);
    expect(out.facts).toEqual([factId]);
    expect(out.edges).toContain(edgeId);
    expect(out.annotations).toHaveLength(1);

    // 事实、边、annotation 三样都没了
    expect(factRepo.getFact(db, factId)).toBeNull();
    expect(edgeRepo.getEdge(db, edgeId)).toBeNull();
    expect(annotationRepo.countPending(db)).toBe(0);
    expect(annotationRepo.get(db, out.annotations[0]!)).toBeNull();
    // 目标事实不属于这一批，撤销不能误伤
    expect(factRepo.getFact(db, node.id)).not.toBeNull();

    // audit：三张表各留一条，reason 记着批次号（撤销可查，不是删除即遗忘）
    const rows = db
      .prepare('SELECT tbl, row_id FROM audit WHERE reason = ? ORDER BY tbl')
      .all(batchId) as { tbl: string; row_id: string }[];
    expect(rows.map((r) => r.tbl).sort()).toEqual(['annotation', 'edge', 'fact']);
    expect(rows.map((r) => r.row_id)).toContain(factId);
    expect(rows.map((r) => r.row_id)).toContain(edgeId);
    expect(auditRepo.auditByRow(db, 'fact', factId)).toHaveLength(1);

    // 幂等：重复撤销不抛错，也不产生新的 audit
    const again = revokeDirectBatch(db, batchId);
    expect(again.facts).toEqual([]);
    const after = db
      .prepare('SELECT COUNT(*) AS n FROM audit WHERE reason = ?')
      .get(batchId) as { n: number };
    expect(after.n).toBe(3);
  });
});
