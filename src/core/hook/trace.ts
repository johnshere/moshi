/**
 * 插件运行日志（Z-01C / 设计 §8.4，`moshi-hook-trace/1`）。
 *
 * 与 `core/read/trace.ts` 的 TraceStore 同一形态：进程内 ring buffer，重启即丢。
 * **这不是账本，是诊断窗口**——真正落库的是 `episode`，持久化版本留作遗留项
 * （Z-01C-e）。
 *
 * 一条纪律（用户 m01321 改为分档）：**默认 off 不记查询文本、不记注入文本**。
 * Magpie 的 `ctx.report` 注释明确禁止把查询/scope/凭据/召回内容带出宿主，
 * 我们自己的日志也不该成为绕过这个约定的后门。需要排查时由 `hook_plugin_trace.level`
 * 显式打开 `summary`/`full`：`summary` 只多带证据 id/分数、耗时与哈希（仍无正文），
 * `full` 才落正文且落盘前必过脱敏。
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
  /** 注入回执号（Z-01C-e）：把 recall 与随后的 signal 对上 */
  corr_id?: string;
  /** 注入证据的 m_id（summary 档起；off 档没有） */
  evidence_ids?: number[];
  /** 与 `evidence_ids` 一一对应的置信度 */
  evidence_scores?: number[];
  /** 因预算/地板等原因丢弃的条数，按原因分组 */
  drop_reasons?: Record<string, number>;
  /** 分阶段耗时（summary 档起）：检索 / 渲染 / 总耗时 */
  stage_ms?: { search?: number; render?: number; total?: number };
  /** 注入文本、查询、回复的 sha256 前 16 hex（summary 档起） */
  inject_sha256?: string;
  query_sha256?: string;
  reply_sha256?: string;
  /** 正文（只有 full 档才有，落盘前过脱敏） */
  query_text?: string;
  inject_text?: string;
  evidence_text?: string[];
  reply_text?: string;
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
