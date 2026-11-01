/**
 * 会话适配层的公共契约（详设 §5.2）。
 *
 * 这一层唯一的存在理由：**平台格式没有文档**。Claude Code 的 JSONL 是内部格式，
 * 随时可能改版；所以适配器必须"只读认识的字段、其余全部忽略"，
 * 并且在解析失败率超过 20% 时告警——那是"平台改版了"的唯一早期信号。
 *
 * 与文档的一处命名偏差：文档把适配器产出的事件也叫 `RawTurn`，但 `parse/types.ts`
 * 里已经有 `RawTurn`（工具名 + 命令 + 输出）。两个同名不同形状的类型在同一个
 * 代码库里必然出事，所以这里叫 `RawEvent`（对话事件），解析器吃的那个叫 `RawTurn`
 * （工具回合）。`toToolTurns()` 负责把前者变成后者。
 */
import { closeSync, openSync, readSync } from 'node:fs';
import type { Cursor } from './cursor.js';
import { splitCompleteLines, statOrNull } from './cursor.js';
import type { RawTurn } from '../parse/types.js';

export type EventRole = 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** 工具名，如 `Bash`；工具结果事件在配对前为空串 */
  name: string;
  input: unknown;
  output?: string;
  /** 平台通常不提供真实退出码，适配器按 `is_error` 推断；推断不出来就 null */
  exitCode?: number | null;
}

export interface RawEvent {
  /** ISO8601；缺失时用文件 mtime（§5.2.1 防御式解析第 4 条） */
  ts: string;
  sessionId: string;
  cwd: string | null;
  /** 适配器名，落 `episode.agent` */
  agent: string;
  /** `sha256(原始行)`，落 `episode.raw_hash`，跨游标重读时靠它去重 */
  rawHash: string;
  /** 原始文件路径，落 `episode.raw_path` */
  rawPath: string;
  role: EventRole;
  text?: string;
  tool?: ToolCall;
}

export interface SessionRef {
  /** 来源名（适配器名） */
  source: string;
  /** 会话文件绝对路径 */
  path: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
}

export type { Cursor };

export interface DetectResult {
  found: boolean;
  root: string;
}

/**
 * `readEpisode` 返回 **AsyncGenerator** 而不是 AsyncIterable，是刻意的：
 * generator 的 `return` 值用来传"下一段游标"。调用方必须手动驱动
 * （`next()` 循环），这样它能在**写完 episode 之后**才把游标落盘——
 * 顺序反了会在崩溃时丢数据（§5.2.3 最后一句）。
 */
export interface SessionSource {
  readonly name: string;
  detect(): Promise<DetectResult>;
  listSessions(since: string): AsyncIterable<SessionRef>;
  readEpisode(ref: SessionRef, cursor: Cursor | null): AsyncGenerator<RawEvent, Cursor, void>;
}

/** 适配器自报的健康度：解析失败率过高说明平台格式变了 */
export interface ReadStats {
  lines: number;
  parsed: number;
  unknownLines: number;
  badJson: number;
  skipped: number;
}

export function emptyStats(): ReadStats {
  return { lines: 0, parsed: 0, unknownLines: 0, badJson: 0, skipped: 0 };
}

/** 取较晚的 ISO 时间戳。写成函数而不是内联三元，是因为内联时 TS 会把
 *  `lastTs` 的控制流类型收窄成 `null`，右侧比较会报 "never" */
export function laterIso(a: string | null, b: string): string {
  return a === null || b > a ? b : a;
}

/** 解析失败率（坏 JSON + 不认识的行）/ 总行数 */
export function failureRate(s: ReadStats): number {
  if (s.lines === 0) return 0;
  return (s.badJson + s.unknownLines) / s.lines;
}

/** §5.2.1 第 5 条：> 20% 写 warn 并标"适配器可能已过期" */
export const ADAPTER_STALE_THRESHOLD = 0.2;

export function isAdapterStale(s: ReadStats): boolean {
  return failureRate(s) > ADAPTER_STALE_THRESHOLD;
}

/**
 * 把对话事件变成解析器能吃的"工具回合"。
 *
 * 只保留**有工具调用且有输出**的事件：没有输出的 tool_use 还在跑，
 * 拿它去解析会得到"命令执行了但什么都没抽到"的假阴性。
 */
export interface ToolTurn extends RawTurn {
  ts: string;
  sessionId: string;
  rawHash: string;
}

export function toToolTurns(events: Iterable<RawEvent>): ToolTurn[] {
  const out: ToolTurn[] = [];
  for (const e of events) {
    if (e.tool === undefined) continue;
    if (e.tool.output === undefined) continue;
    const input = e.tool.input;
    const cmd = extractCommand(input);
    if (cmd === '') continue;
    out.push({
      tool: canonicalToolName(e.tool.name === '' ? 'unknown' : e.tool.name),
      cmd,
      output: e.tool.output,
      exitCode: e.tool.exitCode ?? null,
      ...(e.cwd === null ? {} : { cwd: e.cwd }),
      ts: e.ts,
      sessionId: e.sessionId,
      rawHash: e.rawHash,
    });
  }
  return out;
}

/** 从工具入参里取命令：`Bash` 用 `command`，别的工具用 JSON 形式（解析器多半不认） */
export function extractCommand(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === null || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return '';
}

/**
 * 工具名归一。不同平台的叫法五花八门（`Bash` / `shell` / `run_command` /
 * `execute_command`），但解析器只认一类东西：**能跑命令的 shell**。
 * 这里把它们统一折成 `bash`，让 parser 的 `tools` 列表保持短小。
 * 不认识的工具名原样小写返回——解析器自然不会匹配它，符合"未识别就不入图"。
 */
const SHELL_ALIASES = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'exec',
  'terminal',
  'run_command',
  'execute_command',
  'run_shell_command',
  'powershell',
  'pwsh',
]);

export function canonicalToolName(name: string): string {
  const n = name.trim().toLowerCase();
  if (SHELL_ALIASES.has(n)) return 'bash';
  return n;
}

// ---------------------------------------------------------------- 探测

/**
 * `moshi doctor --probe-source`（§5.2.1 最后一段）：dump 前 N 行的**字段形状**。
 *
 * 只打形状不打内容：会话内容可能含密钥与个人信息，doctor 的输出经常被贴到
 * issue 里。形状足够回答"平台是不是改字段名了"这个问题。
 */
export interface ShapeLine {
  index: number;
  bytes: number;
  /** 例如 `type=assistant | keys=timestamp,sessionId,cwd,message | content[0]=tool_use(name,input,id)` */
  shape: string;
  /** 坏 JSON / 顶层不是对象 */
  error?: string;
}

function describeKeys(obj: Record<string, unknown>): string {
  return Object.keys(obj).sort().join(',');
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function describeShape(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  const type = obj['type'];
  if (typeof type === 'string') parts.push(`type=${type}`);
  parts.push(`keys=${describeKeys(obj)}`);

  const message = obj['message'];
  if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
    const m = message as Record<string, unknown>;
    parts.push(`message.keys=${describeKeys(m)}`);
    const content = m['content'];
    if (Array.isArray(content)) {
      content.slice(0, 3).forEach((block, i) => {
        if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
          const b = block as Record<string, unknown>;
          const bt = typeof b['type'] === 'string' ? String(b['type']) : '?';
          parts.push(`content[${String(i)}]=${bt}(${describeKeys(b)})`);
        } else {
          parts.push(`content[${String(i)}]=${typeOf(block)}`);
        }
      });
    } else {
      parts.push(`content=${typeOf(content)}`);
    }
  }
  const tool = obj['tool'];
  if (tool !== null && typeof tool === 'object' && !Array.isArray(tool)) {
    parts.push(`tool.keys=${describeKeys(tool as Record<string, unknown>)}`);
  }
  return parts.join(' | ');
}

/** 读文件前 N 个完整行并给出形状；读不到返回空数组（doctor 不因探测失败而失败） */
export function probeJsonlShape(file: string, count = 3): ShapeLine[] {
  const st = statOrNull(file);
  if (st === null) return [];
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, 0);
    const split = splitCompleteLines(buf.subarray(0, read));
    return split.lines.slice(0, count).map((line, index) => {
      const bytes = Buffer.byteLength(line, 'utf8');
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { index, bytes, shape: '', error: '顶层不是对象' };
        }
        return { index, bytes, shape: describeShape(parsed as Record<string, unknown>) };
      } catch (err) {
        return { index, bytes, shape: '', error: (err as Error).message };
      }
    });
  } finally {
    closeSync(fd);
  }
}
