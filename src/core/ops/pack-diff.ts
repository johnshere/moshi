/**
 * 入包集合差异率（详设 §11.2 / 综述 §15.7；台账 P3-11）。
 *
 *   rate = 1 - |TopK_on ∩ TopK_off| / K
 *
 * `K` 取**实际入包条数**而不是固定 TopK：两组条数可能不同（token 预算、覆盖率、
 * 模型 δ 改变置信后入包条数都会变）。这里取两组的较大者，保证 `rate ∈ [0,1]`
 * 且指标对两侧对称；两组都为空时记 0（"没有差异"而不是除零）。
 *
 * P3 退出条件：**开/关 GAT 的入包集合差异率显著非零**（阈值 5%，见概设 §12）。
 * 用"集合"而不是"排序"：排序有可测差异会把零收益判成通过（综述 §15.7）。
 */

export const PACK_DIFF_THRESHOLD = 0.05;

export interface PackComparison {
  /** 两组的实际入包条数（去重后） */
  kOn: number;
  kOff: number;
  overlap: number;
  /** 分母：`max(kOn, kOff)` */
  k: number;
  rate: number;
}

export function comparePacks(on: readonly string[], off: readonly string[]): PackComparison {
  const onSet = new Set(on);
  const offSet = new Set(off);
  let overlap = 0;
  for (const id of onSet) if (offSet.has(id)) overlap += 1;
  const k = Math.max(onSet.size, offSet.size);
  return {
    kOn: onSet.size,
    kOff: offSet.size,
    overlap,
    k,
    rate: k === 0 ? 0 : 1 - overlap / k,
  };
}

export interface PackDiffRow extends PackComparison {
  id: string;
}

export interface PackDiffSummary {
  queries: number;
  /** 逐题差异率的算术平均（每题等权） */
  meanRate: number;
  threshold: number;
  /** `meanRate > threshold`（P3 退出条件；等于阈值不算通过） */
  pass: boolean;
}

/**
 * 逐题对齐两组入包（`onPacks[i]` 与 `offPacks[i]` 必须对应同一道题、同一顺序）。
 * 条数不一致说明调用方的两组运行没对齐——直接抛错，别把错位算成差异。
 */
export function packDiffRows(
  ids: readonly string[],
  onPacks: readonly (readonly string[])[],
  offPacks: readonly (readonly string[])[],
): PackDiffRow[] {
  if (onPacks.length !== ids.length || offPacks.length !== ids.length) {
    throw new Error(
      `入包差异率：两组结果条数不一致（题 ${ids.length} / on ${onPacks.length} / off ${offPacks.length}）`,
    );
  }
  return ids.map((id, i) => ({ id, ...comparePacks(onPacks[i]!, offPacks[i]!) }));
}

export function summarizePackDiff(
  rows: readonly PackDiffRow[],
  threshold: number = PACK_DIFF_THRESHOLD,
): PackDiffSummary {
  const meanRate =
    rows.length === 0 ? 0 : rows.reduce((s, r) => s + r.rate, 0) / rows.length;
  return { queries: rows.length, meanRate, threshold, pass: meanRate > threshold };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** CLI 展示：总体一行 + 逐题明细（只列有差异的题，全零时也给出结论） */
export function formatPackDiff(rows: readonly PackDiffRow[], summary: PackDiffSummary): string {
  const lines = [
    `入包差异率（K=实际入包条数）：${pct(summary.meanRate)}（${summary.queries} 题；阈值 ${pct(summary.threshold)}，${summary.pass ? '达标' : '未达标'}）`,
  ];
  for (const r of rows) {
    if (r.rate === 0) continue;
    lines.push(`  ${r.id} on=${r.kOn} off=${r.kOff} 交集 ${r.overlap} 差异 ${pct(r.rate)}`);
  }
  return lines.join('\n');
}
