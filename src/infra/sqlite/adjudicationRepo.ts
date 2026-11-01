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
