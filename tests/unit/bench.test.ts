/**
 * P1-17 性能基准核心逻辑单测（详设 §12.3；台账 P1-17）。
 *
 * 验收：percentile 边界正确；P95 超 80ms 连续两次阻断（首次超限不阻断、
 * 单次超限不阻断、两次都超限阻断、恢复后不阻断）。
 */
import { describe, expect, it } from 'vitest';
import { percentile, checkBlock, BENCH_THRESHOLD_MS } from '../../src/core/ops/bench.js';

describe('性能基准（P1-17）', () => {
  it('percentile：空数组 0；P50/P95/P99 定位正确', () => {
    expect(percentile([], 95)).toBe(0);
    const sorted = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(100); // ceil(0.5*200)-1=99 → 100
    expect(percentile(sorted, 95)).toBe(190);
    expect(percentile(sorted, 99)).toBe(198);
  });

  it('连续两次超限才阻断：首次超限不阻断', () => {
    expect(checkBlock(90, 80, null).blocked).toBe(false);
    expect(checkBlock(90, 80, 85).blocked).toBe(true); // 两次都超
    expect(checkBlock(90, 80, 70).blocked).toBe(false); // 上次未超 → 恢复
    expect(checkBlock(60, 80, 90).blocked).toBe(false); // 本次未超
  });

  it('默认阈值 80ms', () => {
    expect(BENCH_THRESHOLD_MS).toBe(80);
    expect(checkBlock(80, BENCH_THRESHOLD_MS, 81).blocked).toBe(false); // 恰等阈值不算超
    expect(checkBlock(81, BENCH_THRESHOLD_MS, 81).blocked).toBe(true);
  });
});
