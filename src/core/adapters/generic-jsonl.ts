/**
 * 通用 JSONL 适配器（详设 §5.2.2）。
 *
 * 给"不是 Claude Code"的 Agent 用。最小约定：
 *
 * ```json
 * {"ts":"...","role":"assistant","text":"...",
 *  "tool":{"name":"Bash","input":{"command":"node -v"},"output":"v22.9.0","exit_code":0},
 *  "session_id":"ss_x","cwd":"/home/u/proj"}
 * ```
 *
 * **字段名可配**（`[ingest] field_map`）：别家 Agent 的字段叫 `timestamp` /
 * `sessionId` / `exitCode` 的都有，硬编码字段名等于要求别人改自己的日志格式。
 * 只映射这 9 个名字，其余字段一律忽略——和 Claude Code 适配器同一条防御式纪律。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Cursor } from './cursor.js';
import { MAX_CHUNK, readLines, statOrNull } from './cursor.js';
import type {
  DetectResult,
  EventRole,
  RawEvent,
  ReadStats,
  SessionRef,
  SessionSource,
  ToolCall,
} from './session-source.js';
import { emptyStats, laterIso } from './session-source.js';
import { sha256 } from './claude-code.js';

/** `[ingest] field_map` 的形状：左边是内部名，右边是对方 JSON 里的键名 */
export interface FieldMap {
  ts: string;
  role: string;
  text: string;
  tool: string;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  tool_exit_code: string;
  session_id: string;
  cwd: string;
}

export const DEFAULT_FIELD_MAP: FieldMap = {
  ts: 'ts',
  role: 'role',
  text: 'text',
  tool: 'tool',
  tool_name: 'name',
  tool_input: 'input',
  tool_output: 'output',
  tool_exit_code: 'exit_code',
  session_id: 'session_id',
  cwd: 'cwd',
};

export interface GenericJsonlOptions {
  /** 目录；下面的 `*.jsonl` 一个文件一个会话 */
  root: string;
  fieldMap?: Partial<FieldMap>;
  maxChunk?: number;
}

const KNOWN_ROLES = new Set(['user', 'assistant', 'tool']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export class GenericJsonlAdapter implements SessionSource {
  readonly name = 'generic-jsonl';
  private readonly root: string;
  private readonly map: FieldMap;
  private readonly maxChunk: number;
  private stats: ReadStats = emptyStats();

  constructor(opts: GenericJsonlOptions) {
    this.root = opts.root;
    this.map = { ...DEFAULT_FIELD_MAP, ...opts.fieldMap };
    this.maxChunk = opts.maxChunk ?? MAX_CHUNK;
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
    let files: string[];
    try {
      files = readdirSync(this.root).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }
    for (const f of files) {
      const full = path.join(this.root, f);
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

  /**
   * 一行 → 一个事件。通用格式里工具调用与输出在**同一条记录**里，
   * 所以不需要 Claude Code 那套跨行配对缓冲。
   */
  parseLine(line: string, ctx: { rawPath: string; sessionId: string; fallbackTs: string }): RawEvent | null {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    const rec = asRecord(obj);
    if (rec === null) return null;

    const roleRaw = asString(rec[this.map.role]);
    const role: EventRole =
      roleRaw !== null && KNOWN_ROLES.has(roleRaw) ? (roleRaw as EventRole) : 'user';

    const toolRec = asRecord(rec[this.map.tool]);
    let tool: ToolCall | undefined;
    if (toolRec !== null) {
      const output = toolRec[this.map.tool_output];
      const exit = toolRec[this.map.tool_exit_code];
      tool = {
        name: asString(toolRec[this.map.tool_name]) ?? '',
        input: toolRec[this.map.tool_input] ?? null,
        ...(typeof output === 'string' ? { output } : {}),
        ...(typeof exit === 'number' ? { exitCode: exit } : {}),
      };
    }

    const text = asString(rec[this.map.text]);
    if (tool === undefined && (text === null || text === '')) return null;

    return {
      ts: asString(rec[this.map.ts]) ?? ctx.fallbackTs,
      sessionId: asString(rec[this.map.session_id]) ?? ctx.sessionId,
      cwd: asString(rec[this.map.cwd]),
      agent: this.name,
      rawHash: sha256(line),
      rawPath: ctx.rawPath,
      role,
      ...(text === null ? {} : { text }),
      ...(tool === undefined ? {} : { tool }),
    };
  }

  async *readEpisode(ref: SessionRef, cursor: Cursor | null): AsyncGenerator<RawEvent, Cursor> {
    this.stats = emptyStats();
    const st = statOrNull(ref.path);
    const fallbackTs = st === null ? new Date().toISOString() : new Date(st.mtimeMs).toISOString();
    const stream = readLines(ref.path, cursor, this.maxChunk);
    let lastTs: string | null = null;

    let step = await stream.next();
    while (!step.done) {
      this.stats.lines += 1;
      const e = this.parseLine(step.value, {
        rawPath: ref.path,
        sessionId: ref.sessionId,
        fallbackTs,
      });
      if (e === null) {
        if (step.value.trim().startsWith('{')) this.stats.badJson += 1;
        else this.stats.unknownLines += 1;
      } else {
        this.stats.parsed += 1;
        lastTs = laterIso(lastTs, e.ts);
        yield e;
      }
      step = await stream.next();
    }

    const next = step.value;
    return { ...next, lastTs: lastTs ?? next.lastTs };
  }
}
