/**
 * MCP 工具单元测试（详设 §4.1）。
 *
 * 不经过 HTTP / MCP 传输层，直接测 `callTool` 与各 handler——
 * 传输层 correctness 由 SDK 保证，我们只需保证"业务对不对"。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { callTool, findTool, TOOL_SPECS } from '../../src/app/mcp/tools.js';
import { runMemoryQuery, FEEDBACK_HINT, PROTOCOL_HINT } from '../../src/app/mcp/query.js';
import { runMemoryAnnotate } from '../../src/app/mcp/annotate.js';
import { runMemoryFeedback } from '../../src/app/mcp/feedback.js';
import { runMemoryCorrect } from '../../src/app/mcp/correct.js';
import { insertDerivedPoint, insertFact } from '../fixtures/factories.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import * as auditRepo from '../../src/infra/sqlite/auditRepo.js';
import * as annotationRepo from '../../src/infra/sqlite/annotationRepo.js';
import * as queryLogRepo from '../../src/infra/sqlite/queryLogRepo.js';
import * as feedbackRepo from '../../src/infra/sqlite/feedbackRepo.js';
import type { McpDeps } from '../../src/app/mcp/deps.js';
import type { QueryInput, AnnotateInput, CorrectInput } from '../../src/app/mcp/schemas.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-mcp-'));
  dirs.push(d);
  return d;
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function makeDeps(db: Db): McpDeps {
  const home = tempDir();
  return { db, cfg: loadConfig({ home }) };
}

/**
 * 工厂 insertFact 是裸 SQL（故意绕过仓储层），不会同步 fact_fts；
 * 凡是要走 BM25 召回的用例，插入后必须补一次同步，否则查不到。
 */
function syncFts(db: Db): void {
  syncMissingFts(db);
}

/** 从 CallToolResult 里安全地取出 text */
function textOf(r: { content: Array<{ type?: string; text?: string }> }): string | undefined {
  return r.content.find((c) => c.type === 'text')?.text;
}

describe('TOOL_SPECS', () => {
  it('正好 4 个工具', () => {
    expect(TOOL_SPECS.map((t) => t.name)).toEqual([
      'memory_query',
      'memory_annotate',
      'memory_feedback',
      'memory_correct',
    ]);
  });

  it('memory_correct 必须 destructiveHint=true（台账 D-23）', () => {
    const t = findTool('memory_correct');
    expect(t).not.toBeNull();
    expect(t!.annotations.destructiveHint).toBe(true);
  });
});

describe('callTool', () => {
  it('未知工具返回 E_INPUT', async () => {
    const deps = makeDeps(freshDb());
    const r = await callTool(deps, 'memory_unknown', {});
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r) ?? '{}').error).toBe('E_INPUT');
  });

  it('参数校验失败返回 E_INTERNAL（ZodError 被 errorResult 包装）', async () => {
    const deps = makeDeps(freshDb());
    const r = await callTool(deps, 'memory_query', { query: 123 });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r) ?? '{}').error).toBe('E_INTERNAL');
  });
});

describe('memory_query', () => {
  const baseQuery: QueryInput = {
    query: 'node',
    top_k: 10,
    scope: 'global',
    include_history: false,
    format: 'json',
  };

  it('空库：冷启动 + 无 sidecar 都如实降级，绝不报 ok+空', async () => {
    const deps = makeDeps(freshDb());
    const r = await runMemoryQuery(deps, baseQuery);
    expect(r.status).toBe('degraded');
    // 详设 §6.13：查失败绝不报 ok+空。冷启动与向量路缺失都是降级，不是"查到了、没有"
    expect(r.degraded).toContain('cold_start');
    expect(r.degraded).toContain('no_sidecar');
    expect(r.evidence).toHaveLength(0);
    expect(r.confidence_summary).toBe('none');
  });

  it('能按关键词查到事实（BM25 路，无模型也可用）', async () => {
    const db = freshDb();
    insertFact(db, { content: 'node version = 22' });
    insertFact(db, { content: 'python version = 3.13' });
    syncFts(db);
    const deps = makeDeps(db);
    const r = await runMemoryQuery(deps, { ...baseQuery, query: 'node' });
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.content).toContain('node');
  });

  it('m_id 从 1 连续，且写进 query_log', async () => {
    const db = freshDb();
    // 两条 content 都含确定子串 'alpha'，query 匹配不依赖 canonical_key 哈希里碰巧有哪个字母
    const f1 = insertFact(db, { content: 'alpha one' });
    const f2 = insertFact(db, { content: 'alpha two' });
    syncFts(db);
    const deps = makeDeps(db);
    const pack = await runMemoryQuery(deps, { ...baseQuery, query: 'alpha' });
    expect(pack.evidence[0]!.m_id).toBe(1);
    expect(pack.evidence[1]!.m_id).toBe(2);
    // query_log 与 evidence_log 已落盘
    expect(queryLogRepo.countQueryLogs(db)).toBe(1);
    const resolved = queryLogRepo.resolveMIds(db, pack.query_id, [1, 2]);
    expect(resolved.map((x) => x.factId).sort()).toEqual([f1, f2].sort());
  });

  it('text 格式只给编号列表', async () => {
    const db = freshDb();
    insertFact(db, { content: 'aaa' });
    syncFts(db);
    const deps = makeDeps(db);
    const r = await callTool(deps, 'memory_query', {
      query: 'aaa',
      top_k: 5,
      scope: 'global',
      include_history: false,
      format: 'text',
    });
    const txt = textOf(r);
    expect(txt).toContain('[M1]');
    expect(txt).not.toContain('fact_id');
  });

  it('json 结果带 protocol_hint（P2-20）', async () => {
    const deps = makeDeps(freshDb());
    const r = await runMemoryQuery(deps, { ...baseQuery, format: 'json' });
    expect(r.protocol_hint).toContain('```moshi');
    expect(r.protocol_hint).toContain('moshi://protocol/ann-v1');
  });

  it('有证据才返回人类可读反馈提醒，且不是 JSON', async () => {
    const db = freshDb();
    insertFact(db, { content: 'node version = 22' });
    syncFts(db);
    const deps = makeDeps(db);
    const hit = await runMemoryQuery(deps, { ...baseQuery, query: 'node' });
    expect(hit.evidence).toHaveLength(1);
    expect(hit.feedback_hint).toBe(FEEDBACK_HINT);
    expect(hit.feedback_hint).toContain('【记忆反馈】');
    expect(hit.feedback_hint).toContain('[M1]');
    expect(hit.feedback_hint).not.toContain('{"');

    const miss = await runMemoryQuery(deps, { ...baseQuery, query: 'zzzz-no-such-fact' });
    expect(miss.evidence).toHaveLength(0);
    expect(miss.feedback_hint).toBeUndefined();
  });

  it('text 格式：有证据时带 query_id 与反馈提醒，无证据时不带', async () => {
    const db = freshDb();
    insertFact(db, { content: 'aaa' });
    syncFts(db);
    const deps = makeDeps(db);
    const hit = await callTool(deps, 'memory_query', {
      query: 'aaa',
      top_k: 5,
      scope: 'global',
      include_history: false,
      format: 'text',
    });
    const hitText = textOf(hit);
    expect(hitText).toContain('query_id: q_');
    expect(hitText).toContain('【记忆反馈】');
    expect(hitText).toContain('[M1]');

    const miss = await callTool(deps, 'memory_query', {
      query: 'zzzz-no-such-fact',
      top_k: 5,
      scope: 'global',
      include_history: false,
      format: 'text',
    });
    const missText = textOf(miss);
    expect(missText).not.toContain('query_id: q_');
    expect(missText).not.toContain('【记忆反馈】');
    expect(missText).toContain(PROTOCOL_HINT);
  });

  it('text 格式末尾带 protocol_hint（P2-20）', async () => {
    const db = freshDb();
    insertFact(db, { content: 'aaa' });
    syncFts(db);
    const deps = makeDeps(db);
    const r = await callTool(deps, 'memory_query', {
      query: 'aaa',
      top_k: 5,
      scope: 'global',
      include_history: false,
      format: 'text',
    });
    const txt = textOf(r);
    expect(txt).toContain(PROTOCOL_HINT);
  });
});

describe('memory_annotate', () => {
  const baseFact = {
    content: '用户说偏好 pnpm',
    subject: 'user',
    predicate: 'preference',
    value: 'pnpm',
    subject_type: 'unknown' as const,
    ftype: 'semantic' as const,
    confidence: 0.95,
    valid_at: '2026-01-01T00:00:00Z',
  };

  it('正常插入一条 annotation', () => {
    const db = freshDb();
    const deps = makeDeps(db);
    const r = runMemoryAnnotate(deps, { facts: [baseFact] });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.startsWith('an_')).toBe(true);
    expect(r.quarantined).toHaveLength(0);
    expect(annotationRepo.countPending(db)).toBe(1);
    const row = annotationRepo.get(db, r.accepted[0]!);
    expect(row?.origin).toBe('mcp_direct');
  });

  it('重复调用返回相同 id（幂等）', () => {
    const db = freshDb();
    const deps = makeDeps(db);
    const payload: AnnotateInput = { facts: [baseFact] };
    const r1 = runMemoryAnnotate(deps, payload);
    const r2 = runMemoryAnnotate(deps, payload);
    expect(r1.accepted[0]).toBe(r2.accepted[0]);
    expect(annotationRepo.countPending(db)).toBe(1);
  });

  it('太长内容进隔离区', () => {
    const db = freshDb();
    const deps = makeDeps(db);
    const huge = 'x'.repeat(500_000);
    const r = runMemoryAnnotate(deps, {
      facts: [
        {
          content: huge,
          subject: 'x',
          predicate: 'x',
          value: 'x',
          subject_type: 'unknown',
          ftype: 'semantic',
        },
      ],
    });
    expect(r.quarantined).toHaveLength(1);
    expect(r.accepted).toHaveLength(0);
  });
});

describe('memory_feedback', () => {
  it('正常写 feedback', async () => {
    const db = freshDb();
    insertFact(db, { content: 'aaa' });
    insertFact(db, { content: 'bbb' });
    syncFts(db);
    const deps = makeDeps(db);
    const pack = await runMemoryQuery(deps, {
      query: 'aaa',
      top_k: 10,
      scope: 'global',
      include_history: false,
      format: 'json',
    });
    const r = runMemoryFeedback(deps, {
      query_id: pack.query_id,
      m_ids: [1],
      verdict: 'adopt',
    });
    expect(r.inserted).toBe(1);
    const rows = feedbackRepo.listByFact(db, pack.evidence[0]!.fact_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('adopt');
  });

  it('m_id 越界返回 unresolved_m_ids', async () => {
    const db = freshDb();
    const deps = makeDeps(db);
    const pack = await runMemoryQuery(deps, {
      query: 'xyz',
      top_k: 10,
      scope: 'global',
      include_history: false,
      format: 'json',
    });
    const r = runMemoryFeedback(deps, {
      query_id: pack.query_id,
      m_ids: [99],
      verdict: 'adopt',
    });
    expect(r.unresolved_m_ids).toContain(99);
    expect(r.inserted).toBe(0);
  });

  it('verdict 驱动强度事件：adopt 增量、reject 乘性、correct 不动；重复反馈幂等', async () => {
    const db = freshDb();
    const fid = insertFact(db, { content: 'aaa', strength: 0.5 });
    syncFts(db);
    const deps = makeDeps(db);
    const pack = await runMemoryQuery(deps, {
      query: 'aaa',
      top_k: 10,
      scope: 'global',
      include_history: false,
      format: 'json',
    });
    expect(pack.evidence[0]!.fact_id).toBe(fid);

    // adopt：0.5 + 0.15·(1-0.5) = 0.575
    runMemoryFeedback(deps, { query_id: pack.query_id, m_ids: [1], verdict: 'adopt' });
    expect(factRepo.getFact(db, fid)!.strength).toBeCloseTo(0.575, 4);

    // 同一条反馈重发（幂等键命中）不许把强度再推一遍
    const dup = runMemoryFeedback(deps, { query_id: pack.query_id, m_ids: [1], verdict: 'adopt' });
    expect(dup.duplicates).toBe(1);
    expect(factRepo.getFact(db, fid)!.strength).toBeCloseTo(0.575, 4);

    // correct 刻意不动强度（既不是独立验证一致，也不该乘性惩罚）
    runMemoryFeedback(deps, { query_id: pack.query_id, m_ids: [1], verdict: 'correct' });
    expect(factRepo.getFact(db, fid)!.strength).toBeCloseTo(0.575, 4);

    // reject：0.575 · 0.7 = 0.4025
    runMemoryFeedback(deps, { query_id: pack.query_id, m_ids: [1], verdict: 'reject' });
    expect(factRepo.getFact(db, fid)!.strength).toBeCloseTo(0.4025, 4);
  });
});

describe('memory_correct', () => {
  it('更新 confidence 并写 audit', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: 'aaa', confidence: 0.5 });
    const deps = makeDeps(db);
    const r = runMemoryCorrect(deps, {
      fact_id: fid,
      patch: { confidence: 0.3 },
      reason: '测试降级',
    });
    expect(r.fact_id).toBe(fid);
    expect(r.changed).toContain('confidence');
    const fact = factRepo.getFact(db, fid);
    expect(fact!.confidence).toBe(0.3);
    const audits = auditRepo.auditByRow(db, 'fact', fid);
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('失效源事实后立即收口其派生要点', () => {
    const db = freshDb();
    const src = insertFact(db, {
      ftype: 'episodic',
      validAt: new Date(Date.now() - 1000).toISOString(),
    });
    const point = insertDerivedPoint(db, [src]);
    const deps = makeDeps(db);

    const r = runMemoryCorrect(deps, {
      fact_id: src,
      patch: { epistemic_status: 'invalidated' },
      reason: '测试撤回',
    });
    expect(r.changed).toContain('valid_to');

    const row = db
      .prepare('SELECT valid_to, epistemic_status FROM fact WHERE id = ?')
      .get(point) as { valid_to: string | null; epistemic_status: string };
    expect(row.valid_to).not.toBeNull();
    expect(row.epistemic_status).toBe('invalidated');
  });

  it('改不可变字段 content 报错', () => {
    const db = freshDb();
    const fid = insertFact(db, { content: 'aaa' });
    const deps = makeDeps(db);
    let caught: unknown;
    try {
      runMemoryCorrect(deps, {
        fact_id: fid,
        patch: { content: 'bbb' } as CorrectInput['patch'],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('content');
  });

  it('fact 不存在报错', () => {
    const db = freshDb();
    const deps = makeDeps(db);
    let caught: unknown;
    try {
      runMemoryCorrect(deps, {
        fact_id: 'f_noexist',
        patch: { confidence: 0.1 },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('不存在');
  });
});
