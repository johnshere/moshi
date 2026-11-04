/**
 * golden set 评估（纯逻辑：读题、判题、门禁汇总）。
 *
 * P2-19A-13b：从 `src/app/cli/commands/eval.ts` 抽出来，CLI 与
 * `POST /api/eval/run` 共用同一套判题口径，避免两处漂移。
 *
 * 纪律：
 * - **不 import app 层**：真正跑查询由调用方注入 `EvalQueryFn`，core 只依赖
 *   `EvidencePackJson` 的结构性子集；
 * - 判题口径保持 P1-16 原样：单跳/多跳 recall@K ≥ 0.8，时态加 must_not_contain，
 *   拒答要求 confidence_summary === 'none' 且 evidence 为空；
 * - 门禁类型只有 temporal / refusal，任一失败即 `gate_failed`（阻断发布）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type GoldenType = 'single_hop' | 'multi_hop' | 'temporal' | 'refusal';

export interface GoldenItem {
  id: string;
  type: GoldenType;
  query: string;
  expect_facts?: string[];
  expect_absent?: string[];
  must_not_contain?: string[];
}

export interface EvalOutcome {
  id: string;
  type: GoldenType;
  pass: boolean;
  detail: string;
}

/** 判题只读 pack 的这几项；结构上兼容 `EvidencePackJson` */
export interface EvalPackView {
  evidence: readonly { fact_id: string }[];
  numbered_list: string;
  dependency_summary: readonly unknown[];
  confidence_summary: string;
}

/** 由调用方注入（CLI 走 MCP deps，HTTP 走 buildHttpApp 的 deps） */
export type EvalQueryFn = (query: string, topK: number) => Promise<EvalPackView>;

export const EVAL_TOP_K = 8;

/** 门禁题型：这两类失败算阻断（详设 §11.3 / 台账 P1-16） */
export const EVAL_GATE_TYPES: readonly GoldenType[] = ['temporal', 'refusal'];

/** 读 golden.jsonl；行非法 JSON 跳过但计数（保持 P1-16 行为） */
export function loadGolden(file: string): { items: GoldenItem[]; skipped: number } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`golden set 不存在：${file}`, { cause: err });
  }
  const items: GoldenItem[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      items.push(JSON.parse(trimmed) as GoldenItem);
    } catch {
      skipped += 1;
    }
  }
  return { items, skipped };
}

function recallAtK(expect: readonly string[], got: readonly string[]): number {
  if (expect.length === 0) return 1;
  const gotSet = new Set(got);
  return expect.filter((f) => gotSet.has(f)).length / expect.length;
}

/** 对单题判定（查询由注入函数完成，core 不碰 db/HTTP） */
export async function evaluateItem(item: GoldenItem, query: EvalQueryFn): Promise<EvalOutcome> {
  const pack = await query(item.query, EVAL_TOP_K);
  const got = pack.evidence.map((e) => e.fact_id);
  const expect = item.expect_facts ?? [];
  const absent = item.expect_absent ?? [];
  const mustNot = item.must_not_contain ?? [];
  const text = pack.numbered_list;

  const recalled = recallAtK(expect, got);
  const absentHit = absent.some((f) => got.includes(f));
  const forbiddenHit = mustNot.some((t) => text.includes(t));

  switch (item.type) {
    case 'single_hop':
      return {
        id: item.id,
        type: item.type,
        pass: recalled >= 0.8 && !absentHit,
        detail: `recall@K=${recalled.toFixed(2)}（期望 ${expect.length} 命中 ${expect.filter((f) => got.includes(f)).length}）${absentHit ? '；命中禁入事实' : ''}`,
      };
    case 'multi_hop':
      return {
        id: item.id,
        type: item.type,
        pass: recalled >= 0.8 && !absentHit && pack.dependency_summary.length > 0,
        detail: `recall@K=${recalled.toFixed(2)}；依赖链 ${pack.dependency_summary.length} 条`,
      };
    case 'temporal':
      return {
        id: item.id,
        type: item.type,
        pass: recalled >= 0.8 && !absentHit && !forbiddenHit,
        detail: `recall@K=${recalled.toFixed(2)}；must_not_contain 命中=${forbiddenHit ? '是（FAIL）' : '否'}`,
      };
    case 'refusal':
      return {
        id: item.id,
        type: item.type,
        pass: pack.confidence_summary === 'none' && pack.evidence.length === 0,
        detail: `confidence_summary=${pack.confidence_summary}；evidence=${pack.evidence.length}`,
      };
    default:
      return { id: item.id, type: item.type, pass: false, detail: `未知题型 ${item.type}` };
  }
}

export interface GoldenRunResult {
  outcomes: EvalOutcome[];
  passed: number;
  total: number;
  /** 阻断题型里失败的数量（`meta.last_eval.blocking_failures` 的口径） */
  blocking_failures: number;
  /** 只要有一个阻断题型失败就为 true */
  gate_failed: boolean;
  skipped: number;
}

/** 跑完整 golden set（顺序执行，与 CLI 行为一致） */
export async function runGoldenSet(
  items: readonly GoldenItem[],
  query: EvalQueryFn,
  skipped = 0,
): Promise<GoldenRunResult> {
  const outcomes: EvalOutcome[] = [];
  for (const it of items) outcomes.push(await evaluateItem(it, query));
  const passed = outcomes.filter((o) => o.pass).length;
  const blocking = outcomes.filter((o) => EVAL_GATE_TYPES.includes(o.type) && !o.pass);
  return {
    outcomes,
    passed,
    total: outcomes.length,
    blocking_failures: blocking.length,
    gate_failed: blocking.length > 0,
    skipped,
  };
}

/** 按题型汇总 `single_hop: 3/3` 这类 CLI 展示串（保持原输出格式） */
export function formatByType(outcomes: readonly EvalOutcome[]): string {
  const types: readonly GoldenType[] = ['single_hop', 'multi_hop', 'temporal', 'refusal'];
  return types
    .map((t) => {
      const list = outcomes.filter((o) => o.type === t);
      return `${t}: ${list.filter((o) => o.pass).length}/${list.length}`;
    })
    .join('  ');
}

/**
 * `--golden` / 配置里的取值既可以是**版本令牌**（`v1` → `golden.v1.jsonl`）
 * 也可以是**路径**。HTTP 版本没有 CLI 的 home，用数据目录反推：默认
 * `storage.data_dir = <home>/.moshi`，因此 home = dirname(data_dir)。
 */
export function resolveGoldenFile(value: string | undefined, home: string, fallback: string): string {
  if (value === undefined || value === '') return fallback;
  if (/^v\d+$/i.test(value)) {
    return path.join(home, '.moshi', 'golden', `golden.${value.toLowerCase()}.jsonl`);
  }
  return value;
}
