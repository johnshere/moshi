import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CursorStore,
  planRead,
  readLines,
  splitCompleteLines,
  statOrNull,
  type Cursor,
} from '../../src/core/adapters/cursor.js';
import { ClaudeCodeAdapter, parseClaudeLine } from '../../src/core/adapters/claude-code.js';
import { GenericJsonlAdapter } from '../../src/core/adapters/generic-jsonl.js';
import { createSource } from '../../src/core/adapters/index.js';
import {
  canonicalToolName,
  emptyStats,
  failureRate,
  isAdapterStale,
  probeJsonlShape,
  toToolTurns,
  type RawEvent,
} from '../../src/core/adapters/session-source.js';
import { parseTurn } from '../../src/core/parse/registry.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-adapter-'));
  dirs.push(d);
  return d;
}

function writeSession(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

const T0 = '2026-10-31T02:10:00.000Z';
const T1 = '2026-10-31T02:10:01.000Z';
const T2 = '2026-10-31T02:10:02.000Z';

const LINES = {
  userText: JSON.stringify({
    type: 'user',
    timestamp: T0,
    sessionId: 's1',
    cwd: '/home/u/proj',
    message: { role: 'user', content: '帮我看看 node 版本' },
  }),
  assistant: JSON.stringify({
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
  toolResult: JSON.stringify({
    type: 'user',
    timestamp: T2,
    sessionId: 's1',
    cwd: '/home/u/proj',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'v22.9.0' }] }],
    },
  }),
};

async function drain<T>(gen: AsyncGenerator<T, Cursor>): Promise<{ items: T[]; cursor: Cursor }> {
  const items: T[] = [];
  let step = await gen.next();
  while (!step.done) {
    items.push(step.value);
    step = await gen.next();
  }
  return { items, cursor: step.value };
}

describe('Claude Code 适配器：一行拆成多个事件', () => {
  it('纯文本行 → 1 个事件', () => {
    const events = parseClaudeLine(LINES.userText, {
      rawPath: '/x/a.jsonl',
      sessionId: 's1',
      fallbackTs: T0,
      agent: 'claude-code',
      pending: new Map(),
    });
    expect(events).toHaveLength(1);
    expect(events?.[0]?.text).toBe('帮我看看 node 版本');
    expect(events?.[0]?.rawHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('text + tool_use 在同一行 → 2 个事件', () => {
    const events = parseClaudeLine(LINES.assistant, {
      rawPath: '/x/a.jsonl',
      sessionId: 's1',
      fallbackTs: T0,
      agent: 'claude-code',
      pending: new Map(),
    });
    expect(events).toHaveLength(2);
    expect(events?.[0]?.text).toBe('我查一下');
    expect(events?.[1]?.tool).toEqual({ name: 'Bash', input: { command: 'node -v' } });
  });

  it('tool_result 跨行配对到 tool_use 的名字与入参', () => {
    const pending = new Map<string, never>();
    const ctx = { rawPath: '/x/a.jsonl', sessionId: 's1', fallbackTs: T0, agent: 'claude-code', pending };
    parseClaudeLine(LINES.assistant, ctx as never);
    const events = parseClaudeLine(LINES.toolResult, ctx as never);
    expect(events).toHaveLength(1);
    expect(events?.[0]?.tool).toEqual({
      name: 'Bash',
      input: { command: 'node -v' },
      output: 'v22.9.0',
      exitCode: 0,
    });
    // 配对后缓冲清空，不会无限增长
    expect(pending.size).toBe(0);
  });

  it('is_error=true 推断退出码 1（平台不给真实退出码）', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: T2,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }],
      },
    });
    const events = parseClaudeLine(line, {
      rawPath: '/x/a.jsonl',
      sessionId: 's1',
      fallbackTs: T0,
      agent: 'claude-code',
      pending: new Map(),
    });
    expect(events?.[0]?.tool?.exitCode).toBe(1);
    expect(events?.[0]?.tool?.output).toBe('boom');
  });
});

describe('防御式解析（§5.2.1 五条）', () => {
  const ctx = () => ({
    rawPath: '/x/a.jsonl',
    sessionId: 's1',
    fallbackTs: '2026-10-31T00:00:00.000Z',
    agent: 'claude-code',
    pending: new Map<string, never>(),
  });

  it('未知 type → 返回 null（调用方计 unknownLines），不抛错', () => {
    const line = JSON.stringify({ type: 'brand_new_event', timestamp: T0, payload: { a: 1 } });
    expect(parseClaudeLine(line, ctx() as never)).toBeNull();
  });

  it('坏 JSON → null', () => {
    expect(parseClaudeLine('{"type":"user",', ctx() as never)).toBeNull();
  });

  it('content 不是数组 → 当作文本', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: '纯文本' } });
    const events = parseClaudeLine(line, ctx() as never);
    expect(events).toHaveLength(1);
    expect(events?.[0]?.text).toBe('纯文本');
  });

  it('缺 timestamp → 用文件 mtime 兜底', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } });
    const events = parseClaudeLine(line, ctx() as never);
    expect(events?.[0]?.ts).toBe('2026-10-31T00:00:00.000Z');
  });

  it('缺 cwd → null；缺 sessionId → 文件名', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } });
    const events = parseClaudeLine(line, ctx() as never);
    expect(events?.[0]?.cwd).toBeNull();
    expect(events?.[0]?.sessionId).toBe('s1');
  });

  it('失败率 > 20% 判为"适配器可能已过期"', () => {
    const s = { ...emptyStats(), lines: 10, parsed: 7, unknownLines: 2, badJson: 1 };
    expect(failureRate(s)).toBeCloseTo(0.3, 5);
    expect(isAdapterStale(s)).toBe(true);
    expect(isAdapterStale({ ...emptyStats(), lines: 10, parsed: 8, unknownLines: 2 })).toBe(false);
    expect(isAdapterStale(emptyStats())).toBe(false);
  });
});

describe('游标：三个边界（§5.2.3）', () => {
  it('半行不消费，游标停在该行开头', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.jsonl');
    // 第二行没有换行符 = 平台正在写
    writeFileSync(file, `${LINES.userText}\n{"type":"user","mess`, 'utf8');
    const { items, cursor } = await drain(readLines(file, null));
    expect(items).toHaveLength(1);
    expect(cursor.offset).toBe(Buffer.byteLength(LINES.userText, 'utf8') + 1);
    expect(cursor.offset).toBeLessThan(statSync(file).size);
  });

  it('文件被截断 → 回到 0 重读', () => {
    const plan = planRead({ offset: 500, size: 1000, inode: 7, lastTs: null }, { size: 40, inode: 7 });
    expect(plan).toEqual({ offset: 0, reason: 'truncated' });
  });

  it('inode 变化（轮转）→ 回到 0 重读，即使新文件更大', () => {
    const plan = planRead({ offset: 500, size: 1000, inode: 7, lastTs: null }, { size: 5000, inode: 9 });
    expect(plan).toEqual({ offset: 0, reason: 'rotated' });
  });

  it('正常续读从 offset 开始', () => {
    const plan = planRead({ offset: 500, size: 1000, inode: 7, lastTs: null }, { size: 1000, inode: 7 });
    expect(plan).toEqual({ offset: 500, reason: 'continue' });
  });

  it('游标 offset 超过文件大小也算截断（防御式）', () => {
    const plan = planRead({ offset: 900, size: 1000, inode: 7, lastTs: null }, { size: 800, inode: 7 });
    expect(plan.reason).toBe('truncated');
  });

  it('文件被删 → stat 返回 null，不抛错', () => {
    expect(statOrNull(path.join(tempDir(), 'nope.jsonl'))).toBeNull();
  });
});

describe('splitCompleteLines', () => {
  it('只消费到最后一个换行符', () => {
    const buf = Buffer.from('a\nb\nc', 'utf8');
    const r = splitCompleteLines(buf);
    expect(r.lines).toEqual(['a', 'b']);
    expect(r.consumed).toBe(4);
    expect(r.hasPartial).toBe(true);
  });

  it('没有换行符 → 一行都不消费', () => {
    const r = splitCompleteLines(Buffer.from('abc', 'utf8'));
    expect(r.lines).toEqual([]);
    expect(r.consumed).toBe(0);
  });

  it('多字节字符被切断时不会解码成乱码（按字节找 \\n）', () => {
    const full = Buffer.from('中文\n', 'utf8');
    // 故意只给前半截（切在汉字中间）
    const cut = full.subarray(0, 4);
    const r = splitCompleteLines(cut);
    expect(r.lines).toEqual([]);
    expect(r.consumed).toBe(0);
  });

  it('空行被过滤，不产生空事件', () => {
    const r = splitCompleteLines(Buffer.from('a\n\n\nb\n', 'utf8'));
    expect(r.lines).toEqual(['a', 'b']);
  });
});

describe('CursorStore', () => {
  it('保存后能读回，格式是 { source: { path: cursor } }', () => {
    const file = path.join(tempDir(), 'cursors.json');
    const store = new CursorStore(file);
    store.set('claude-code', '/x/a.jsonl', { offset: 10, lastTs: T1, size: 20, inode: 3 });
    store.save();

    const again = CursorStore.load(file);
    expect(again.get('claude-code', '/x/a.jsonl')).toEqual({
      offset: 10,
      lastTs: T1,
      size: 20,
      inode: 3,
    });
    expect(JSON.parse(JSON.stringify(again.toJSON()))).toEqual({
      'claude-code': { '/x/a.jsonl': { offset: 10, lastTs: T1, size: 20, inode: 3 } },
    });
  });

  it('文件不存在 → 空游标，不报错', () => {
    expect(CursorStore.load(path.join(tempDir(), 'nope.json')).toJSON()).toEqual({});
  });

  it('文件损坏 → 空游标 + 回调，不抛错（否则 daemon 起不来）', () => {
    const file = path.join(tempDir(), 'cursors.json');
    writeFileSync(file, '{ 这不是 json', 'utf8');
    let reason = '';
    const store = CursorStore.load(file, (r) => {
      reason = r;
    });
    expect(store.toJSON()).toEqual({});
    expect(reason).not.toBe('');
  });

  it('drop 删到空时把来源整条去掉（游标文件不会无限膨胀）', () => {
    const store = new CursorStore(path.join(tempDir(), 'c.json'));
    store.set('claude-code', '/x/a.jsonl', { offset: 1, lastTs: null, size: 1, inode: 1 });
    expect(store.drop('claude-code', '/x/a.jsonl')).toBe(true);
    expect(store.toJSON()).toEqual({});
    expect(store.drop('claude-code', '/x/a.jsonl')).toBe(false);
  });
});

describe('端到端：适配器 → 解析器', () => {
  it('会话文件里的 node -v 最终变成一条 runtime_version 事实', async () => {
    const root = tempDir();
    const projDir = path.join(root, '-home-u-proj');
    writeSession(projDir, 's1.jsonl', [LINES.userText, LINES.assistant, LINES.toolResult]);

    const adapter = new ClaudeCodeAdapter({ root });
    expect(await adapter.detect()).toEqual({ found: true, root });

    const sessions: string[] = [];
    for await (const ref of adapter.listSessions('1970-01-01T00:00:00.000Z')) {
      sessions.push(ref.path);
      const { items, cursor } = await drain(adapter.readEpisode(ref, null));
      expect(items.length).toBeGreaterThanOrEqual(4);
      expect(cursor.offset).toBe(statSync(ref.path).size);

      const turns = toToolTurns(items);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        tool: 'bash',
        cmd: 'node -v',
        output: 'v22.9.0',
        exitCode: 0,
        cwd: '/home/u/proj',
      });

      const parsed = parseTurn(turns[0]!);
      expect(parsed.produced).toEqual(['ver.node']);
      expect(parsed.facts[0]?.value).toBe('22.9.0');
    }
    expect(sessions).toHaveLength(1);
  });

  it('续读：第二次只读新增部分', async () => {
    const root = tempDir();
    const projDir = path.join(root, 'p');
    const file = writeSession(projDir, 's1.jsonl', [LINES.userText]);
    const adapter = new ClaudeCodeAdapter({ root });
    const ref = { source: 'claude-code', path: file, sessionId: 's1', size: 0, mtimeMs: 0 };

    const first = await drain(adapter.readEpisode(ref, null));
    expect(first.items).toHaveLength(1);

    writeFileSync(file, `${LINES.userText}\n${LINES.assistant}\n`, 'utf8');
    const second = await drain(adapter.readEpisode(ref, first.cursor));
    expect(second.items).toHaveLength(2);
    expect(second.items.some((e) => e.tool !== undefined)).toBe(true);
  });

  it('since 过滤掉旧文件', async () => {
    const root = tempDir();
    const projDir = path.join(root, 'p');
    writeSession(projDir, 'old.jsonl', [LINES.userText]);
    const adapter = new ClaudeCodeAdapter({ root });
    const found: string[] = [];
    for await (const ref of adapter.listSessions('2999-01-01T00:00:00.000Z')) found.push(ref.path);
    expect(found).toEqual([]);
  });

  it('根目录不存在 → detect 返回 found:false 且列表为空', async () => {
    const adapter = new ClaudeCodeAdapter({ root: path.join(tempDir(), 'nope') });
    expect((await adapter.detect()).found).toBe(false);
    const found: string[] = [];
    for await (const ref of adapter.listSessions('1970-01-01T00:00:00.000Z')) found.push(ref.path);
    expect(found).toEqual([]);
  });
});

describe('通用 JSONL 适配器', () => {
  it('默认字段名可直接用', async () => {
    const root = tempDir();
    const file = path.join(root, 'ss_1.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({
        ts: T1,
        role: 'assistant',
        session_id: 'ss_1',
        cwd: '/w',
        tool: { name: 'Bash', input: { command: 'node -v' }, output: 'v22.9.0', exit_code: 0 },
      })}\n`,
      'utf8',
    );
    const adapter = new GenericJsonlAdapter({ root });
    const ref = { source: 'generic-jsonl', path: file, sessionId: 'ss_1', size: 0, mtimeMs: 0 };
    const { items } = await drain(adapter.readEpisode(ref, null));
    expect(toToolTurns(items)).toEqual([
      expect.objectContaining({ tool: 'bash', cmd: 'node -v', output: 'v22.9.0', exitCode: 0 }),
    ]);
  });

  it('field_map 换成别家的字段名也能读', async () => {
    const root = tempDir();
    const file = path.join(root, 'other.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({
        timestamp: T1,
        sessionId: 'other',
        workdir: '/w',
        command: { tool_name: 'Bash', args: { command: 'node -v' }, result: 'v22.9.0', code: 0 },
      })}\n`,
      'utf8',
    );
    const adapter = new GenericJsonlAdapter({
      root,
      fieldMap: {
        ts: 'timestamp',
        session_id: 'sessionId',
        cwd: 'workdir',
        tool: 'command',
        tool_name: 'tool_name',
        tool_input: 'args',
        tool_output: 'result',
        tool_exit_code: 'code',
      },
    });
    const ref = { source: 'generic-jsonl', path: file, sessionId: 'other', size: 0, mtimeMs: 0 };
    const { items } = await drain(adapter.readEpisode(ref, null));
    expect(items[0]?.ts).toBe(T1);
    expect(items[0]?.cwd).toBe('/w');
    expect(items[0]?.tool?.output).toBe('v22.9.0');
  });

  it('既没文本也没工具的行 → 计 skipped，不产生事件', async () => {
    const root = tempDir();
    const file = path.join(root, 'empty.jsonl');
    writeFileSync(file, `${JSON.stringify({ ts: T1, role: 'user' })}\n`, 'utf8');
    const adapter = new GenericJsonlAdapter({ root });
    const ref = { source: 'generic-jsonl', path: file, sessionId: 'empty', size: 0, mtimeMs: 0 };
    const { items } = await drain(adapter.readEpisode(ref, null));
    expect(items).toEqual([]);
  });
});

describe('工具名归一', () => {
  it('各种 shell 叫法都折成 bash', () => {
    for (const n of ['Bash', 'shell', 'run_command', 'execute_command', 'pwsh', 'ZSH']) {
      expect(canonicalToolName(n)).toBe('bash');
    }
    expect(canonicalToolName('Read')).toBe('read');
  });
});

describe('probe-source（doctor）', () => {
  it('dump 前 3 行字段形状，且不泄漏正文', () => {
    const root = tempDir();
    const file = writeSession(root, 's1.jsonl', [LINES.userText, LINES.assistant, LINES.toolResult]);
    const shapes = probeJsonlShape(file, 3);
    expect(shapes).toHaveLength(3);
    expect(shapes[0]?.shape).toContain('type=user');
    expect(shapes[0]?.shape).toContain('message.keys=');
    expect(shapes[1]?.shape).toContain('content[1]=tool_use');
    const joined = shapes.map((s) => s.shape).join('\n');
    expect(joined).not.toContain('帮我看看');
    expect(joined).not.toContain('v22.9.0');
  });

  it('坏行给出 error 而不是抛错', () => {
    const root = tempDir();
    const file = path.join(root, 'bad.jsonl');
    writeFileSync(file, 'not json\n{"type":"user"}\n', 'utf8');
    const shapes = probeJsonlShape(file, 3);
    expect(shapes[0]?.error).toBeTruthy();
    expect(shapes[1]?.shape).toContain('type=user');
  });

  it('文件不存在 → 空数组', () => {
    expect(probeJsonlShape(path.join(tempDir(), 'nope.jsonl'))).toEqual([]);
  });
});

describe('createSource', () => {
  it('认识的名字给出适配器，不认识的返回 null（不抛错）', () => {
    expect(createSource('claude-code', { home: '/tmp/h' })?.name).toBe('claude-code');
    expect(createSource('generic-jsonl', { genericRoot: '/tmp/inbox' })?.name).toBe('generic-jsonl');
    expect(createSource('generic-jsonl')).toBeNull(); // 没给 root
    expect(createSource('nope')).toBeNull();
  });
});

describe('事件 → 工具回合', () => {
  it('没有输出的 tool_use 不算回合（还在跑）', () => {
    const events: RawEvent[] = [
      {
        ts: T1,
        sessionId: 's',
        cwd: null,
        agent: 'x',
        rawHash: 'h',
        rawPath: 'p',
        role: 'assistant',
        tool: { name: 'Bash', input: { command: 'sleep 10' } },
      },
    ];
    expect(toToolTurns(events)).toEqual([]);
  });

  it('入参里没有 command 的工具被跳过', () => {
    const events: RawEvent[] = [
      {
        ts: T1,
        sessionId: 's',
        cwd: null,
        agent: 'x',
        rawHash: 'h',
        rawPath: 'p',
        role: 'tool',
        tool: { name: 'Read', input: { file_path: '/a' }, output: 'x', exitCode: 0 },
      },
    ];
    expect(toToolTurns(events)).toEqual([]);
  });
});
