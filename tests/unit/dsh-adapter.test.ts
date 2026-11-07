import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cursor } from '../../src/core/adapters/cursor.js';
import { DshAdapter, parseDshLine, zstdFrameLength, type DshParseContext } from '../../src/core/adapters/dsh.js';
import { createSource, createSourceFor } from '../../src/core/adapters/index.js';
import type { RawEvent } from '../../src/core/adapters/session-source.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-dsh-'));
  dirs.push(d);
  return d;
}

const T0 = 1793799375299;
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function ctx(): DshParseContext {
  return {
    rawPath: 'C:/x/session.v4.jsonl.zstd',
    sessionId: 'sess-1',
    fallbackTs: new Date(T0).toISOString(),
    agent: 'dsh',
    cwd: null,
    pending: new Map(),
  };
}

const SESSION = line({
  type: 'session',
  version: 4,
  id: 'sess-1',
  createdAt: T0,
  cwd: 'J:\\Workspace\\Codes\\moshi',
});
const USER = line({
  type: 'user/message',
  seq: 8,
  time: T0,
  data: {
    content: [{ type: 'text', text: '帮我看看 node 版本' }],
    source: { kind: 'user' },
    role: 'user',
  },
});
const ASSISTANT = line({
  type: 'assistant/message',
  seq: 16,
  time: T1,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"node -v"}' },
      ],
    },
  },
});
const CALL = line({
  type: 'tool/call',
  seq: 17,
  time: T1,
  data: { turn: 1, step: 1, callId: 'call_1', name: 'pwsh', arguments: '{"command":"node -v"}' },
});
const RESULT = line({
  type: 'tool/result',
  seq: 18,
  time: T2,
  data: {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId: 'call_1' },
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'v22.9.0' }], isError: false }],
      role: 'user',
    },
  },
});

describe('DSh 适配器：事件映射', () => {
  it('session 行只提供 cwd，不产事件', () => {
    const c = ctx();
    expect(parseDshLine(SESSION, c)).toEqual([]);
    expect(c.cwd).toBe('J:\\Workspace\\Codes\\moshi');
  });

  it('只采用户本人的消息，运行时空注入跳过', () => {
    const c = ctx();
    const events = parseDshLine(USER, c);
    expect(events).toHaveLength(1);
    expect(events?.[0]?.role).toBe('user');
    expect(events?.[0]?.text).toBe('帮我看看 node 版本');

    const injected = line({
      type: 'user/message',
      time: T0,
      data: { content: [{ type: 'text', text: '<time>' }], source: { kind: 'time-context' } },
    });
    expect(parseDshLine(injected, c)).toEqual([]);
  });

  it('assistant 文本与 tool-call 块：只取文本，工具交给 tool/call', () => {
    const events = parseDshLine(ASSISTANT, ctx());
    expect(events).toHaveLength(1);
    expect(events?.[0]?.text).toBe('我查一下');
    expect(events?.[0]?.tool).toBeUndefined();
  });

  it('tool/call + tool/result 跨行配对出名字、入参与输出', () => {
    const c = ctx();
    const call = parseDshLine(CALL, c);
    expect(call?.[0]?.tool).toEqual({ name: 'pwsh', input: { command: 'node -v' } });

    const result = parseDshLine(RESULT, c);
    expect(result?.[0]?.role).toBe('tool');
    expect(result?.[0]?.tool).toEqual({
      name: 'pwsh',
      input: { command: 'node -v' },
      output: 'v22.9.0',
      exitCode: 0,
    });
    expect(c.pending.size).toBe(0);
  });

  it('tool/result 的 error 或 isError → exitCode 1', () => {
    const c = ctx();
    parseDshLine(CALL, c);
    const failed = line({
      type: 'tool/result',
      time: T2,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_1' },
          error: 'exit 2',
          content: [{ type: 'text', text: 'rg: IO error' }],
        },
      },
    });
    const events = parseDshLine(failed, c);
    expect(events?.[0]?.tool?.exitCode).toBe(1);
    expect(events?.[0]?.tool?.output).toBe('rg: IO error');
  });

  it('未知类型返回 null，控制事件返回空数组', () => {
    expect(parseDshLine(line({ type: 'brand/new-event', time: T0, data: {} }), ctx())).toBeNull();
    expect(parseDshLine(line({ type: 'step/start', time: T0, data: {} }), ctx())).toEqual([]);
    expect(parseDshLine('{bad', ctx())).toBeNull();
  });

  it('帧长度：完整帧 = 压缩字节数，半帧 = null', () => {
    const frame = zstdCompressSync(Buffer.from(`${USER}\n`));
    expect(zstdFrameLength(frame, 0)).toBe(frame.length);
    expect(zstdFrameLength(frame.subarray(0, frame.length - 3), 0)).toBeNull();
  });
});

async function drain<T>(gen: AsyncGenerator<T, Cursor>): Promise<{ items: T[]; cursor: Cursor }> {
  const items: T[] = [];
  let step = await gen.next();
  while (!step.done) {
    items.push(step.value);
    step = await gen.next();
  }
  return { items, cursor: step.value };
}

function frame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(`${text}\n`));
}

describe('DSh 适配器：会话扫描与游标', () => {
  function setup(): { root: string; file: string } {
    const root = tempDir();
    const sessionDir = path.join(root, '--proj--', 'sess-1');
    mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
    writeFileSync(file, Buffer.concat([frame(SESSION), frame(USER), frame(ASSISTANT), frame(CALL), frame(RESULT)]));
    return { root, file };
  }

  it('listSessions 找到 <project>/<session>/session.v*.jsonl.zstd', async () => {
    const { root, file } = setup();
    const adapter = new DshAdapter({ root });
    const refs: { sessionId: string; path: string }[] = [];
    for await (const ref of adapter.listSessions('1970-01-01T00:00:00.000Z')) refs.push(ref);
    expect(refs).toEqual([{ sessionId: 'sess-1', path: file, source: 'dsh', size: expect.any(Number), mtimeMs: expect.any(Number) }]);
  });

  it('readEpisode 按序产出事件，cwd 来自 session 行', async () => {
    const { root, file } = setup();
    const adapter = new DshAdapter({ root });
    const ref = { source: 'dsh', path: file, sessionId: 'sess-1', size: 0, mtimeMs: 0 };
    const { items, cursor } = await drain(adapter.readEpisode(ref, null));
    expect(items.map((e: RawEvent) => e.role)).toEqual(['user', 'assistant', 'assistant', 'tool']);
    expect(items[0]?.cwd).toBe('J:\\Workspace\\Codes\\moshi');
    expect(items[3]?.tool?.output).toBe('v22.9.0');
    expect(cursor.offset).toBe(statSync(file).size);
    expect(adapter.lastStats().badJson).toBe(0);
  });

  it('追加一帧后从游标继续只读新内容', async () => {
    const { root, file } = setup();
    const adapter = new DshAdapter({ root });
    const ref = { source: 'dsh', path: file, sessionId: 'sess-1', size: 0, mtimeMs: 0 };
    const first = await drain(adapter.readEpisode(ref, null));

    const more = line({
      type: 'user/message',
      time: T2,
      data: { content: [{ type: 'text', text: '再看一下 pnpm 版本' }], source: { kind: 'user' } },
    });
    appendFileSync(file, frame(more));
    const second = await drain(adapter.readEpisode(ref, first.cursor));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.text).toBe('再看一下 pnpm 版本');
    expect(second.cursor.offset).toBeGreaterThan(first.cursor.offset);
  });

  it('半帧不消费：游标停在帧首，补全后能读到', async () => {
    const { root, file } = setup();
    const adapter = new DshAdapter({ root });
    const ref = { source: 'dsh', path: file, sessionId: 'sess-1', size: 0, mtimeMs: 0 };
    const first = await drain(adapter.readEpisode(ref, null));

    const more = line({
      type: 'user/message',
      time: T2,
      data: { content: [{ type: 'text', text: '半帧测试' }], source: { kind: 'user' } },
    });
    const f = frame(more);
    appendFileSync(file, f.subarray(0, Math.max(1, f.length - 4)));
    const partial = await drain(adapter.readEpisode(ref, first.cursor));
    expect(partial.items).toHaveLength(0);
    expect(partial.cursor.offset).toBe(first.cursor.offset);

    appendFileSync(file, f.subarray(Math.max(1, f.length - 4)));
    const complete = await drain(adapter.readEpisode(ref, partial.cursor));
    expect(complete.items).toHaveLength(1);
    expect(complete.items[0]?.text).toBe('半帧测试');
  });

  it('createSource / createSourceFor 能按名字实例化', () => {
    expect(createSource('dsh')).toBeInstanceOf(DshAdapter);
    expect(
      createSourceFor({ id: 'dsh-dev', adapter: 'dsh', root: 'C:/x', enabled: true }),
    ).toBeInstanceOf(DshAdapter);
  });
});
