/**
 * 失败语义与降级映射（详设 §6.13 / 概设 §4.7；台账 P1-11）。
 *
 * 查询管道各阶段不向上抛异常——内部信号（召回段失败、超时、冷启动等）统一收集
 * 到这里映射成对外 `degraded[]`（DEGRADED 枚举，8 种）。两条硬纪律：
 *   - **查失败绝不报 ok + 空**：有 degraded 信号时 status 必为 'degraded'，
 *     即使 evidence 也是空的（否则客户端会误以为"查到了、没有结果"）。
 *   - status:'ok' 与 evidence:[] 可以共存：全部召回成功但裁决后无可靠证据
 *     属正常结果，不是失败。
 *
 * 信号→码映射：
 *   bm25 段异常/不可用          → 'no_bm25'
 *   ppr 超时或异常              → 'no_ppr'
 *   向量段异常（knn 抛错）       → 'no_vector'
 *   sidecar 进程不可用（编码 0 结果被降级旁路时由编排者决定是否置码）
 *   GAT 缺失/不可用（P3）        → 'no_model'
 *   查询整体超时                → 'timeout'
 *   冷启动（无索引/空库旁路）     → 'cold_start'
 *   全局路径无 community 摘要    → 'no_summary'
 */
import { DEGRADED, type Degraded } from '../../domain/enums.js';

/** 编排层可上报的原始失败信号（每阶段最多一条） */
export type InternalSignal =
  | 'bm25_error'
  | 'ppr_timeout'
  | 'ppr_error'
  | 'vector_error'
  | 'gat_unavailable'
  | 'query_timeout'
  | 'cold_start'
  | 'summary_missing'
  | 'sidecar_unavailable';

export const SIGNAL_TO_DEGRADED: Readonly<Record<InternalSignal, Degraded>> = {
  bm25_error: 'no_bm25',
  ppr_timeout: 'no_ppr',
  ppr_error: 'no_ppr',
  vector_error: 'no_vector',
  gat_unavailable: 'no_model',
  query_timeout: 'timeout',
  cold_start: 'cold_start',
  summary_missing: 'no_summary',
  sidecar_unavailable: 'no_sidecar',
};

export interface DegradationResult {
  degraded: Degraded[];
  status: 'ok' | 'degraded';
}

/** 去重 + 按枚举序稳定输出 */
export function mapDegradation(signals: readonly InternalSignal[]): DegradationResult {
  const seen = new Set<Degraded>();
  const out: Degraded[] = [];
  for (const s of signals) {
    const code = SIGNAL_TO_DEGRADED[s];
    if (code !== undefined && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  out.sort((a, b) => DEGRADED.indexOf(a) - DEGRADED.indexOf(b));
  return { degraded: out, status: out.length > 0 ? 'degraded' : 'ok' };
}

/** 字符串是否是合法的 degraded 码（MCP 层把 JSON 里的 string[] 收回枚举类型时用） */
export const isDegraded = (value: string): value is Degraded =>
  (DEGRADED as readonly string[]).includes(value);
