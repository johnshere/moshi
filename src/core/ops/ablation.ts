/**
 * P4-02 消融定义与汇总（纯函数；CLI 只负责跑）。
 *
 * 七项各只变一个开关（综述 §15.9 / 台账 P4-02）：
 * gat / self_attn / cross_attn / vector / bm25 / ppr / 结构化vs扁平。
 * 基线一律取该开关的“完整”状态，变体只动该开关，其余保持缺省。
 */
import type { EvalOutcome, GoldenType } from './eval.js';

export type AblationAxis =
  | 'gat'
  | 'self_attn'
  | 'cross_attn'
  | 'vector'
  | 'bm25'
  | 'ppr'
  | 'structured';

export interface AblationConfig {
  gat: 'off' | 'on';
  channels?: { vector?: boolean; bm25?: boolean; ppr?: boolean };
  modelOptions?: { selfAttn?: boolean; crossAttn?: boolean };
  /** 扁平证据：清空 `dependency_summary` / `conflicts` 后再判题 */
  flat?: boolean;
}

export interface AblationSpec {
  axis: AblationAxis;
  label: string;
  baseline: AblationConfig;
  variant: AblationConfig;
  /** 本项到底变了什么，报告里要写清楚 */
  change: string;
}

const FULL: AblationConfig = { gat: 'off' };

export const ABLATION_SPECS: readonly AblationSpec[] = [
  {
    axis: 'gat',
    label: 'GAT',
    baseline: { gat: 'off' },
    variant: { gat: 'on' },
    change: 'gat off → on',
  },
  {
    // 两者都 gat=on：只有 self_attn 一个开关变化
    axis: 'self_attn',
    label: 'self-attention',
    baseline: { gat: 'on' },
    variant: { gat: 'on', modelOptions: { selfAttn: true } },
    change: 'self_attn off → on（均 gat=on）',
  },
  {
    axis: 'cross_attn',
    label: 'cross-attention',
    baseline: { gat: 'on' },
    variant: { gat: 'on', modelOptions: { crossAttn: false } },
    change: 'cross_attn on → off（均 gat=on）',
  },
  {
    axis: 'vector',
    label: '向量路',
    baseline: FULL,
    variant: { gat: 'off', channels: { vector: false } },
    change: 'vector on → off',
  },
  {
    axis: 'bm25',
    label: 'BM25',
    baseline: FULL,
    variant: { gat: 'off', channels: { bm25: false } },
    change: 'bm25 on → off',
  },
  {
    axis: 'ppr',
    label: 'PPR',
    baseline: FULL,
    variant: { gat: 'off', channels: { ppr: false } },
    change: 'ppr on → off',
  },
  {
    axis: 'structured',
    label: '结构化 vs 扁平',
    baseline: FULL,
    variant: { gat: 'off', flat: true },
    change: '结构化证据 → 扁平事实列表',
  },
];

export interface AblationSideStats {
  passed: number;
  total: number;
  byType: Record<GoldenType, { passed: number; total: number }>;
  /** 逐题耗时 P95（毫秒，取整） */
  p95Ms: number;
}

export interface AblationRow {
  axis: AblationAxis;
  label: string;
  change: string;
  baseline: AblationSideStats;
  variant: AblationSideStats;
  /** 变体相对基线的入包差异率；纯结构项（structured）为 null */
  packDiff: number | null;
}

const TYPES: readonly GoldenType[] = ['single_hop', 'multi_hop', 'temporal', 'refusal'];

/** P95（最近秩法，n=0 记 0） */
export function percentile95(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[idx]!);
}

export function summarizeSide(
  outcomes: readonly EvalOutcome[],
  latenciesMs: readonly number[],
): AblationSideStats {
  const byType = {} as AblationSideStats['byType'];
  for (const t of TYPES) byType[t] = { passed: 0, total: 0 };
  for (const o of outcomes) {
    byType[o.type].total += 1;
    if (o.pass) byType[o.type].passed += 1;
  }
  return {
    passed: outcomes.filter((o) => o.pass).length,
    total: outcomes.length,
    byType,
    p95Ms: percentile95(latenciesMs),
  };
}

/** 表格：axis | 变化 | 基线通过 | 变体通过 | 分题型（基→变） | P95 基→变 | 入包差异 */
export function formatAblations(rows: readonly AblationRow[]): string {
  const lines = [
    '消融（每项只变一个开关；通过数 = golden 判题）',
    'axis        变化                              通过       单跳     多跳     时态     拒答     P95ms      入包差异',
  ];
  for (const r of rows) {
    const axis = r.axis.padEnd(11);
    const change = r.change.padEnd(32);
    const passed = `${r.baseline.passed}→${r.variant.passed}`.padEnd(9);
    const byType = TYPES.map(
      (t) => `${r.baseline.byType[t].passed}→${r.variant.byType[t].passed}`.padEnd(7),
    ).join(' ');
    const p95 = `${r.baseline.p95Ms}→${r.variant.p95Ms}`.padEnd(10);
    const diff = r.packDiff === null ? '-' : `${(r.packDiff * 100).toFixed(1)}%`;
    lines.push(`${axis} ${change} ${passed} ${byType} ${p95} ${diff}`);
  }
  return lines.join('\n');
}
