/**
 * 模型熔断（详设 §7.7；台账 P3-10）。
 *
 * 三个触发，全部只在 `on` 档上有实际作用（`mode()` 取「配置档位」与「熔断档位」的较低者）：
 *   - 延迟：最近 3 分钟 P95 > 80ms 且持续 3 分钟 → `on → shadow`
 *   - 塌缩：连续 100 个打分值的标准差 < 0.01 → `on → shadow`
 *   - 崩溃：sidecar 一小时内崩溃达上限（由 `SidecarClient` 自己计数）→ `on → off`
 *
 * **熔断后不自动恢复**：`mode()` 永远返回熔断档位，直到显式 `reset()`。
 * 自动恢复会造成「熔断—恢复—再熔断」循环，且没人知道它发生过。
 *
 * 状态只在进程内：重启 daemon 会按配置文件重新评估——改配置再重启
 * 就是人工确认的恢复路径。进程内状态不落库，避免留下没有任何命令行入口
 * 能清除的「永久 shadow」。
 */
import type { ModelScore } from './search.js';

export type ModelMode = 'off' | 'shadow' | 'on';
export type BreakerReason = 'latency' | 'collapse' | 'crash';

/** 详设 §7.7 的阈值 */
export const BREAKER_P95_LIMIT_MS = 80;
export const BREAKER_LATENCY_WINDOW_MS = 3 * 60_000;
export const BREAKER_MIN_LATENCY_SAMPLES = 20;
export const BREAKER_COLLAPSE_WINDOW = 100;
export const BREAKER_COLLAPSE_STD = 0.01;

export interface BreakerTrip {
  reason: BreakerReason;
  at: number;
  /** 熔断后的档位：延迟/塌缩 → shadow，崩溃 → off */
  to: 'shadow' | 'off';
}

export interface BreakerOptions {
  now?: () => number;
  /** 告警出口（详设 §7.7「写告警」）；只在该次熔断时调用一次 */
  onTrip?: (trip: BreakerTrip) => void;
}

const RANK: Record<ModelMode, number> = { off: 0, shadow: 1, on: 2 };

function lowerMode(a: ModelMode, b: ModelMode): ModelMode {
  return RANK[a] <= RANK[b] ? a : b;
}

function stddev(values: readonly number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** 最近邻取整的 P95（与 `bench` 的口径一致：升序第 ceil(0.95n) 个） */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx]!;
}

export class Breaker {
  private readonly now: () => number;
  private readonly onTrip: ((trip: BreakerTrip) => void) | undefined;
  private trip: BreakerTrip | null = null;
  /** 最近 3 分钟的模型耗时（毫秒） */
  private latency: { at: number; ms: number }[] = [];
  /** P95 超限的起始时刻；低于阈值即清零 */
  private hotSince: number | null = null;
  /** 最近 100 次打分的平均 δ（每次打分一个值），用于塌缩判定 */
  private deltas: number[] = [];

  constructor(opts: BreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onTrip = opts.onTrip;
  }

  /** 当前熔断记录；null = 未熔断 */
  current(): BreakerTrip | null {
    return this.trip;
  }

  /** 实际生效档位 = 配置档位与熔断档位的较低者 */
  mode(configured: ModelMode): ModelMode {
    return this.trip === null ? configured : lowerMode(configured, this.trip.to);
  }

  /** 人工恢复的唯一入口（重启 daemon 也等价于重新评估） */
  reset(): void {
    this.trip = null;
    this.latency = [];
    this.hotSince = null;
    this.deltas = [];
  }

  /**
   * 记录一次打分：`scores` 是本次各节点的 δ，`latencyMs` 是这次 `/score` 的耗时。
   * 降级/超时用空数组调用——只计延迟，不产生 δ 样本（没有分数就没有塌缩信号）。
   */
  recordScore(scores: readonly ModelScore[], latencyMs: number): void {
    if (this.trip !== null) return;
    const at = this.now();

    // ── 塌缩：连续 100 次打分的平均 δ 标准差 < 0.01 ──
    // 每次打分记一个代表值（本次各节点 δ 的均值）：塌缩是「模型对什么都给同一分」，
    // 一次查询内的节点间方差不是它要抓的信号。
    const deltas = scores.map((s) => s.delta).filter((d) => Number.isFinite(d));
    if (deltas.length > 0) {
      this.deltas.push(deltas.reduce((s, d) => s + d, 0) / deltas.length);
    }
    if (this.deltas.length > BREAKER_COLLAPSE_WINDOW) {
      this.deltas.splice(0, this.deltas.length - BREAKER_COLLAPSE_WINDOW);
    }
    if (this.deltas.length >= BREAKER_COLLAPSE_WINDOW && stddev(this.deltas) < BREAKER_COLLAPSE_STD) {
      this.fire({ reason: 'collapse', at, to: 'shadow' });
      return;
    }

    // ── 延迟：3 分钟窗口 P95 > 80ms，且持续 3 分钟 ──
    this.latency.push({ at, ms: latencyMs });
    const cutoff = at - BREAKER_LATENCY_WINDOW_MS;
    while (this.latency.length > 0 && this.latency[0]!.at <= cutoff) this.latency.shift();
    if (this.latency.length < BREAKER_MIN_LATENCY_SAMPLES) {
      this.hotSince = null;
      return;
    }
    if (p95(this.latency.map((s) => s.ms)) > BREAKER_P95_LIMIT_MS) {
      this.hotSince ??= at;
      if (at - this.hotSince >= BREAKER_LATENCY_WINDOW_MS) {
        this.fire({ reason: 'latency', at, to: 'shadow' });
      }
    } else {
      this.hotSince = null;
    }
  }

  /**
   * sidecar 已用尽自己的重启额度（`SidecarClient` 一小时 ≥ `max_restarts_per_hour`）。
   * 计数留在客户端，这里只接「已判失败」这一个信号，避免两套计数器漂移。
   */
  recordSidecarFailure(): void {
    if (this.trip !== null) return;
    this.fire({ reason: 'crash', at: this.now(), to: 'off' });
  }

  private fire(trip: BreakerTrip): void {
    this.trip = trip;
    this.onTrip?.(trip);
  }
}
