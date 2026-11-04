/**
 * `tools/accept-p2.ts` 的纯函数库（台账 P2-19-A 收口；详设 §10.8 / §12）。
 *
 * 只放可单测的纯逻辑：百分位、汇总、判定、报告组装。跑库/起 HTTP 的部分都在
 * `tools/accept-p2.ts` 里，保证这一文件可以被 `tests/unit/accept-p2.test.ts`
 * 直接覆盖而不碰文件系统。
 */

/** 单步结果：`detail` 只放数字与短字符串，方便直接抄进验收报告 */
export interface AcceptStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: Record<string, unknown>;
}

/** 验收报告（`moshi-accept-p2/1`） */
export interface AcceptReport {
  schema: 'moshi-accept-p2/1';
  at: string;
  steps: AcceptStep[];
  summary: { passed: number; total: number; failed: number };
}

/**
 * 最近秩（nearest-rank）百分位：`p` 取 0..1，空数组返回 0。
 *
 * 延迟样本只有 20 个时不做插值——验收要的是「第 19 慢的那次有多慢」，
 * 插值会给出一个实际上不存在的样本值。
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(p)) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(clamped * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/** 汇总通过/总数/失败数 */
export function summarize(steps: readonly AcceptStep[]): {
  passed: number;
  total: number;
  failed: number;
} {
  const passed = steps.filter((s) => s.ok).length;
  const total = steps.length;
  return { passed, total, failed: total - passed };
}

/** 任一 FAIL → 退出码 1；全 PASS（含空列表）→ 0 */
export function decideVerdict(steps: readonly AcceptStep[]): 0 | 1 {
  return steps.some((s) => !s.ok) ? 1 : 0;
}

/** 组装报告；`at` 由调用方传入，便于测试固定时钟 */
export function buildReport(steps: readonly AcceptStep[], at: string): AcceptReport {
  return {
    schema: 'moshi-accept-p2/1',
    at,
    steps: [...steps],
    summary: summarize(steps),
  };
}

/** 控制台单行：`PASS 3/7 search ...`；FAIL 时追 `— <error>` */
export function formatStepLine(step: AcceptStep, index: number, total: number): string {
  const parts = [`${step.ok ? 'PASS' : 'FAIL'} ${String(index)}/${String(total)} ${step.name}`];
  for (const [k, v] of Object.entries(step.detail)) {
    if (k === 'error') continue;
    parts.push(`${k}=${typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v)}`);
  }
  if (!step.ok) parts.push(`error=${String(step.detail['error'] ?? 'unknown')}`);
  return parts.join(' ');
}
