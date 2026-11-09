/**
 * 注入台账（Z-01C / 设计 §8.4，`moshi-hook-trace/1`）。
 *
 * 与 `core/read/trace.ts` 的 TraceStore 同一形态：进程内 ring buffer，重启即丢。
 * **这不是账本，是诊断窗口**——真正落库的是 `episode`，持久化版本留作遗留项
 * （Z-01C-e）。
 *
 * 一条纪律：**只记计数与枚举，不记查询文本、不记注入文本**。Magpie 的
 * `ctx.report` 注释明确禁止把查询/scope/凭据/召回内容带出宿主，我们自己的台账
 * 也不该成为绕过这个约定的后门——否则 `moshi hook trace` 一打印就是满屏用户原话。
 */
import { HOOK_TRACE_SCHEMA, type HookHost, type HookReportCode, type HookTurn } from './protocol.js';

/** ring buffer 容量 */
export const HOOK_TRACE_CAPACITY = 200;

export interface HookTraceItem {
  ts: string;
  host: HookHost;
  turn: HookTurn;
  status: HookReportCode;
  /** 注入文本的 UTF-8 字节数（没注入就是 0） */
  inject_bytes: number;
  evidence: number;
  degraded: string[];
  identity_source: string;
  latency_ms: number;
  /** 落库轮次产生的字段（`/hook/signal`）；`/hook/recall` 时为 undefined */
  captured?: boolean;
  duplicate?: boolean;
}

export interface HookTraceSnapshot {
  schema: typeof HOOK_TRACE_SCHEMA;
  items: HookTraceItem[];
  capacity: number;
}

export class HookTraceStore {
  private readonly items: HookTraceItem[] = [];
  private readonly capacity: number;

  constructor(capacity: number = HOOK_TRACE_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  push(item: HookTraceItem): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** 最近的在前（`moshi hook trace` 直接按打印顺序给出） */
  recent(limit = 20): HookTraceItem[] {
    const n = Math.max(0, Math.min(limit, this.items.length));
    return this.items.slice(this.items.length - n).reverse();
  }

  snapshot(limit = 20): HookTraceSnapshot {
    return { schema: HOOK_TRACE_SCHEMA, items: this.recent(limit), capacity: this.capacity };
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }
}
