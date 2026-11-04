/**
 * 写入闭环（P1-22）：`memory_annotate` 入队 → harvest runner 消费 → 事实可查。
 *
 * 这条链路此前只在 `moshi import` 里存在——通过 MCP 说"记住"的事实会永远躺在
 * `annotation` 表里。本文件锁三件事：入队后有人消费、没有唤醒时有兜底轮询、
 * `stop()` 之后不再消费。
 *
 * P2-09 补一条：episodic 观测落库后，**同一个 runner 这一轮收尾**就把同 key 的
 * ≥3 条观测归纳成 1 条 semantic 要点——这是巩固的生产接线点（DoD ⑥）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { startHarvestRunner, type HarvestRunner } from '../../src/app/harvestRunner.js';
import { runMemoryAnnotate } from '../../src/app/mcp/annotate.js';
import { runMemoryQuery } from '../../src/app/mcp/query.js';
import { ingestEvent } from '../../src/core/write/ingest.js';
import * as annotationRepo from '../../src/infra/sqlite/annotationRepo.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { bm25Search } from '../../src/infra/sqlite/ftsRepo.js';
import type { McpDeps } from '../../src/app/mcp/deps.js';

const opened: Db[] = [];
const dirs: string[] = [];
const runners: HarvestRunner[] = [];

afterEach(() => {
  // 先停消费者再关库：正在跑的一轮 harvest 会拿到已关闭的句柄
  for (const r of runners.splice(0)) r.stop();
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-harvest-'));
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

function runnerFor(db: Db, intervalMs: number): HarvestRunner {
  const runner = startHarvestRunner({ db, intervalMs });
  runners.push(runner);
  return runner;
}

function makeDeps(db: Db, onEnqueued?: () => void): McpDeps {
  const home = tempDir();
  return { db, cfg: loadConfig({ home }), ...(onEnqueued === undefined ? {} : { onEnqueued }) };
}

const FACT = {
  content: '写入闭环验证：sidecar port 7001 监听',
  subject: 'service:write-loop',
  subject_type: 'service' as const,
  predicate: 'listens_on',
  value: { port: 7001 },
  ftype: 'semantic' as const,
};

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('写入闭环（P1-22）', () => {
  it('annotate 入队后立刻被消费，事实可查', async () => {
    const db = freshDb();
    let woke = 0;
    const runner = runnerFor(db, 0);
    const deps = makeDeps(db, () => {
      woke += 1;
      runner.wake();
    });

    const res = runMemoryAnnotate(deps, { facts: [FACT] });
    expect(res.accepted).toHaveLength(1);
    // 入队是同步的，消费是异步的：先确认"排在队里"
    expect(annotationRepo.countPending(db)).toBe(1);

    await waitUntil(() => annotationRepo.countPending(db) === 0);

    expect(woke).toBe(1);
    expect(factRepo.countFacts(db)).toBe(1);
    // FTS 由仓储层同步：事实落库即可被 BM25 检索到
    expect(bm25Search(db, '7001', 5)).toHaveLength(1);

    const pack = await runMemoryQuery(deps, {
      query: '7001',
      top_k: 5,
      scope: 'global',
      include_history: false,
      format: 'json',
    });
    expect(pack.evidence.length).toBeGreaterThan(0);
    expect(pack.evidence[0]!.content).toContain('7001');
  });

  it('空队列跑一轮是空转，不报错也不推进批次', async () => {
    const db = freshDb();
    const runner = runnerFor(db, 0);
    const res = await runner.runOnce();
    expect(res.scanned).toBe(0);
    expect(res.batches).toBe(0);
    expect(runner.state()).toMatchObject({ pending: 0, errors: 0, runs: 1 });
  });

  it('没人唤醒时按周期兜底消费', async () => {
    const db = freshDb();
    const runner = runnerFor(db, 20);
    const deps = makeDeps(db); // 不注入 onEnqueued = 模拟"老调用方/无唤醒来源"
    runMemoryAnnotate(deps, { facts: [FACT] });
    await waitUntil(() => annotationRepo.countPending(db) === 0, 3000);
    expect(factRepo.countFacts(db)).toBe(1);
    runner.stop();
  });

  it('stop() 之后不再消费', async () => {
    const db = freshDb();
    const runner = runnerFor(db, 0);
    const deps = makeDeps(db);
    runMemoryAnnotate(deps, { facts: [FACT] });
    runner.stop();
    runner.wake();
    await new Promise((r) => setTimeout(r, 80));
    expect(annotationRepo.countPending(db)).toBe(1);
    expect(factRepo.countFacts(db)).toBe(0);
  });

  it('episodic 观测落库后，同一轮收尾就提炼出 semantic 要点（P2-09 接线点）', async () => {
    const db = freshDb();
    const runner = runnerFor(db, 0);
    const deps = makeDeps(db, () => runner.wake());

    const observations = ['7001', '7002', '7003'].map((port) => ({
      content: `写入闭环巩固验证：sidecar port ${port} 监听`,
      subject: 'service:consolidate',
      subject_type: 'service' as const,
      predicate: 'episodic_listens_on',
      value: { port: Number(port) },
      ftype: 'episodic' as const,
    }));
    expect(runMemoryAnnotate(deps, { facts: observations }).accepted).toHaveLength(3);

    // 3 条源事实 + 1 条要点：巩固在 harvest 之后同步跑完（不需要额外调用）
    await waitUntil(() => factRepo.countFacts(db) >= 4);
    const sources = factRepo.searchFacts(db, { ftype: ['episodic'], limit: 10 });
    const points = factRepo.searchFacts(db, { ftype: ['semantic'], limit: 10 });
    expect(sources).toHaveLength(3);
    expect(points).toHaveLength(1);
    expect(points[0]?.confidenceSource).toBe('derived');
    expect(points[0]?.attrs.ext.derived_from).toBeTypeOf('string');
    // harvest 自己也会抽边（co_occur 等），这里只数溯源边
    const derivedEdges = db
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE etype = 'derived_from' AND valid_to IS NULL")
      .get() as { n: number };
    expect(derivedEdges.n).toBe(3);

    // 再跑一轮：源集合没变 → 幂等，不产生第二个要点
    await runner.runOnce();
    expect(factRepo.searchFacts(db, { ftype: ['semantic'], limit: 10 })).toHaveLength(1);
    expect(factRepo.countFacts(db)).toBe(4);
  });

  it('工具序列落库后，同一轮收尾提炼 procedure（P2-10 接线点）', async () => {
    const db = freshDb();
    const runner = runnerFor(db, 0);
    let second = 0;
    for (const session of ['s1', 's2', 's3']) {
      for (const cmd of ['pnpm install', 'pnpm build', 'pnpm test']) {
        second += 1;
        const ts = new Date(Date.UTC(2026, 10, 4, 0, 0, second)).toISOString();
        ingestEvent(db, {
          ts,
          sessionId: session,
          cwd: '/work/runner',
          agent: 'test',
          rawHash: `${session}:${ts}:${cmd}`,
          rawPath: '/tmp/session.jsonl',
          role: 'tool',
          tool: { name: 'Bash', input: { command: cmd }, output: 'ok', exitCode: 0 },
        });
      }
    }

    await runner.runOnce();
    const procedures = factRepo
      .searchFacts(db, { ftype: ['semantic'], limit: 100 })
      .filter((fact) => fact.confidenceSource === 'procedure');
    expect(procedures).toHaveLength(1);
    expect(procedures[0]?.attrs.frozen.predicate).toBe('procedure:build');

    await runner.runOnce();
    expect(
      factRepo
        .searchFacts(db, { ftype: ['semantic'], limit: 100 })
        .filter((fact) => fact.confidenceSource === 'procedure'),
    ).toHaveLength(1);
  });
});
