/**
 * 性能基准核心逻辑（详设 §12.3；台账 P1-17）。
 *
 * P95 超阈值（默认 80ms）**连续两次**即阻断合并：本次与上次都超限 →
 * blocked=true。首次运行（无上次记录）即使超限也不阻断。
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

export interface BlockCheck {
  p95Ms: number;
  thresholdMs: number;
  prevP95Ms: number | null;
  over: boolean;
  blocked: boolean;
}

export function checkBlock(p95Ms: number, thresholdMs: number, prevP95Ms: number | null): BlockCheck {
  const over = p95Ms > thresholdMs;
  const prevOver = prevP95Ms !== null && prevP95Ms > thresholdMs;
  return { p95Ms, thresholdMs, prevP95Ms, over, blocked: over && prevOver };
}

export const BENCH_THRESHOLD_MS = 80;
