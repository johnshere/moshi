/**
 * Claude Code 适配器（详设 §5.2.1）。
 *
 * 根目录 `~/.claude/projects/<转义后的 cwd>/<session-id>.jsonl`，一行一个事件。
 * **不反解目录名**（`/` → `-` 是有损转义，`-Users-x-my-proj` 到底是
 * `/Users/x/my/proj` 还是 `/Users/x/my-proj` 无法区分），cwd 一律从行内 `cwd` 字段取。
 *
 * 防御式解析五条（§5.2.1）全部落实：
 * 1. 只读登记的字段，其余忽略；
 * 2. `type` 不认识 → 跳过并计数 `unknownLines`；
 * 3. `content` 不是数组 → 当作文本；
 * 4. 字段缺失 → 默认值（`ts` 用文件 mtime，`cwd` 用 null）；
 * 5. 失败率 > 20% → `isAdapterStale()` 为真，调用方写 warn 并在 `/api/diag` 显示。
 *
 * 工具结果配对：`tool_use.id` ↔ `tool_result.tool_use_id`。配对**跨行**，
 * 所以要留一个缓冲；上限 50 个未配对 id（超过就丢最老的）——不设上限的话，
 * 一个只有 `tool_use` 没有结果的会话会一直占内存。
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Cursor } from './cursor.js';
import { MAX_CHUNK, readLines, statOrNull } from './cursor.js';
import type {
  DetectResult,
  RawEvent,
  ReadStats,
  SessionRef,
  SessionSource,
  ToolCall,
} from './session-source.js';
import { emptyStats, laterIso } from './session-source.js';

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const MAX_PENDING_TOOL_USES = 50;
/** 认得的顶层 `type`；其余一律计 unknownLines */
const KNOWN_TYPES = new Set(['user', 'assistant', 'system', 'summary', 'tool']);

export interface ClaudeCodeOptions {
  root?: string;
  /** 读文件时的单次上限，测试用小值触发多次读 */
  maxChunk?: number;
}

export interface PendingToolUse {
  name: string;
  input: unknown;
  ts: string;
  sessionId: string;
  cwd: string | null;
  rawHash: string;
  rawPath: string;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * 把一行 JSONL 拆成 0..n 个事件。
 *
 * 一行里可能既有 `text` 又有 `tool_use`（模型边说边做），所以是"拆"不是"转"。
 * 返回 `null` 表示这一行无法识别（`type` 不认识或结构不对），由调用方计数。
 */
export interface ParseContext {
  rawPath: string;
  sessionId: string;
  fallbackTs: string;
  agent: string;
  /** 跨行配对缓冲；由 adapter 实例持有，**不能**放模块级（会串会话） */
  pending: Map<string, PendingToolUse>;
}

export function parseClaudeLine(line: string, ctx: ParseContext): RawEvent[] | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const rec = asRecord(obj);
  if (rec === null) return null;

  const type = asString(rec['type']);
  if (type === null || !KNOWN_TYPES.has(type)) return null;

  const rawHash = sha256(line);
  const ts = asString(rec['timestamp']) ?? ctx.fallbackTs;
  const sessionId = asString(rec['sessionId']) ?? ctx.sessionId;
  const cwd = asString(rec['cwd']);
  const message = asRecord(rec['message']);
  const roleRaw = asString(message?.['role']) ?? type;
  const role: RawEvent['role'] =
    roleRaw === 'assistant' ? 'assistant' : roleRaw === 'tool' ? 'tool' : 'user';

  const base = { ts, sessionId, cwd, agent: ctx.agent, rawHash, rawPath: ctx.rawPath };
  const content = message?.['content'] ?? rec['content'];

  // 规则 3：content 不是数组 → 当作文本
  if (typeof content === 'string') {
    return content === '' ? [] : [{ ...base, role, text: content }];
  }
  if (!Array.isArray(content)) {
    // 没有 content 但有 tool_result 字段的变体，兜一层
    const out: RawEvent[] = [];
    const toolUse = asRecord(rec['toolUse']);
    if (toolUse !== null) {
      out.push({ ...base, role, tool: toToolCall(toolUse) });
    }
    return out;
  }

  const events: RawEvent[] = [];
  for (const blockRaw of content) {
    const block = asRecord(blockRaw);
    if (block === null) continue;
    const kind = asString(block['type']);
    if (kind === 'text') {
      const text = asString(block['text']) ?? '';
      if (text !== '') events.push({ ...base, role, text });
    } else if (kind === 'tool_use') {
      events.push({
        ...base,
        role,
        tool: {
          name: asString(block['name']) ?? '',
          input: block['input'] ?? null,
        },
      });
      // 记住 id，供后面的 tool_result 配对
      const id = asString(block['id']);
      if (id !== null) {
        if (ctx.pending.size >= MAX_PENDING_TOOL_USES) {
          // 丢最老的：只有 tool_use 没有结果的会话不该无限占内存
          const oldest = ctx.pending.keys().next();
          if (!oldest.done) ctx.pending.delete(oldest.value);
        }
        ctx.pending.set(id, {
          name: asString(block['name']) ?? '',
          input: block['input'] ?? null,
          ts,
          sessionId,
          cwd,
          rawHash,
          rawPath: ctx.rawPath,
        });
      }
    } else if (kind === 'tool_result') {
      const id = asString(block['tool_use_id']);
      const output = flattenToolResult(block['content']);
      const exitCode = block['is_error'] === true ? 1 : 0;
      const paired = id === null ? undefined : ctx.pending.get(id);
      if (id !== null) ctx.pending.delete(id);
      events.push({
        ...base,
        role: 'tool',
        tool: {
          name: paired?.name ?? '',
          input: paired?.input ?? null,
          output,
          exitCode,
        },
      });
    }
    // 其余 block 类型（image / thinking ...）忽略：解析器用不上
  }
  return events;
}

/**
 * `tool_result.content` 可能是字符串，也可能是 `[{type:'text',text}]` 数组。
 * 数组里除 text 之外还有 image 之类，统一跳过——把 base64 塞进 output 会让
 * 下游正则跑在几 MB 的无意义字符串上。
 */
export function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const rec = asRecord(item);
      if (rec === null) continue;
      if (asString(rec['type']) === 'text') parts.push(asString(rec['text']) ?? '');
    }
    return parts.join('\n');
  }
  return '';
}

function toToolCall(rec: Record<string, unknown>): ToolCall {
  return {
    name: asString(rec['name']) ?? '',
    input: rec['input'] ?? null,
    output: typeof rec['output'] === 'string' ? rec['output'] : '',
  };
}

export class ClaudeCodeAdapter implements SessionSource {
  readonly name = 'claude-code';
  private readonly root: string;
  private readonly maxChunk: number;
  private stats: ReadStats = emptyStats();

  constructor(opts: ClaudeCodeOptions = {}) {
    this.root = opts.root ?? DEFAULT_ROOT;
    this.maxChunk = opts.maxChunk ?? MAX_CHUNK;
  }

  async detect(): Promise<DetectResult> {
    try {
      const s = statSync(this.root);
      return { found: s.isDirectory(), root: this.root };
    } catch {
      return { found: false, root: this.root };
    }
  }

  /** 最近一次 `readEpisode` 的统计（调用方据此判断"适配器可能已过期"） */
  lastStats(): ReadStats {
    return this.stats;
  }

  async *listSessions(since: string): AsyncIterable<SessionRef> {
    const sinceMs = Date.parse(since);
    let projects: string[];
    try {
      projects = readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(this.root, d.name));
    } catch {
      return; // 根目录不存在：没有会话，不是错误
    }
    for (const dir of projects) {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const full = path.join(dir, f);
        let size: number;
        let mtimeMs: number;
        try {
          const st = statSync(full);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
        if (Number.isFinite(sinceMs) && mtimeMs < sinceMs) continue;
        yield {
          source: this.name,
          path: full,
          sessionId: f.replace(/\.jsonl$/, ''),
          size,
          mtimeMs,
        };
      }
    }
  }

  async *readEpisode(ref: SessionRef, cursor: Cursor | null): AsyncGenerator<RawEvent, Cursor> {
    this.stats = emptyStats();
    const pending = new Map<string, PendingToolUse>();
    const stream = readLines(ref.path, cursor, this.maxChunk);
    let lastTs: string | null = null;
    let fallbackTs = new Date().toISOString();

    // 先拿一次 mtime 做 ts 兜底：readLines 内部会 stat，但那是它的事
    const st = statOrNull(ref.path);
    if (st !== null) fallbackTs = new Date(st.mtimeMs).toISOString();

    let step = await stream.next();
    while (!step.done) {
      const line = step.value;
      this.stats.lines += 1;
      const events = parseClaudeLine(line, {
        rawPath: ref.path,
        sessionId: ref.sessionId,
        fallbackTs,
        agent: this.name,
        pending,
      });
      if (events === null) {
        // 区分"坏 JSON"与"不认识的行"：前者说明文件坏了，后者说明平台改版了
        if (line.trim().startsWith('{')) this.stats.badJson += 1;
        else this.stats.unknownLines += 1;
      } else if (events.length === 0) {
        this.stats.skipped += 1;
      } else {
        this.stats.parsed += 1;
        for (const e of events) {
          lastTs = laterIso(lastTs, e.ts);
          yield e;
        }
      }
      step = await stream.next();
    }

    const next = step.value;
    return { ...next, lastTs: lastTs ?? next.lastTs };
  }
}
