import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as annotationRepo from '../../src/infra/sqlite/annotationRepo.js';
import * as episodeRepo from '../../src/infra/sqlite/episodeRepo.js';
import { ClaudeCodeAdapter } from '../../src/core/adapters/claude-code.js';
import type { Cursor } from '../../src/core/adapters/cursor.js';
import type { RawEvent, SessionSource } from '../../src/core/adapters/session-source.js';
import { dedupKeyOf, ingestEvent, ingestSession } from '../../src/core/write/ingest.js';

const dirs: string[] = [];
const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-ingest-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-ingest-file-'));
  dirs.push(d);
  return d;
}

const T0 = '2026-10-31T02:10:00.000Z';
const T1 = '2026-10-31T02:10:01.000Z';
const T2 = '2026-10-31T02:10:02.000Z';

const LINES = [
  JSON.stringify({
    type: 'user',
    timestamp: T0,
    sessionId: 's1',
    cwd: '/home/u/proj',
    message: { role: 'user', content: '看看 node 版本' },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: T1,
    sessionId: 's1',
    cwd: '/home/u/proj',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node -v' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    timestamp: T2,
    sessionId: 's1',
    cwd: '/home/u/proj',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'v22.9.0' }] }],
    },
  }),
];

function writeSession(): { root: string; file: string } {
  const root = tempDir();
  const proj = path.join(root, 'p');
  mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's1.jsonl');
  writeFileSync(file, `${LINES.join('\n')}\n`, 'utf8');
  return { root, file };
}

function ref(file: string) {
  return { source: 'claude-code', path: file, sessionId: 's1', size: 0, mtimeMs: 0 };
}

describe('ingestEvent：先 episode 后 annotation', () => {
  const event: RawEvent = {
    ts: T1,
    sessionId: 's1',
    cwd: '/home/u/proj',
    agent: 'claude-code',
    rawHash: 'hash-1',
    rawPath: '/x/a.jsonl',
    role: 'tool',
    tool: { name: 'Bash', input: { command: 'node -v' }, output: 'v22.9.0', exitCode: 0 },
  };

  it('一条事件产生 1 个 episode + 1 条 annotation，payload 里带 episodeId', () => {
    const db = freshDb();
    const r = ingestEvent(db, event);
    expect(r.episodeCreated).toBe(true);
    expect(r.annotationCreated).toBe(true);

    expect(episodeRepo.countEpisodes(db)).toBe(1);
    expect(annotationRepo.countPending(db)).toBe(1);

    const row = annotationRepo.listPending(db, 10)[0];
    const payload = JSON.parse(row?.payloadJson ?? '{}') as Record<string, unknown>;
    expect(payload['episodeId']).toBe(r.episodeId);
    expect(payload['cmd']).toBe('node -v');
    expect(payload['tool']).toBe('bash'); // 工具名已归一
  });

  it('同一事件重复投递 → 两个去重键都命中，什么都不新建', () => {
    const db = freshDb();
    ingestEvent(db, event);
    const again = ingestEvent(db, event);
    expect(again.episodeCreated).toBe(false);
    expect(again.annotationCreated).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(episodeRepo.countEpisodes(db)).toBe(1);
    expect(annotationRepo.countPending(db)).toBe(1);
  });

  it('同一行拆出的多个事件共享 episode，但 annotation 各一条', () => {
    const db = freshDb();
    const text: RawEvent = {
      ts: T1,
      sessionId: 's1',
      cwd: null,
      agent: 'claude-code',
      rawHash: 'hash-2',
      rawPath: '/x/a.jsonl',
      role: 'assistant',
      text: '我查一下',
    };
    const tool: RawEvent = { ...event, rawHash: 'hash-2' };
    const a = ingestEvent(db, text);
    const b = ingestEvent(db, tool);
    expect(a.episodeId).toBe(b.episodeId);
    expect(a.annotationId).toBeNull(); // 纯文本只留 episode
    expect(b.annotationId).not.toBeNull();
    expect(episodeRepo.countEpisodes(db)).toBe(1);
  });

  it('纯文本事件不产生 annotation（只落 episode.summary）', () => {
    const db = freshDb();
    const r = ingestEvent(db, {
      ts: T0,
      sessionId: 's1',
      cwd: null,
      agent: 'claude-code',
      rawHash: 'hash-3',
      rawPath: '/x/a.jsonl',
      role: 'user',
      text: '第一句。第二句。',
    });
    expect(r.annotationId).toBeNull();
    const rows = episodeRepo.recent(db);
    expect(rows[0]?.summary).toBe('第一句。');
  });

  it('dedupKey 只看事件内容，键序不影响', () => {
    const a: RawEvent = {
      ...event,
      tool: { name: 'Bash', input: { command: 'node -v', cwd: '/x' }, output: 'v', exitCode: 0 },
    };
    const b: RawEvent = {
      ...event,
      tool: { name: 'Bash', input: { cwd: '/x', command: 'node -v' }, output: 'v', exitCode: 0 },
    };
    expect(dedupKeyOf(a)).toBe(dedupKeyOf(b));
    // 输出不同不影响 dedup（同一个 tool_use 的结果被重放不该产生两条标注）
    expect(dedupKeyOf({ ...a, tool: { ...a.tool!, output: 'other' } })).toBe(dedupKeyOf(a));
  });
});

describe('ingestSession：游标只在 episode 落库之后才返回', () => {
  it('读完整个文件，nextCursor.offset == 文件大小', async () => {
    const db = freshDb();
    const { root, file } = writeSession();
    const adapter = new ClaudeCodeAdapter({ root });

    const r = await ingestSession(db, adapter, ref(file), null);
    expect(r.error).toBeUndefined();
    expect(r.nextCursor.offset).toBe(statSync(file).size);
    expect(r.events).toBeGreaterThanOrEqual(4);
    expect(episodeRepo.countEpisodes(db)).toBe(3); // 三行 → 三个 episode
    expect(r.annotations).toBe(1); // 只有 tool_result 那条能解析
  });

  it('用同一游标重放 → 全部命中去重，不新建行', async () => {
    const db = freshDb();
    const { root, file } = writeSession();
    const adapter = new ClaudeCodeAdapter({ root });

    const first = await ingestSession(db, adapter, ref(file), null);
    const second = await ingestSession(db, adapter, ref(file), null);
    expect(second.duplicates).toBe(first.events);
    expect(second.episodes).toBe(0);
    expect(second.annotations).toBe(0);
    expect(episodeRepo.countEpisodes(db)).toBe(3);
    expect(annotationRepo.countPending(db)).toBe(1);
  });

  it('适配器抛错时游标原地不动（宁可重读，不可跳过）', async () => {
    const db = freshDb();
    const cursor: Cursor = { offset: 42, lastTs: T1, size: 100, inode: 5 };
    const broken: SessionSource = {
      name: 'broken',
      detect: async () => ({ found: true, root: '/' }),
      // eslint-disable-next-line require-yield
      async *listSessions() {
        return;
      },
      async *readEpisode() {
        yield {
          ts: T1,
          sessionId: 's1',
          cwd: null,
          agent: 'broken',
          rawHash: 'h',
          rawPath: '/x',
          role: 'user' as const,
          text: 'x',
        };
        throw new Error('读文件时炸了');
      },
    };

    const r = await ingestSession(db, broken, ref('/x/none.jsonl'), cursor);
    expect(r.error).toContain('炸了');
    expect(r.nextCursor).toEqual(cursor);
  });
});
