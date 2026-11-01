/**
 * 游标（详设 §5.2.3）。
 *
 * 游标是"读到哪了"的唯一记录。它必须同时解决三个边界，缺一个就会出错：
 *
 * | 情况 | 判定 | 处理 | 不处理的后果 |
 * |---|---|---|---|
 * | 文件被截断/轮转 | `size < 记录 size` 或 `inode` 变化 | 回到 0 重读 | 永远卡在旧的 offset，新内容读不到 |
 * | 读到半行 | 最后一行无 `\n` | **不消费**，停在该行开头 | 半行 JSON 解析失败，游标跳过它 → 永久丢一行 |
 * | 文件被删 | `stat` 失败 | 删游标条目 | 游标文件无限膨胀 |
 *
 * "半行"这条最容易写错：如果按"读到哪算哪"推进 offset，崩溃恰好发生在写入一半时，
 * 那半行就再也不会被读了。所以 offset 必须停在**最后一个换行符之后**。
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { writeFileAtomic } from '../../infra/fs/atomic.js';
/**
 * 游标（详设 §5.2.3）。
 *
 * 定义放在本文件而不是 `session-source.ts`：`session-source` 要用 `splitCompleteLines`
 * 与 `statOrNull`，而本文件要用 `Cursor`——把类型留在本文件，依赖就只有一个方向。
 * 类型级循环（`import type`）运行时无害，但会让"谁依赖谁"变成一句空话。
 */
export interface Cursor {
  offset: number;
  lastTs: string | null;
  size: number;
  /** Windows 上常为 0；为 0 时只看 size */
  inode: number;
}

/** `{ "<source>": { "<path>": Cursor } }` */
export type CursorFile = Record<string, Record<string, Cursor>>;

export type ReadPlanReason = 'new' | 'continue' | 'truncated' | 'rotated';

export interface ReadPlan {
  offset: number;
  reason: ReadPlanReason;
}

/**
 * 决定从哪读。**顺序有讲究**：先判 inode 再判 size——
 * 轮转后的新文件通常比旧文件大，只看 size 会以为"没变"。
 */
export function planRead(
  cursor: Cursor | null,
  stat: { size: number; inode: number },
): ReadPlan {
  if (cursor === null) return { offset: 0, reason: 'new' };
  if (cursor.inode !== 0 && stat.inode !== 0 && cursor.inode !== stat.inode) {
    return { offset: 0, reason: 'rotated' };
  }
  if (stat.size < cursor.size) return { offset: 0, reason: 'truncated' };
  if (stat.size < cursor.offset) return { offset: 0, reason: 'truncated' };
  return { offset: cursor.offset, reason: 'continue' };
}

export interface LineSplit {
  /** 完整的行（不含换行符），保证每行都是完整 UTF-8 */
  lines: string[];
  /** 实际消费的字节数（到最后一个 `\n` 为止） */
  consumed: number;
  /** 尾部是否残留半行（没被消费） */
  hasPartial: boolean;
}

/**
 * 按换行符切分缓冲区，**只消费到最后一个完整行为止**。
 *
 * 在字节层面找 `\n` 而不是先 `toString()` 再 split：多字节字符的边界
 * 可能落在缓冲区末尾，先解码会把末尾字符变成 U+FFFD，哈希就对不上了。
 * `\n`（0x0A）在 UTF-8 里不会出现在多字节序列中间，所以按字节找是安全的。
 */
export function splitCompleteLines(buf: Buffer): LineSplit {
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { lines: [], consumed: 0, hasPartial: buf.length > 0 };
  }
  const head = buf.subarray(0, lastNewline + 1).toString('utf8');
  const lines = head.split('\n').filter((l) => l.trim() !== '');
  return { lines, consumed: lastNewline + 1, hasPartial: lastNewline + 1 < buf.length };
}

export class CursorStore {
  private data: CursorFile;

  constructor(
    readonly file: string,
    data: CursorFile = {},
  ) {
    this.data = data;
  }

  /**
   * 读游标文件。**损坏时不抛错**，返回空游标并回调 `onCorrupt`：
   * 重建游标的代价只是重读一遍历史（幂等键挡住重复行），而抛错会让 daemon 起不来——
   * 一个能自愈的降级路径比一个"正确但致命"的异常有用。
   */
  static load(file: string, onCorrupt?: (reason: string) => void): CursorStore {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // 不存在 = 全新安装，不是错误
      return new CursorStore(file);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层不是对象');
      }
      return new CursorStore(file, parsed as CursorFile);
    } catch (err) {
      onCorrupt?.((err as Error).message);
      return new CursorStore(file);
    }
  }

  get(source: string, path: string): Cursor | null {
    return this.data[source]?.[path] ?? null;
  }

  set(source: string, path: string, cursor: Cursor): void {
    const bag = this.data[source] ?? {};
    bag[path] = cursor;
    this.data[source] = bag;
  }

  /** 文件被删时调用（§5.2.3 第三行） */
  drop(source: string, path: string): boolean {
    const bag = this.data[source];
    if (bag === undefined || !(path in bag)) return false;
    delete bag[path];
    if (Object.keys(bag).length === 0) delete this.data[source];
    return true;
  }

  /** 某来源下的全部游标（`moshi doctor` 展示用） */
  entries(source: string): { path: string; cursor: Cursor }[] {
    const bag = this.data[source] ?? {};
    return Object.entries(bag).map(([path, cursor]) => ({ path, cursor }));
  }

  toJSON(): CursorFile {
    return this.data;
  }

  save(): void {
    writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 0)}\n`);
  }
}

/** `stat` 失败（文件被删）时返回 null，让调用方走"删条目"分支而不是抛错 */
export function statOrNull(file: string): { size: number; inode: number; mtimeMs: number } | null {
  try {
    const s = statSync(file);
    return { size: s.size, inode: Number(s.ino), mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** 单次读上限：4 MB。再大就该分片了，而分片是 harvest 的事，不是适配器的事 */
export const MAX_CHUNK = 4 * 1024 * 1024;

/**
 * 从 `cursor.offset` 开始逐行读，**只吐完整的行**，返回值是下一段游标。
 *
 * 两个适配器（claude-code / generic-jsonl）的差别只在"一行怎么变成事件"，
 * 而"从哪读到哪、半行怎么办、文件没了怎么办"是同一套逻辑。放在这里
 * 是为了避免两份实现里只有一份修了半行的 bug。
 */
export async function* readLines(
  file: string,
  cursor: Cursor | null,
  maxChunk: number = MAX_CHUNK,
): AsyncGenerator<string, Cursor> {
  const st = statOrNull(file);
  if (st === null) {
    // 文件在列目录与读之间被删了：游标回到"什么都没读"
    return { offset: 0, lastTs: cursor?.lastTs ?? null, size: 0, inode: 0 };
  }

  const plan = planRead(cursor, st);
  let offset = plan.offset;
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    while (offset < st.size) {
      const len = Math.min(maxChunk, st.size - offset);
      const buf = Buffer.allocUnsafe(len);
      const read = readSync(fd, buf, 0, len, offset);
      if (read <= 0) break;
      const split = splitCompleteLines(buf.subarray(0, read));
      for (const line of split.lines) yield line;
      if (split.consumed === 0) break; // 只有半行：停在原地，下次再来
      offset += split.consumed;
      if (split.lines.length === 0) break; // 整段都是空行：已经推进，交给下一次调用
    }
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return { offset, lastTs: cursor?.lastTs ?? null, size: st.size, inode: st.inode };
}
