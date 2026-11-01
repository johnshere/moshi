/**
 * 预算装箱（详设 §6.8）。
 *
 * 符号兜底后的 kept facts 按池分装：floorPool（value_floor）先装、utilPool 后装。
 *   - B=1500 / utilB=1050 / floorB=450；单条 perItem = min(estimateTokens(content), 80)
 *   - floor 按 score×1.15 贪心、util 按 score×1.0 贪心
 *   - floor 先满足 floor_min=2（候选够则至少 2 条进包）
 *   - **单向借**：floor 未用满 → 剩余预算借给 util；util 装不下不可反向借 floor
 *   - 总量不超 B
 *
 * estimateTokens 口径（§6.8，与 domain/text.ts 的 cjk×1+other/4 不同）：
 *   cjk(charCode>0x2e80)×1.0 + ascii/3.2，向上取整。P1-09 起证据包预算按此口径，
 *   domain/text.ts 是 MCP 描述 lint 的共享实现，不在这里改——pack.ts 内自建。
 *
 * 单条超 80 token 截断：保留首句（到第一个 。 或 . 空格）+“…”，不改 fact.content 本体。
 */
import type { Fact } from '../../domain/types.js';
import type { AdjudicatedFact, AdjudicationFlag } from './adjudicate.js';

export interface PackItem {
  fact: Fact;
  /** 截断后的打包正文（超 80 token 才截） */
  packedText: string;
  tokens: number;
  pool: 'value_floor' | 'utility';
  score: number;
  /** 符号兜底五步的 flags（disputed 等），供证据包透传 */
  flags: AdjudicationFlag[];
}

export interface PackOptions {
  budget?: number;
  utilBudget?: number;
  floorBudget?: number;
  floorMin?: number;
  perItemMax?: number;
}

const DEFAULT = { budget: 1500, utilBudget: 1050, floorBudget: 450, floorMin: 2, perItemMax: 80 };

export interface PackResult {
  items: PackItem[];
  totalTokens: number;
  floorTokens: number;
  utilTokens: number;
  dropped: number;
}

/** §6.8 口径：CJK 字 1 token，其余字符 /3.2，向上取整 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.0 + other / 3.2);
}

/** 截断到首句（第一个 。 或 ". "）+“…” */
export function truncateToFirstSentence(text: string): string {
  const idx = text.search(/[。]|\.\s/);
  if (idx === -1) return text;
  return `${text.slice(0, idx + 1)}…`;
}

export function packFacts(inputs: readonly AdjudicatedFact[], opts: PackOptions = {}): PackResult {
  const budget = opts.budget ?? DEFAULT.budget;
  const utilBudget = opts.utilBudget ?? DEFAULT.utilBudget;
  const floorBudget = opts.floorBudget ?? DEFAULT.floorBudget;
  const floorMin = opts.floorMin ?? DEFAULT.floorMin;
  const perItemMax = opts.perItemMax ?? DEFAULT.perItemMax;

  interface Cand {
    fact: Fact;
    score: number;
    pool: 'value_floor' | 'utility';
    est: number;
    packedText: string;
    tokens: number;
    flags: AdjudicationFlag[];
  }

  const cands: Cand[] = inputs.map((a) => {
    const est = estimateTokens(a.fact.content);
    const tokens = Math.min(est, perItemMax);
    const packedText = tokens >= est ? a.fact.content : truncateToFirstSentence(a.fact.content);
    return {
      fact: a.fact,
      score: a.finalScore,
      pool: a.fact.pool === 'value_floor' ? 'value_floor' : 'utility',
      est,
      packedText,
      tokens,
      flags: a.flags,
    };
  });

  const floorCands = cands.filter((c) => c.pool === 'value_floor').sort((a, b) => b.score * 1.15 - a.score * 1.15);
  const utilCands = cands.filter((c) => c.pool === 'utility').sort((a, b) => b.score * 1.0 - a.score * 1.0);

  // ── floor 池：先满足 floor_min=2（预算内强行装入），再按预算贪心 ──
  const floorTaken: Cand[] = [];
  let floorTokens = 0;
  for (const c of floorCands.slice(0, floorMin)) {
    if (floorTokens + c.tokens <= floorBudget) {
      floorTaken.push(c);
      floorTokens += c.tokens;
    }
  }
  for (const c of floorCands.slice(floorMin)) {
    if (floorTokens + c.tokens > floorBudget) continue;
    floorTaken.push(c);
    floorTokens += c.tokens;
  }

  // ── util 池：预算 = utilB + floor 剩余（单向借）──
  const utilBudgetActual = utilBudget + (floorBudget - floorTokens);
  const utilTaken: Cand[] = [];
  let utilTokens = 0;
  for (const c of utilCands) {
    if (utilTokens + c.tokens > utilBudgetActual) continue;
    utilTaken.push(c);
    utilTokens += c.tokens;
  }

  const items: PackItem[] = [...floorTaken, ...utilTaken].map((c) => ({
    fact: c.fact,
    packedText: c.packedText,
    tokens: c.tokens,
    pool: c.pool,
    score: c.score,
    flags: c.flags,
  }));

  const totalTokens = floorTokens + utilTokens;
  if (totalTokens > budget) {
    // 兜底：总预算保护（floorB+utilB=B，借出后 util 预算 ≤ B，理论不会超；防御断言）
    throw new Error(`pack overflow: ${totalTokens} > ${budget}`);
  }

  return {
    items,
    totalTokens,
    floorTokens,
    utilTokens,
    dropped: cands.length - items.length,
  };
}
