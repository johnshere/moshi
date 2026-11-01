import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as annotationRepo from '../../src/infra/sqlite/annotationRepo.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import * as quarantineRepo from '../../src/infra/sqlite/quarantineRepo.js';
import * as episodeRepo from '../../src/infra/sqlite/episodeRepo.js';
import { harvest, harvestQueueState, type AnnotatePayload } from '../../src/core/write/harvest.js';
import type { ToolTurnPayload } from '../../src/core/write/ingest.js';
import { DEFAULT_QUARANTINE } from '../../src/core/write/quarantine.js';

const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-harvest-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function enqueueTurn(db: Db, payload: Partial<ToolTurnPayload> & { output: string }): string {
  const full: ToolTurnPayload = {
    tool: 'bash',
    cmd: 'npm install',
    exitCode: 0,
    ...payload,
  } as ToolTurnPayload;
  return annotationRepo.insert(db, {
    dedupKey: `dk-${String(Math.random())}`,
    payloadJson: JSON.stringify(full),
    channel: 'tool_parse',
  }).id;
}

function enqueueAnnotate(db: Db, payload: AnnotatePayload): string {
  return annotationRepo.insert(db, {
    dedupKey: `dk-${String(Math.random())}`,
    payloadJson: JSON.stringify(payload),
    channel: 'annotate',
  }).id;
}

/** `fact.source_episode` 有外键，必须真的先有 episode 行 */
function makeEpisode(db: Db, rawHash: string): string {
  return episodeRepo.insertIfAbsent(db, {
    ts: '2026-10-31T02:10:00.000Z',
    rawHash,
    session: 'ss_test',
    agent: 'claude-code',
    cwd: '/home/u/proj',
  }).id;
}

function countFacts(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number };
  return row.n;
}

function allHarvested(db: Db): boolean {
  return annotationRepo.countPending(db) === 0;
}

describe('harvest：1000 条 annotation（§5.10 验收）', () => {
  it('事实数正确、无重复、harvested_at 全部推进', async () => {
    const db = freshDb();
    // 200 个包各被观测 5 次 → 200 条事实、800 次刷新
    for (let i = 0; i < 1000; i += 1) {
      const n = i % 200;
      enqueueTurn(db, { output: `+ pkg${String(n)}@1.0.${String(n)}\n` });
    }
    expect(annotationRepo.countPending(db)).toBe(1000);

    const r = await harvest(db, { batchSize: 200, yieldBetweenBatches: false });

    expect(r.scanned).toBe(1000);
    expect(r.batches).toBe(5);
    expect(r.created).toBe(200);
    expect(r.refreshed).toBe(800);
    expect(r.failed).toBe(0);
    expect(countFacts(db)).toBe(200);
    expect(allHarvested(db)).toBe(true);

    // 无重复：身份键 + 取值哈希唯一
    const dup = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT canonical_key, scope, value_hash, COUNT(*) AS c FROM fact
            WHERE valid_to IS NULL GROUP BY canonical_key, scope, value_hash HAVING c > 1)`,
      )
      .get() as { n: number };
    expect(dup.n).toBe(0);
  });

  it('再跑一遍什么都不做（幂等）', async () => {
    const db = freshDb();
    for (let i = 0; i < 20; i += 1) {
      enqueueTurn(db, { output: `+ pkg${String(i)}@2.0.0\n` });
    }
    await harvest(db, { yieldBetweenBatches: false });
    const before = countFacts(db);

    const again = await harvest(db, { yieldBetweenBatches: false });
    expect(again.scanned).toBe(0);
    expect(countFacts(db)).toBe(before);
  });

  it('游标丢失导致整批重放：不新建行，只刷新', async () => {
    const db = freshDb();
    for (let i = 0; i < 30; i += 1) {
      enqueueTurn(db, { output: `+ pkg${String(i)}@3.0.0\n` });
    }
    await harvest(db, { yieldBetweenBatches: false });
    expect(countFacts(db)).toBe(30);

    // 模拟"游标丢了，重读整个文件"：把 harvested_at 清空
    db.prepare('UPDATE annotation SET harvested_at = NULL').run();
    const replay = await harvest(db, { yieldBetweenBatches: false });

    expect(replay.scanned).toBe(30);
    expect(replay.created).toBe(0);
    expect(replay.refreshed).toBe(30);
    expect(countFacts(db)).toBe(30);
  });
});

describe('harvest：分批与让出', () => {
  it('按 batchSize 切片，批次数据正确', async () => {
    const db = freshDb();
    for (let i = 0; i < 120; i += 1) {
      enqueueTurn(db, { output: `+ p${String(i)}@1.0.0\n` });
    }
    const r = await harvest(db, { batchSize: 50, yieldBetweenBatches: false });
    expect(r.batches).toBe(3); // 50 + 50 + 20
    expect(r.scanned).toBe(120);
    expect(countFacts(db)).toBe(120);
  });

  it('空队列立刻返回，不空转', async () => {
    const db = freshDb();
    const r = await harvest(db, { yieldBetweenBatches: false });
    expect(r).toMatchObject({ batches: 0, scanned: 0, created: 0 });
  });
});

describe('harvest：三种出口', () => {
  it('未识别工具 → skipped，不入图', async () => {
    const db = freshDb();
    enqueueTurn(db, { cmd: 'echo hello', output: 'hello\n' });
    const r = await harvest(db, { yieldBetweenBatches: false });
    expect(r.skipped).toBe(1);
    expect(countFacts(db)).toBe(0);
    expect(allHarvested(db)).toBe(true);
  });

  it('低置信 → 隔离区，不入图', async () => {
    const db = freshDb();
    enqueueAnnotate(db, {
      subject: 'node',
      etype: 'pkg',
      predicate: 'installed_version',
      value: '18.0.0',
      content: 'node 可能是 18.0.0',
      confidence: 0.1,
    });
    const r = await harvest(db, { yieldBetweenBatches: false });
    expect(r.quarantined).toBe(1);
    expect(countFacts(db)).toBe(0);
    const q = quarantineRepo.listOpen(db);
    expect(q).toHaveLength(1);
    expect(q[0]?.reason).toBe('low_confidence');
  });

  it('毒 payload → failed + 记 error，但照样标 harvested（不堵队列）', async () => {
    const db = freshDb();
    const id = annotationRepo.insert(db, {
      dedupKey: 'dk-bad',
      payloadJson: '{ 这不是 json',
      channel: 'tool_parse',
    }).id;
    enqueueTurn(db, { output: '+ ok@1.0.0\n' });

    const r = await harvest(db, { yieldBetweenBatches: false });
    expect(r.failed).toBe(1);
    expect(r.created).toBe(1);
    expect(allHarvested(db)).toBe(true);
    expect(annotationRepo.get(db, id)?.error).toContain('JSON');

    // 再跑一遍不会重试那条毒数据
    const again = await harvest(db, { yieldBetweenBatches: false });
    expect(again.scanned).toBe(0);
  });
});

describe('harvest：annotate 通道（R1）', () => {
  it('落库时用 llm_claim 先验 0.55', async () => {
    const db = freshDb();
    enqueueAnnotate(db, {
      subject: 'postgres',
      etype: 'pkg',
      predicate: 'installed_version',
      value: '16.1',
      content: 'postgres 是 16.1',
    });
    const r = await harvest(db, { yieldBetweenBatches: false });
    expect(r.created).toBe(1);

    const fact = factRepo.listByIdentityKey(db, '', 'global');
    expect(fact).toEqual([]);
    const all = db.prepare('SELECT * FROM fact').all() as Record<string, unknown>[];
    expect(all).toHaveLength(1);
    expect(all[0]?.['confidence']).toBeCloseTo(0.55, 5);
    expect(all[0]?.['confidence_source']).toBe('llm_claim');
  });

  it('content 写入前脱敏（content 不可变，只能在这一步做）', async () => {
    const db = freshDb();
    enqueueAnnotate(db, {
      subject: 'db',
      etype: 'service',
      predicate: 'env_var',
      value: { user: 'app' },
      content: 'password=hunter2 用于连接数据库',
      confidence: 0.9,
    });
    await harvest(db, { yieldBetweenBatches: false });
    const all = db.prepare('SELECT content FROM fact').all() as { content: string }[];
    expect(all[0]?.content).toBe('password=<REDACTED> 用于连接数据库');
    expect(all[0]?.content).not.toContain('hunter2');
  });

  it('取值里的秘密也被抹掉（哈希因此稳定）', async () => {
    const db = freshDb();
    enqueueAnnotate(db, {
      subject: 'svc',
      etype: 'service',
      predicate: 'env_var',
      value: { token: 'sk-aaaaaaaaaaaaaaaaaaaaaaaa' },
      content: 'svc 的 token 已配置',
      confidence: 0.9,
    });
    await harvest(db, { yieldBetweenBatches: false });
    const row = db.prepare('SELECT attrs FROM fact').get() as { attrs: string };
    expect(row.attrs).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(row.attrs).toContain('<REDACTED');
  });
});

describe('harvest：source_episode 与多事实拆分', () => {
  it('一条 pip 装两个包 → 两条事实共享同一 episode', async () => {
    const db = freshDb();
    const ep = makeEpisode(db, 'rawhash-pip');
    enqueueTurn(db, {
      cmd: 'pip install requests charset-normalizer',
      output: 'Successfully installed requests-2.31.0 charset-normalizer-3.3.2\n',
      episodeId: ep,
    });
    const r = await harvest(db, { yieldBetweenBatches: false });
    expect(r.created).toBe(2);

    const rows = db.prepare('SELECT source_episode FROM fact ORDER BY content').all() as {
      source_episode: string | null;
    }[];
    expect(rows.map((x) => x.source_episode)).toEqual([ep, ep]);
  });

  it('第二次独立观测把置信度抬上去（依赖 source_episode 不同）', async () => {
    const db = freshDb();
    enqueueTurn(db, {
      cmd: 'node -v',
      output: 'v22.9.0\n',
      episodeId: makeEpisode(db, 'rawhash-node-1'),
    });
    await harvest(db, { yieldBetweenBatches: false });
    const first = db.prepare('SELECT confidence FROM fact').get() as { confidence: number };

    enqueueTurn(db, {
      cmd: 'node -v',
      output: 'v22.9.0\n',
      episodeId: makeEpisode(db, 'rawhash-node-2'),
    });
    await harvest(db, { yieldBetweenBatches: false });
    const second = db.prepare('SELECT confidence FROM fact').get() as { confidence: number };

    expect(first.confidence).toBeCloseTo(0.98, 5); // ver.node 先验
    expect(second.confidence).toBeGreaterThan(first.confidence);
  });
});

describe('harvest：队列状态', () => {
  it('pending / errors 计数', async () => {
    const db = freshDb();
    enqueueTurn(db, { output: '+ a@1.0.0\n' });
    annotationRepo.insert(db, { dedupKey: 'x', payloadJson: 'bad', channel: 'tool_parse' });
    expect(harvestQueueState(db)).toEqual({ pending: 2, errors: 0 });
    await harvest(db, { yieldBetweenBatches: false });
    expect(harvestQueueState(db)).toEqual({ pending: 0, errors: 1 });
  });

  it('可调阈值：把 minConfidence 提到 0.99 后 0.98 的先验也进隔离区', async () => {
    const db = freshDb();
    enqueueTurn(db, { cmd: 'node -v', output: 'v22.9.0\n' });
    const r = await harvest(db, {
      yieldBetweenBatches: false,
      quarantine: { ...DEFAULT_QUARANTINE, minConfidence: 0.99 },
    });
    expect(r.quarantined).toBe(1);
    expect(countFacts(db)).toBe(0);
  });
});
