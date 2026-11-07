/**
 * DeepSeek Harness（DSh）适配器。
 *
 * 根目录 `~/.dsh/sessions/<转义后的 cwd>/<session-id>/session.v4.jsonl.zstd`。
 * 每个会话是**追加写的多帧 zstd**：每次落盘写一个独立帧。Node 的
 * `zstdDecompressSync` 只解第一帧，所以这里先扫帧边界（`zstdFrameLength`），
 * 再逐帧解压。游标 offset 记在**压缩字节**上，天然对齐帧边界。
 *
 * 事件映射（只取对话内容，控制事件一律跳过）：
 *
 * | DSh 事件 | 产出 |
 * |---|---|
 * | `session` | 无事件；取 `cwd` 供后续事件使用 |
 * | `user/message` | 仅 `source.kind === 'user'`，文本块 |
 * | `assistant/message` | 文本块（`tool-call` 块交给 `tool/call`，避免重复） |
 * | `tool/call` | 工具调用（无输出），进配对缓冲 |
 * | `tool/result` | 工具结果，按 `callId` 取回名字与入参 |
 *
 * 其余事件（`step/*`、`reasoning-chunks`、`job/*`、`approval/*` …）是运行时
 * 控制流，不是用户可见的对话，计入 `skipped` 而不是 `unknownLines`——否则
 * 失败率会长期高于 20%，把"适配器过期"这个信号淹掉。
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { Cursor } from './cursor.js';
import { planRead, statOrNull } from './cursor.js';
import type {
  DetectResult,
  RawEvent,
  ReadStats,
  SessionRef,
  SessionSource,
  ToolCall,
} from './session-source.js';
import { emptyStats, laterIso } from './session-source.js';

const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const MAX_PENDING_CALLS = 50;

/** 产出对话事件的事件类型 */
const HANDLED_TYPES = new Set(['session', 'user/message', 'assistant/message', 'tool/call', 'tool/result']);

/** 已确认的运行时控制事件：跳过但不算解析失败 */
const IGNORED_TYPES = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'system/message',
  'developer/message',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'assistant/chunk',
  'assistant/attempt',
  'reasoning-chunks',
  'tool-call-chunks',
  'text-chunks',
  'web/deepseek-search-llm-request',
  'deliverables/presented',
  'session/end-seed',
  'session-log-deepseek/delivery-accepted',
  'job/registered',
  'job/settled',
  'workspace/changes',
  'subagent/descriptor',
  'subagent/catalog',
  'subagent/model-selection-policy',
  'approval/asked',
  'approval/decided',
  'command/run',
  'command/done',
  'goal/change',
  'todo/write',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'llm/retry',
  'llm/retry-started',
  'team/member',
  'team/task',
  'model/selection',
]);

export interface DshOptions {
  root?: string;
}

interface PendingCall {
  name: string;
  input: unknown;
}

export interface DshParseContext {
  rawPath: string;
  sessionId: string;
  fallbackTs: string;
  agent: string;
  /** `session` 事件里带到，后续事件共用 */
  cwd: string | null;
  /** callId → 名字与入参；跨行配对 */
  pending: Map<string, PendingCall>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function isoOf(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** 拼接 `content` 数组里的 text 块；非 text 块跳过（image/base64 不进解析器） */
function textOf(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block !== null && asString(block['type']) === 'text') {
      parts.push(asString(block['text']) ?? '');
    }
  }
  return parts.join('\n');
}

/** `tool/result` 的 content 可能是 `[{type:'text'}]`，也可能是纯字符串 */
function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocks = asArray(content);
  return blocks === null ? '' : textOf(blocks);
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * 一行 → 0..n 个事件。返回 `null` 表示这行无法识别（坏 JSON / 未知类型），
 * 返回 `[]` 表示认得但不需要（控制事件、非用户注入消息）。
 */
export function parseDshLine(line: string, ctx: DshParseContext): RawEvent[] | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const rec = asRecord(obj);
  if (rec === null) return null;
  const type = asString(rec['type']);
  if (type === null) return null;

  if (IGNORED_TYPES.has(type)) return [];
  if (!HANDLED_TYPES.has(type)) return null;

  const data = asRecord(rec['data']) ?? {};
  const ts = isoOf(rec['time']) ?? ctx.fallbackTs;
  const sessionId = ctx.sessionId;
  const rawHash = createHash('sha256').update(line, 'utf8').digest('hex');
  const base = {
    ts,
    sessionId,
    cwd: ctx.cwd,
    agent: ctx.agent,
    rawHash,
    rawPath: ctx.rawPath,
  };

  if (type === 'session') {
    // session 行的 cwd 在顶层（不在 data 里）
    const cwd = asString(rec['cwd']) ?? asString(data['cwd']);
    if (cwd !== null) ctx.cwd = cwd;
    return [];
  }

  if (type === 'user/message') {
    const source = asRecord(data['source']);
    if (asString(source?.['kind']) !== 'user') return [];
    const blocks = asArray(data['content']) ?? asArray(asRecord(data['message'])?.['content']);
    if (blocks === null) return [];
    const text = textOf(blocks);
    return text === '' ? [] : [{ ...base, role: 'user', text }];
  }

  if (type === 'assistant/message') {
    const message = asRecord(data['message']);
    const blocks = asArray(message?.['content']);
    if (blocks === null) return [];
    const text = textOf(blocks);
    return text === '' ? [] : [{ ...base, role: 'assistant', text }];
  }

  if (type === 'tool/call') {
    const callId = asString(data['callId']);
    const name = asString(data['name']) ?? '';
    const input = parseArguments(data['arguments']);
    if (callId !== null) {
      if (ctx.pending.size >= MAX_PENDING_CALLS) {
        const oldest = ctx.pending.keys().next();
        if (!oldest.done) ctx.pending.delete(oldest.value);
      }
      ctx.pending.set(callId, { name, input });
    }
    const tool: ToolCall = { name, input };
    return [{ ...base, role: 'assistant', tool }];
  }

  // tool/result
  const message = asRecord(data['message']);
  const callId = asString(asRecord(message?.['source'])?.['callId']);
  const paired = callId === null ? undefined : ctx.pending.get(callId);
  if (callId !== null) ctx.pending.delete(callId);

  const blocks = asArray(message?.['content']) ?? [];
  const parts: string[] = [];
  let isError = message?.['error'] !== undefined;
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block === null) continue;
    const kind = asString(block['type']);
    if (kind === 'tool-result') {
      if (block['isError'] === true) isError = true;
      parts.push(flattenResultContent(block['content']));
    } else if (kind === 'text') {
      parts.push(asString(block['text']) ?? '');
    }
  }
  const tool: ToolCall = {
    name: paired?.name ?? '',
    input: paired?.input ?? null,
    output: parts.join('\n'),
    exitCode: isError ? 1 : 0,
  };
  return [{ ...base, role: 'tool', tool }];
}

// ---------------------------------------------------------------- 帧扫描

/** 读小端 uint32（越界由调用方提前判长度） */
function u32(buf: Buffer, pos: number): number {
  return buf.readUInt32LE(pos);
}

/**
 * 一个 zstd 帧的字节长度；数据不足返回 `null`（半帧，调用方停在帧首）。
 * 坏魔法数抛错——那是文件真坏了，不是"还没写完"。
 *
 * 帧格式：magic(4) + frame header + blocks(3 字节头) + [checksum(4)]。
 * 见 RFC 8878 §3.1。跳过帧（0x184D2A5x）按 8 + size 处理。
 */
export function zstdFrameLength(buf: Buffer, pos: number): number | null {
  if (pos + 4 > buf.length) return null;
  const magic = u32(buf, pos);
  if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
    if (pos + 8 > buf.length) return null;
    const end = pos + 8 + u32(buf, pos + 4);
    return end > buf.length ? null : end - pos;
  }
  if (magic !== 0xfd2fb528) {
    throw new Error(`非 zstd 帧（magic=0x${magic.toString(16)}，offset=${String(pos)}）`);
  }

  let p = pos + 4;
  if (p >= buf.length) return null;
  const fhd = buf[p] ?? 0;
  p += 1;
  const singleSegment = (fhd >> 5) & 1;
  const fcsFlag = fhd >> 6;
  const dictFlag = fhd & 3;
  const checksum = (fhd >> 2) & 1;
  if (singleSegment === 0) p += 1; // window descriptor
  p += [0, 1, 2, 4][dictFlag] ?? 0;
  p += fcsFlag === 0 ? singleSegment : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;

  for (;;) {
    if (p + 3 > buf.length) return null;
    const header = (buf[p] ?? 0) | ((buf[p + 1] ?? 0) << 8) | ((buf[p + 2] ?? 0) << 16);
    p += 3;
    const last = header & 1;
    const blockType = (header >> 1) & 3;
    const size = header >> 3;
    p += blockType === 1 ? 1 : size; // RLE 只占 1 字节
    if (p > buf.length) return null;
    if (last === 1) break;
  }
  if (checksum === 1) p += 4;
  return p > buf.length ? null : p - pos;
}

export class DshAdapter implements SessionSource {
  readonly name = 'dsh';
  private readonly root: string;
  private stats: ReadStats = emptyStats();

  constructor(opts: DshOptions = {}) {
    this.root = opts.root ?? DEFAULT_ROOT;
  }

  async detect(): Promise<DetectResult> {
    try {
      return { found: statSync(this.root).isDirectory(), root: this.root };
    } catch {
      return { found: false, root: this.root };
    }
  }

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
      return;
    }
    for (const projectDir of projects) {
      let sessions: string[];
      try {
        sessions = readdirSync(projectDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(projectDir, d.name));
      } catch {
        continue;
      }
      for (const sessionDir of sessions) {
        let files: string[];
        try {
          files = readdirSync(sessionDir).filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f));
        } catch {
          continue;
        }
        for (const f of files) {
          const full = path.join(sessionDir, f);
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
            sessionId: path.basename(sessionDir),
            size,
            mtimeMs,
          };
        }
      }
    }
  }

  async *readEpisode(ref: SessionRef, cursor: Cursor | null): AsyncGenerator<RawEvent, Cursor> {
    this.stats = emptyStats();
    const st = statOrNull(ref.path);
    if (st === null) {
      return { offset: 0, lastTs: cursor?.lastTs ?? null, size: 0, inode: 0 };
    }
    const plan = planRead(cursor, st);
    let offset = plan.offset;
    const remaining = st.size - offset;
    let buf = Buffer.alloc(0);
    if (remaining > 0) {
      buf = Buffer.allocUnsafe(remaining);
      const fd = openSync(ref.path, 'r');
      try {
        const read = readSync(fd, buf, 0, remaining, offset);
        buf = buf.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    }

    const ctx: DshParseContext = {
      rawPath: ref.path,
      sessionId: ref.sessionId,
      fallbackTs: new Date(st.mtimeMs).toISOString(),
      agent: this.name,
      cwd: null,
      pending: new Map(),
    };
    let lastTs: string | null = null;
    let pos = 0;

    while (pos < buf.length) {
      let frameLen: number | null;
      try {
        frameLen = zstdFrameLength(buf, pos);
      } catch {
        this.stats.badJson += 1;
        break;
      }
      if (frameLen === null) break; // 半帧：停在帧首，下次再读
      let text: string;
      try {
        text = zstdDecompressSync(buf.subarray(pos, pos + frameLen)).toString('utf8');
      } catch {
        this.stats.badJson += 1;
        break;
      }
      // 帧内若没有以换行收尾，说明这一行还没写完：不消费该帧
      if (!text.endsWith('\n')) break;

      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        this.stats.lines += 1;
        const events = parseDshLine(line, ctx);
        if (events === null) {
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
      }
      pos += frameLen;
    }

    offset += pos;
    return { offset, lastTs: lastTs ?? cursor?.lastTs ?? null, size: st.size, inode: st.inode };
  }
}
