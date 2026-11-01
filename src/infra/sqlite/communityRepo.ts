/**
 * 社区维度读取（详设 §9.1 / §2.2；台账 P1-15、P1-10）。
 *
 * edge 表没有 community_id，社区归属只能经两端 fact 关联——这些 JOIN 是数据库细节，
 * 收在 infra，core 只做选取阈值与渲染决策。
 */
import type { Db } from './db.js';
import { rowToFact } from './mappers.js';
import type { Fact } from '../../domain/types.js';

export interface TopicCandidateRow {
  communityId: number;
  label: string;
  factCount: number;
}

/** fact_count ≥ minFacts 的社区，按事实数降序；label 取 global 作用域的最新摘要 */
export function listTopicCandidates(db: Db, minFacts: number): TopicCandidateRow[] {
  const rows = db
    .prepare(
      `SELECT c.community_id,
              COALESCE(cs.label, '') AS label,
              c.fact_count
         FROM (SELECT community_id, COUNT(*) AS fact_count
                 FROM fact WHERE community_id IS NOT NULL
                 GROUP BY community_id) c
         LEFT JOIN community_summary cs
           ON cs.community_id = c.community_id AND cs.scope = 'global'
        WHERE c.fact_count >= ?
        ORDER BY c.fact_count DESC`,
    )
    .all(minFacts) as { community_id: number; label: string; fact_count: number }[];
  return rows.map((r) => ({ communityId: r.community_id, label: r.label, factCount: r.fact_count }));
}

export interface TopSummaryRow {
  communityId: number;
  label: string | null;
  summary: string;
  factCount: number;
  derivedAt: string;
  sourceRev: number;
}

/**
 * 全局路径的主题清单（详设 §6.10 第 1 步）：某 scope 下按事实数降序取前 N 条摘要。
 * `source_rev` 一起返回——调用方用它对比 `meta.schema_rev` 判摘要是否过期。
 */
export function listTopSummaries(db: Db, scope: string, limit: number): TopSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT community_id, label, summary, fact_count, derived_at, source_rev
         FROM community_summary
        WHERE scope = ?
        ORDER BY fact_count DESC, community_id ASC
        LIMIT ?`,
    )
    .all(scope, limit) as {
    community_id: number;
    label: string | null;
    summary: string;
    fact_count: number;
    derived_at: string;
    source_rev: number;
  }[];
  return rows.map((r) => ({
    communityId: r.community_id,
    label: r.label,
    summary: r.summary,
    factCount: r.fact_count,
    derivedAt: r.derived_at,
    sourceRev: r.source_rev,
  }));
}

/** 社区内参与 depends_on（活跃边）的事实数，用于依赖链完整度 */
export function countFactsWithDependency(db: Db, communityId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT n) AS n FROM (
         SELECT e.src AS n FROM edge e JOIN fact f ON f.id = e.src
          WHERE e.etype = 'depends_on' AND e.valid_to IS NULL AND f.community_id = ?
         UNION
         SELECT e.dst AS n FROM edge e JOIN fact f ON f.id = e.dst
          WHERE e.etype = 'depends_on' AND e.valid_to IS NULL AND f.community_id = ?
       )`,
    )
    .get(communityId, communityId) as { n: number };
  return row.n;
}

/** 社区内是否存在活跃 mutually_exclusive 边（归档入选的第二条件） */
export function hasMutexEdge(db: Db, communityId: number): boolean {
  const row = db
    .prepare(
      `SELECT e.id FROM edge e JOIN fact f ON f.id = e.src
        WHERE e.etype = 'mutually_exclusive' AND e.valid_to IS NULL AND f.community_id = ?
        LIMIT 1`,
    )
    .get(communityId) as { id: string } | undefined;
  return row !== undefined;
}

export function listFactsByCommunity(db: Db, communityId: number): Fact[] {
  const rows = db
    .prepare('SELECT * FROM fact WHERE community_id = ? ORDER BY valid_at ASC')
    .all(communityId) as Record<string, unknown>[];
  return rows.map((r) => rowToFact(r));
}

/** 社区内两端的 depends_on 活跃边（src→dst），供依赖链渲染 */
export function listDependencyPairs(db: Db, communityId: number, limit: number): { src: string; dst: string }[] {
  return db
    .prepare(
      `SELECT e.src, e.dst FROM edge e
         JOIN fact fs ON fs.id = e.src JOIN fact fd ON fd.id = e.dst
        WHERE e.etype = 'depends_on' AND e.valid_to IS NULL
          AND fs.community_id = ? AND fd.community_id = ?
        LIMIT ?`,
    )
    .all(communityId, communityId, limit) as { src: string; dst: string }[];
}

/** 社区内活跃 mutually_exclusive 边（以 src 侧归属社区） */
export function listMutexPairs(db: Db, communityId: number, limit: number): { src: string; dst: string }[] {
  return db
    .prepare(
      `SELECT e.src, e.dst FROM edge e
         JOIN fact fs ON fs.id = e.src
        WHERE e.etype = 'mutually_exclusive' AND e.valid_to IS NULL AND fs.community_id = ?
        LIMIT ?`,
    )
    .all(communityId, limit) as { src: string; dst: string }[];
}

export interface CommunitySummaryRow {
  label: string | null;
  summary: string;
  factCount: number;
  derivedAt: string;
}

/** 最新一条社区摘要（任何 scope，按 derived_at 倒序），证据包 topic_hint 用 */
export function getLatestSummary(db: Db, communityId: number): CommunitySummaryRow | null {
  const row = db
    .prepare(
      `SELECT label, summary, fact_count, derived_at FROM community_summary
        WHERE community_id = ? ORDER BY derived_at DESC LIMIT 1`,
    )
    .get(communityId) as
    | { label: string | null; summary: string; fact_count: number; derived_at: string }
    | undefined;
  if (row === undefined) return null;
  return { label: row.label, summary: row.summary, factCount: row.fact_count, derivedAt: row.derived_at };
}
