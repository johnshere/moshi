/**
 * 裁决快照仓储（详设 §2.9 / 综述 v0.12 §16.2）。
 *
 * 这张表是 GAT 唯一的**非循环**标签来源：符号规则在 t 时刻做了裁决，
 * t' 时刻被新观测推翻。用 Agent 自己的 verdict 训 GAT 是自我蒸馏，上限零增益。
 */
import type { AdjKind, AdjOutcome } from '../../domain/enums.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from './db.js';

export interface OpenAdjudication {
  kind: AdjKind;
  factIds: readonly string[];
  /** 规则名@版本，能反查是哪条规则不可靠 */
  decidedBy: string;
  decidedAt?: string;
  queryId?: string | null;
}

export function openAdjudication(db: Db, input: OpenAdjudication): string {
  const id = newId('adjudication');
  db.prepare(
    `INSERT INTO adjudication (id, kind, fact_ids, decided_by, decided_at, outcome, outcome_at,
                               outcome_evidence, query_id)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    id,
    input.kind,
    JSON.stringify(input.factIds),
    input.decidedBy,
    input.decidedAt ?? nowIso(),
    input.queryId ?? null,
  );
  return id;
}

/**
 * 去重版 open（P1-08 互斥判定用）：同一 (kind, fact_ids 排序后 JSON, decided_by)
 * 已存在则不再写——互斥判定每轮查询都会重跑，不能给同一对事实刷出无限条裁决记录。
 * 返回 true = 新写入，false = 已存在。
 *
 * 去重键按**排序后**的集合比较（I-49），但**落库保留传入顺序**：`mutex_win` 的
 * `factIds[0]=winner / [1]=loser` 是写入侧回填 `outcome` 时判定 favored 的唯一依据，
 * 排序会把这层信息丢掉。因此不能再用 SQL 的 `fact_ids = 排序后JSON` 做等值去重，
 * 只能把同规则下的候选行取回来在内存里比集合。
 */
export function openAdjudicationOnce(db: Db, input: OpenAdjudication): boolean {
  const dedupeKey = sortedIdsKey(input.factIds);
  const rows = db
    .prepare('SELECT fact_ids FROM adjudication WHERE kind = ? AND decided_by = ?')
    .all(input.kind, input.decidedBy) as { fact_ids: string }[];
  const duplicated = rows.some((row) => sortedIdsKey(parseFactIds(row.fact_ids)) === dedupeKey);
  if (duplicated) return false;
  const id = newId('adjudication');
  db.prepare(
    `INSERT INTO adjudication (id, kind, fact_ids, decided_by, decided_at, outcome, outcome_at,
                               outcome_evidence, query_id)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(id, input.kind, JSON.stringify(input.factIds), input.decidedBy, input.decidedAt ?? nowIso(), input.queryId ?? null);
  return true;
}

/** 集合去重键：排序后 JSON（不用于落库，只用于比较） */
function sortedIdsKey(ids: readonly string[]): string {
  return JSON.stringify([...ids].sort());
}

/** 解析 `fact_ids` 列；脏数据按空数组处理，不让一条坏行毒死整轮去重 */
function parseFactIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function resolveAdjudication(
  db: Db,
  id: string,
  outcome: AdjOutcome,
  evidence: string | null = null,
  ts: string = nowIso(),
): void {
  db.prepare(
    'UPDATE adjudication SET outcome = ?, outcome_at = ?, outcome_evidence = ? WHERE id = ? AND outcome IS NULL',
  ).run(outcome, ts, evidence, id);
}

export interface AdjudicationRow {
  id: string;
  kind: AdjKind;
  factIds: string[];
  decidedBy: string;
  decidedAt: string;
  outcome: AdjOutcome | null;
  outcomeAt: string | null;
  outcomeEvidence: string | null;
}

export function getAdjudication(db: Db, id: string): AdjudicationRow | null {
  const row = db.prepare('SELECT * FROM adjudication WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return null;
  return {
    id: String(row['id']),
    kind: String(row['kind']) as AdjKind,
    factIds: JSON.parse(String(row['fact_ids'])) as string[],
    decidedBy: String(row['decided_by']),
    decidedAt: String(row['decided_at']),
    outcome: (row['outcome'] as AdjOutcome | null) ?? null,
    outcomeAt: (row['outcome_at'] as string | null) ?? null,
    outcomeEvidence: (row['outcome_evidence'] as string | null) ?? null,
  };
}

/** 窗口内已登记的裁决数（会话摘要的"冲突"口径，详设 §8.2） */
export function countDecidedBetween(db: Db, from: string, to: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM adjudication WHERE decided_at >= ? AND decided_at <= ?')
    .get(from, to) as { n: number };
  return row.n;
}

/**
 * `fact_ids` 做 LIKE 子串匹配：`%` / `_` / `\` 是 LIKE 元字符，fact id 里带 `_`，
 * 不转义就会把 `f_a_b` 匹配到 `f_aXb`。转义后按字面量比较。
 */
function likeContains(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * 互斥对最近一次裁决（归档"冲突与裁决"段用）。
 *
 * `fact_ids` 的落库顺序有两种口径：I-49 起 `openAdjudicationOnce` 保留传入原序
 * （mutex 的 winner/loser 顺序必须留着判 favored），此前是排序后的 JSON。同一对事实
 * 只有两种排列，原序 + 反向两个 LIKE 模式即可同时命中两代存储，历史归档不回归。
 */
export function findMutexWin(db: Db, factIds: readonly string[]): { decidedBy: string; decidedAt: string } | null {
  const forward = likeContains(JSON.stringify(factIds));
  const backward = likeContains(JSON.stringify([...factIds].reverse()));
  const row = db
    .prepare(
      `SELECT decided_by, decided_at FROM adjudication
        WHERE kind = 'mutex_win' AND (fact_ids LIKE ? ESCAPE '\\' OR fact_ids LIKE ? ESCAPE '\\')
        ORDER BY decided_at DESC LIMIT 1`,
    )
    .get(forward, backward) as { decided_by: string; decided_at: string } | undefined;
  if (row === undefined) return null;
  return { decidedBy: row.decided_by, decidedAt: row.decided_at };
}

/** 某条事实参与且尚未回填 outcome 的裁决（写入侧据此判断"新观测是否发生在这个裁决上"） */
export interface OpenAdjudicationRef {
  id: string;
  kind: AdjKind;
  factIds: string[];
  /** 规则名@版本；判 `mutex_win` 的 favored 是否可信时要用（见 favoredFactId） */
  decidedBy: string;
}

export function listOpenAdjudicationsForFact(db: Db, factId: string): OpenAdjudicationRef[] {
  const rows = db
    .prepare(
      `SELECT id, kind, fact_ids, decided_by FROM adjudication
        WHERE outcome IS NULL AND fact_ids LIKE ? ESCAPE '\\'
        ORDER BY decided_at ASC, id ASC`,
    )
    .all(likeContains(`"${factId}"`)) as { id: string; kind: string; fact_ids: string; decided_by: string }[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as AdjKind,
    factIds: parseFactIds(row.fact_ids),
    decidedBy: row.decided_by,
  }));
}

/**
 * `mutex_win` 的 favored 只对**有序标记版本**成立：I-49 起 `openAdjudicationOnce` 保留
 * 传入顺序（`[0]=winner`），写入方用 `@2` 标记；此前的行按排序 JSON 落库，顺序已丢。
 * 对旧行猜 `[0]` 会把真 loser 误当 favored（误写 upheld/overturned），所以一律不敢猜。
 */
export const MUTEX_FAVORED_DECIDED_BY = 'mutex_by_confidence@2';

/**
 * 裁决的 "favored fact"：规则在 t 时刻实际押注的那条事实。
 * - `mutex_win`：仅当 `decidedBy` 是有序标记版本 `@2` 才取 `factIds[0]`（winner）；
 *   `@1`/legacy 行顺序已丢 → null（保持 open，不猜）；`decidedBy` 未提供时保留旧行为
 *   （兼容只关心位置的单测直调）。
 * - `temporal_invalidate`：`factIds[0]=旧值 / [1]=新值`，规则"保留新值"→ `[1]`；
 * - `dependency_hold`：当前无生产者，没有 favored 概念，返回 null。
 *
 * 只有 favored 被再次观测（upheld）或被后续新值失效（overturned）才写 outcome；
 * 非 favored 的刷新/失效证据不足，保持 open。
 */
export function favoredFactId(row: { kind: AdjKind; factIds: readonly string[]; decidedBy?: string }): string | null {
  switch (row.kind) {
    case 'mutex_win':
      if (row.decidedBy !== undefined && row.decidedBy !== MUTEX_FAVORED_DECIDED_BY) return null;
      return row.factIds[0] ?? null;
    case 'temporal_invalidate':
      return row.factIds[1] ?? null;
    case 'dependency_hold':
      return null;
  }
}

/** 按规则统计推翻率——比六项图质量指标更直接地反映"符号规则自身质量" */
export function overturnRateByRule(db: Db): { decidedBy: string; total: number; overturned: number; rate: number }[] {
  const rows = db
    .prepare(
      `SELECT decided_by AS decidedBy,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'overturned' THEN 1 ELSE 0 END) AS overturned
         FROM adjudication
        WHERE outcome IS NOT NULL
        GROUP BY decided_by
        ORDER BY decided_by`,
    )
    .all() as { decidedBy: string; total: number; overturned: number }[];
  return rows.map((r) => ({ ...r, rate: r.total === 0 ? 0 : r.overturned / r.total }));
}
