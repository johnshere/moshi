/**
 * P2-21 两阶段扫描器单元测试（详设 §5.12.2–§5.12.5）。
 *
 * 覆盖台账验收的三条：同名 transcript 扫两遍计数不变、阶段 2 只在无块 turn 上跑、
 * 超预算即停并记 `llm_scan_budget_exhausted`。另外补失败语义与块游标。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as quarantineRepo from '../../src/infra/sqlite/quarantineRepo.js';
import { harvest } from '../../src/core/write/harvest.js';
import type { Cursor } from '../../src/core/adapters/cursor.js';
import type { RawEvent, SessionRef, SessionSource } from '../../src/core/adapters/session-source.js';
import {
  BlockCursorStore,
  scanSessionSource,
  scanTurns,
  type CollectConfig,
  type LlmScanResult,
  type ScanTurn,
} from '../../src/core/collect/scanner.js';

const dirs: string[] = [];
const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-scanner-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function count(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

const T0 = '2026-11-02T02:00:00.000Z';

function cfgOf(over: Partial<CollectConfig> = {}): CollectConfig {
  return {
    enabled: true,
    llmScan: true,
    llmBatchTurns: 40,
    llmPerSessionDaily: 1,
    llmDailyTokenBudget: 100_000,
    promptVersion: 'v1',
    ...over,
  };
}

function turn(index: number, text: string): ScanTurn {
  return {
    index,
    ts: T0,
    sessionId: 's1',
    rawHash: `h${String(index)}`,
    text,
  };
}

const BLOCK = `\`\`\`moshi
{"v":1,"facts":[{"subject":"daemon","predicate":"port","value":"53000",
 "content":"daemon 监听端口 = 53000","confidence":0.95,"source":"tool_obs"}],"edges":[]}
\`\`\``;

const MALFORMED = '```moshi\n{"v":1, "facts": [}\n```';
const UNKNOWN = '```moshi\n{"v":99,"facts":[],"edges":[]}\n```';

describe('P2-21 阶段 1：埋点块解析', () => {
  it('同一份 turn 扫两遍：annotation 不增长，第二遍计为重复', async () => {
    const db = freshDb();
    const turns = [turn(0, `我记一下\n${BLOCK}`)];

    const first = await scanTurns(db, 's1', turns, { cfg: cfgOf() });
    expect(first.blockAnnotationsCreated).toBe(1);
    expect(count(db, 'annotation')).toBe(1);

    const second = await scanTurns(db, 's1', turns, { cfg: cfgOf() });
    expect(second.blockAnnotationsCreated).toBe(0);
    expect(second.blockAnnotationsDuplicate).toBe(1);
    expect(count(db, 'annotation')).toBe(1);
  });

  it('扫两遍之后 harvest 出的事实数为 0 增量（端到端幂等）', async () => {
    const db = freshDb();
    const turns = [turn(0, BLOCK)];

    await scanTurns(db, 's1', turns, { cfg: cfgOf() });
    await harvest(db);
    const factsAfterFirst = count(db, 'fact');
    expect(factsAfterFirst).toBe(1);

    await scanTurns(db, 's1', turns, { cfg: cfgOf() });
    await harvest(db);
    expect(count(db, 'fact')).toBe(factsAfterFirst);
  });

  it('畸形块与未知版本进隔离区并计数，不阻断同 turn 的其它块', async () => {
    const db = freshDb();
    const stats = await scanTurns(db, 's1', [turn(0, `${MALFORMED}\n${UNKNOWN}\n${BLOCK}`)], {
      cfg: cfgOf(),
    });

    expect(stats.malformed).toBe(1);
    expect(stats.unknownVersion).toBe(1);
    expect(stats.blockAnnotationsCreated).toBe(1);
    const reasons = quarantineRepo.countByReason(db);
    expect(reasons['ann_malformed']).toBe(1);
    expect(reasons['ann_version_unknown']).toBe(1);
  });
});

describe('P2-21 阶段 2：LLM 兜底', () => {
  it('只在无块 turn 上跑，且置信被压到 ≤0.6', async () => {
    const db = freshDb();
    const seen: number[][] = [];
    const llm = async (batch: ScanTurn[]): Promise<LlmScanResult> => {
      seen.push(batch.map((t) => t.index));
      return {
        facts: [
          {
            subject: 'proxy',
            etype: 'concept',
            predicate: 'env',
            value: 'noproxy',
            content: 'proxy.env = noproxy',
            confidence: 0.99,
          },
        ],
        tokensUsed: 10,
      };
    };

    const turns = [turn(0, BLOCK), turn(1, '随便聊两句，没有埋点'), turn(2, '再聊两句')];
    await scanTurns(db, 's1', turns, { cfg: cfgOf({ llmBatchTurns: 40 }), llm });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([1, 2]);

    const row = db
      .prepare(`SELECT payload_json, origin FROM annotation WHERE origin = 'llm_scan@v1'`)
      .get() as { payload_json: string; origin: string };
    const payload = JSON.parse(row.payload_json) as { facts: { confidence: number }[] };
    expect(payload.facts[0]?.confidence).toBeLessThanOrEqual(0.6);
  });

  it('token 用尽即停，并记 llm_scan_budget_exhausted', async () => {
    const db = freshDb();
    let calls = 0;
    const llm = async (): Promise<LlmScanResult> => {
      calls += 1;
      return { facts: [], tokensUsed: 60 };
    };

    const turns = [turn(0, 'a'), turn(1, 'b'), turn(2, 'c')];
    const stats = await scanTurns(db, 's1', turns, {
      cfg: cfgOf({ llmBatchTurns: 1, llmDailyTokenBudget: 100 }),
      llm,
    });

    // 第 1 批（60 < 100）→ 第 2 批（累计 120 ≥ 100）停；第 3 批不再调用
    expect(calls).toBe(2);
    expect(stats.llmBudgetExhausted).toBe(true);
    expect(stats.notices).toContain('llm_scan_budget_exhausted');
  });

  it('同一会话同一天第二次不再调用模型（会话闸）', async () => {
    const db = freshDb();
    let calls = 0;
    const llm = async (): Promise<LlmScanResult> => {
      calls += 1;
      return { facts: [], tokensUsed: 5 };
    };

    await scanTurns(db, 's1', [turn(0, 'x')], { cfg: cfgOf(), llm });
    const second = await scanTurns(db, 's1', [turn(0, 'x')], { cfg: cfgOf(), llm });

    expect(calls).toBe(1);
    expect(second.notices).toContain('llm_scan_session_daily_reached');
  });

  it('LLM 抛错记为 llm_scan_unavailable，阶段 1 的结果仍在', async () => {
    const db = freshDb();
    const llm = async (): Promise<LlmScanResult> => {
      throw new Error('sidecar down');
    };

    const stats = await scanTurns(db, 's1', [turn(0, BLOCK), turn(1, '无块')], {
      cfg: cfgOf(),
      llm,
    });

    expect(stats.notices).toContain('llm_scan_unavailable');
    expect(stats.blockAnnotationsCreated).toBe(1);
  });
});

describe('P2-21 块游标与文件扫描', () => {
  function fakeSource(events: RawEvent[]): SessionSource {
    return {
      name: 'fake',
      detect: async () => ({ found: true, root: '/tmp/fake' }),
      listSessions: async function* (since: string): AsyncIterable<SessionRef> {
        void since;
      },
      readEpisode: async function* (
        ref: SessionRef,
        cursor: Cursor | null,
      ): AsyncGenerator<RawEvent, Cursor, void> {
        void ref;
        const start = cursor?.offset ?? 0;
        for (const e of events.slice(start)) yield e;
        return { offset: events.length, lastTs: null, size: events.length, inode: 0 };
      },
    };
  }

  function ev(text: string, i: number): RawEvent {
    return {
      ts: `2026-11-02T02:00:0${String(i)}.000Z`,
      sessionId: 's1',
      cwd: null,
      agent: 'fake',
      rawHash: `raw${String(i)}`,
      rawPath: '/tmp/fake/s1.jsonl',
      role: 'assistant',
      text,
    };
  }

  it('扫完后游标推进到已消费的 turn 数，第二遍不再产生新 annotation', async () => {
    const db = freshDb();
    const source = fakeSource([ev(BLOCK, 0), ev('纯聊天', 1)]);
    const ref: SessionRef = {
      source: 'fake',
      path: '/tmp/fake/s1.jsonl',
      sessionId: 's1',
      size: 2,
      mtimeMs: 0,
    };

    const first = await scanSessionSource(db, source, ref, null, { cfg: cfgOf({ llmScan: false }) });
    expect(first.turns).toBe(2);
    expect(first.blockAnnotationsCreated).toBe(1);
    expect(first.nextCursor.turnIndex).toBe(2);
    expect(count(db, 'annotation')).toBe(1);

    const second = await scanSessionSource(db, source, ref, first.nextCursor, {
      cfg: cfgOf({ llmScan: false }),
    });
    expect(second.turns).toBe(0);
    expect(second.nextCursor.turnIndex).toBe(2);
    expect(count(db, 'annotation')).toBe(1);
  });

  function toolEv(i: number, command: string, output: string): RawEvent {
    return {
      ts: `2026-11-02T02:00:0${String(i)}.000Z`,
      sessionId: 's1',
      cwd: null,
      agent: 'fake',
      rawHash: `raw${String(i)}`,
      rawPath: '/tmp/fake/s1.jsonl',
      role: 'tool',
      tool: { name: 'Bash', input: { command }, output },
    };
  }

  it('工具回合经 ingest 落 episode + tool_parse annotation，重扫不翻倍', async () => {
    const db = freshDb();
    const source = fakeSource([ev('纯聊天', 0), toolEv(1, 'node -v', 'v22.9.0')]);
    const ref: SessionRef = {
      source: 'fake',
      path: '/tmp/fake/s1.jsonl',
      sessionId: 's1',
      size: 2,
      mtimeMs: 0,
    };

    const first = await scanSessionSource(db, source, ref, null, { cfg: cfgOf({ llmScan: false }) });

    expect(first.turns).toBe(1);
    expect(first.episodesCreated).toBe(2);
    expect(first.toolAnnotationsCreated).toBe(1);
    expect(count(db, 'episode')).toBe(2);
    expect(count(db, 'annotation')).toBe(1);
    const row = db.prepare('SELECT channel, payload_json FROM annotation').get() as {
      channel: string;
      payload_json: string;
    };
    expect(row.channel).toBe('tool_parse');
    expect((JSON.parse(row.payload_json) as { cmd: string; output: string }).cmd).toBe('node -v');
    expect((JSON.parse(row.payload_json) as { cmd: string; output: string }).output).toBe('v22.9.0');

    // 游标丢失后从头重读：episode 的 (raw_hash, session) 与 annotation 的
    // dedup_key 都挡住重复，计数不涨
    const replay = await scanSessionSource(db, source, ref, null, {
      cfg: cfgOf({ llmScan: false }),
    });
    expect(replay.episodesCreated).toBe(0);
    expect(replay.toolAnnotationsCreated).toBe(0);
    expect(count(db, 'episode')).toBe(2);
    expect(count(db, 'annotation')).toBe(1);
  });

  it('块游标文件损坏时重建为空游标而不是抛错', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moshi-cursor-'));
    dirs.push(dir);
    const file = path.join(dir, 'cursors.blocks.json');
    let reason = '';
    const store = BlockCursorStore.load(file, (r) => {
      reason = r;
    });
    expect(store.get('fake', '/nope')).toBeNull();
    expect(reason).toBe('');

    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{"sessions": 3}', 'utf8');
    const broken = BlockCursorStore.load(bad, (r) => {
      reason = r;
    });
    expect(broken.get('fake', '/nope')).toBeNull();
    expect(reason).not.toBe('');
  });
});
