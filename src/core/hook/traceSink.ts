/**
 * 插件运行日志落盘（Z-01C-e / 设计 §8.4）。
 *
 * 内存里的 ring buffer（`trace.ts`）重启即丢，这里负责把最近几天写进
 * `<data_dir>/hook/trace-YYYY-MM-DD.jsonl`：
 *
 * - **按日轮转**：文件名带日期；同一天超过 `hook_plugin_trace.max_bytes` 再按序号
 *   切 `trace-YYYY-MM-DD.2.jsonl`、`.3`……（只切自己的命名模式，别的一概不碰）；
 * - **保留期清理**：文件名里的日期早于 `hook_plugin_trace.keep_days` 就删掉；
 * - **三档裁剪**：`off` 不落盘；`summary` 去掉全部正文；`full` 原样（调用方负责
 *   落盘前脱敏，见 `src/app/http/routes/hook.ts`）。
 *
 * 写盘是**异步补写**：钩子只有 800ms 预算，日志不能成为召回链路的一部分。
 * 任何写失败都吞掉——日志写不进去不能反过来影响注入。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { safeAppendFile, safeEnsureDir, safeRemoveFile } from '../../infra/fs/safeWrite.js';
import type { HookTraceItem } from './trace.js';

export const TRACE_LEVELS = ['off', 'summary', 'full'] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

/** 只认自己写的文件名：`trace-YYYY-MM-DD.jsonl` 或 `trace-YYYY-MM-DD.<n>.jsonl` */
const TRACE_FILE = /^trace-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

export interface TraceSinkOptions {
  /** 数据目录下的 `hook/` 子目录 */
  dir: string;
  level: TraceLevel;
  /** 单文件字节上限 */
  maxBytes: number;
  /** 保留天数 */
  keepDays: number;
  /** 时钟（测试可注入） */
  now?: () => Date;
}

/**
 * 按档位裁剪一条日志：`off` 返回 null（不落盘）；`summary` 去掉正文；
 * `full` 原样。**哈希与 id 在 summary 档保留**，那是"没有正文也能定位"的锚点。
 */
export function trimTrace(item: HookTraceItem, level: TraceLevel): HookTraceItem | null {
  if (level === 'off') return null;
  if (level === 'full') return item;
  const {
    query_text: _query,
    inject_text: _inject,
    evidence_text: _evidence,
    reply_text: _reply,
    ...rest
  } = item;
  return rest;
}

export class TraceSink {
  private readonly opts: TraceSinkOptions;
  /** 串行化的写链：保证同一进程里的追加顺序与调用顺序一致 */
  private chain: Promise<void> = Promise.resolve();
  /** 当前可追加的文件与已写字节数（进程内缓存，跨进程靠扫描重建） */
  private current: { file: string; bytes: number } | null = null;
  /** 上次清理执行的日期（跨日时再跑一次） */
  private cleanedOn: string | null = null;

  constructor(opts: TraceSinkOptions) {
    this.opts = opts;
  }

  get level(): TraceLevel {
    return this.opts.level;
  }

  /** 运行期改档位（设置页 `PUT /api/config` 改 `hook_plugin_trace.level` 后立即生效） */
  setLevel(level: TraceLevel): void {
    this.opts.level = level;
  }

  /** 等写链落盘（测试/收尾用；召回链路不调它） */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** 追加一条（off 档直接返回；写盘失败静默） */
  append(item: HookTraceItem): void {
    if (this.opts.level === 'off') return;
    const record = trimTrace(item, this.opts.level);
    if (record === null) return;
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      return;
    }
    this.chain = this.chain.then(() => {
      try {
        const now = this.now();
        this.cleanupOnce(now);
        this.writeLine(dateOf(now), line);
      } catch {
        // 见文件头：日志写不进去不影响注入
      }
    });
  }

  /** 清掉超过保留期的日文件；进程启动时跑一次，跨日再跑 */
  cleanup(now: Date = this.now()): void {
    const cutoff = now.getTime() - this.opts.keepDays * 24 * 60 * 60 * 1000;
    for (const entry of this.list()) {
      if (Date.parse(`${entry.date}T00:00:00Z`) < cutoff) {
        try {
          safeRemoveFile(entry.file, [this.opts.dir]);
        } catch {
          // 删不掉就留着，下一天再试
        }
      }
    }
    this.cleanedOn = dateOf(now);
  }

  /** 清掉磁盘上全部插件运行日志（界面/CLI 显式清盘时才用） */
  clearDisk(): number {
    let removed = 0;
    for (const entry of this.list()) {
      try {
        safeRemoveFile(entry.file, [this.opts.dir]);
        removed += 1;
      } catch {
        // 同上
      }
    }
    this.current = null;
    return removed;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private cleanupOnce(now: Date): void {
    const today = dateOf(now);
    if (this.cleanedOn === today) return;
    this.cleanup(now);
  }

  private writeLine(date: string, line: string): void {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (
      this.current !== null &&
      this.current.file.startsWith(path.join(this.opts.dir, `trace-${date}`)) &&
      this.current.bytes + bytes <= this.opts.maxBytes
    ) {
      safeAppendFile(this.current.file, line, [this.opts.dir]);
      this.current.bytes += bytes;
      return;
    }
    const picked = this.pickFile(date, bytes);
    safeEnsureDir(this.opts.dir, [this.opts.dir]);
    safeAppendFile(picked.file, line, [this.opts.dir]);
    this.current = { file: picked.file, bytes: picked.bytes + bytes };
  }

  /** 选一个能装下这一行的文件：当天最后一个还装得下的，否则切下一个序号 */
  private pickFile(date: string, incoming: number): { file: string; bytes: number } {
    const sameDay = this.list().filter((entry) => entry.date === date);
    const base = path.join(this.opts.dir, `trace-${date}.jsonl`);
    if (sameDay.length === 0) return { file: base, bytes: 0 };
    const last = sameDay[sameDay.length - 1];
    if (last !== undefined && last.bytes + incoming <= this.opts.maxBytes) {
      return { file: last.file, bytes: last.bytes };
    }
    const highest = sameDay.reduce((max, entry) => Math.max(max, entry.index), 0);
    return { file: path.join(this.opts.dir, `trace-${date}.${highest + 1}.jsonl`), bytes: 0 };
  }

  /** 列出本目录里自己写的日志文件，按（日期, 序号）升序 */
  private list(): { file: string; date: string; index: number; bytes: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.opts.dir);
    } catch {
      return [];
    }
    const out: { file: string; date: string; index: number; bytes: number }[] = [];
    for (const name of names) {
      const match = TRACE_FILE.exec(name);
      if (match === null) continue;
      const file = path.join(this.opts.dir, name);
      let bytes = 0;
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        bytes = st.size;
      } catch {
        continue;
      }
      out.push({ file, date: match[1] as string, index: match[2] === undefined ? 0 : Number(match[2]), bytes });
    }
    out.sort((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1));
    return out;
  }
}

/** 日志文件名里的日期（UTC，取 ISO 的前 10 位；与文件名同口径） */
export function dateOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}
