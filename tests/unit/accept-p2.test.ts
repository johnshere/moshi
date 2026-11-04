/**
 * `tools/accept-p2.ts` 的纯函数契约测试（台账 P2-19-A；验收链 §2）。
 *
 * 只测可复现的纯逻辑：百分位边界、空数组、汇总、FAIL 传播、报告 schema。
 * 真跑验收链由 `npx tsx tools/accept-p2.ts` 负责，不在单测里跑 5000 条种子。
 */
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  decideVerdict,
  formatStepLine,
  percentile,
  summarize,
  type AcceptStep,
} from '../../tools/accept-p2-lib.js';

function step(name: string, ok: boolean): AcceptStep {
  return { name, ok, ms: 1, detail: { n: 1 } };
}

describe('percentile：最近秩口径', () => {
  it('空数组返回 0（而不是 NaN）', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('单样本任何百分位都返回该样本', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('边界：p=0 取最小、p=1 取最大、p=0.5 取上中位', () => {
    const values = [10, 20, 30, 40];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 0.95)).toBe(40);
    expect(percentile(values, 1)).toBe(40);
  });

  it('越界 p 夹到 [0,1]，且不改写输入顺序', () => {
    const values = [5, 1, 4, 2];
    expect(percentile(values, -1)).toBe(1);
    expect(percentile(values, 2)).toBe(5);
    expect(values).toEqual([5, 1, 4, 2]);
  });

  it('20 个样本的 P95 = 第 19 慢（最近秩）', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(19);
    expect(percentile(values, 1)).toBe(20);
  });
});

describe('summarize / decideVerdict / buildReport', () => {
  it('summarize 统计 passed/total/failed', () => {
    expect(summarize([step('a', true), step('b', true), step('c', false)])).toEqual({
      passed: 2,
      total: 3,
      failed: 1,
    });
    expect(summarize([])).toEqual({ passed: 0, total: 0, failed: 0 });
  });

  it('decideVerdict：全过/空列表 → 0，任一 FAIL → 1（FAIL 传播）', () => {
    expect(decideVerdict([])).toBe(0);
    expect(decideVerdict([step('a', true), step('b', true)])).toBe(0);
    expect(decideVerdict([step('a', true), step('b', false)])).toBe(1);
  });

  it('buildReport 产出 schema/at/steps/summary 固定形状', () => {
    const steps = [step('seed', true), step('graph', false)];
    const report = buildReport(steps, '2026-11-04T00:00:00.000Z');
    expect(report.schema).toBe('moshi-accept-p2/1');
    expect(report.at).toBe('2026-11-04T00:00:00.000Z');
    expect(report.steps).toHaveLength(2);
    expect(report.summary).toEqual({ passed: 1, total: 2, failed: 1 });
  });

  it('formatStepLine：PASS/FAIL 前缀 + 数字保留两位 + FAIL 带 error', () => {
    const ok = formatStepLine(
      { name: 'search', ok: true, ms: 10, detail: { p95_ms: 12.3456 } },
      3,
      7,
    );
    expect(ok).toBe('PASS 3/7 search p95_ms=12.35');
    const bad = formatStepLine(
      { name: 'seed', ok: false, ms: 5, detail: { error: 'boom' } },
      1,
      7,
    );
    expect(bad).toBe('FAIL 1/7 seed error=boom');
  });
});
