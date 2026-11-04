/**
 * 社区维度读取（详设 §9.1 / §2.2；台账 P1-15、P1-10、P2-11）。
 *
 * edge 表没有 community_id，社区归属只能经两端 fact 关联——这些 JOIN 是数据库细节，
 * 收在 infra，core 只做选取阈值与渲染决策。
 *
 * P2-11 追加：图输入装载（`loadCommunityGraph` / `loadOldAssignment`）与划分结果
 * 写回（`applyCommunityAssignment` / `communityRev` / `bumpCommunityRev`）。
 * 写回必须经 `factRepo.setCommunity` 专用入口、放在事务里（progress P2-11 开工核查）；
 * `setCommunity` 不更新 `updated_at`、不推 `schema_rev`（DDL 只有 INSERT 触发器），
 * 符合"社区是派生投影"的语义——投影刷新不会反过来触发自身重算。
 */
import type { CommunityEdge, CommunityGraphInput } from '../../core/lifecycle/community.js';
import type { Fact } from '../../domain/types.js';
import type { Db } from './db.js';
import { setCommunity } from './factRepo.js';
import { rowToFact } from './mappers.js';
import { getMeta, setMeta } from './metaRepo.js';
import { withTransaction } from './tx.js';

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

// ────────────────────────────────────────────────────────────
// P2-11 社区划分：图输入装载与写回
// ────────────────────────────────────────────────────────────

/** 参与划分的活跃节点（只取 active/disputed，progress P2-11 开工核查口径），按 id 升序 */
export function loadCommunityNodes(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM fact
        WHERE epistemic_status IN ('active','disputed')
        ORDER BY id`,
    )
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

/** 活跃边：valid_to IS NULL 且两端都在参与集合内；按 (src,dst) 升序（确定性输入） */
export function loadCommunityEdges(db: Db): CommunityEdge[] {
  const rows = db
    .prepare(
      `SELECT e.src, e.dst, e.weight FROM edge e
         JOIN fact fs ON fs.id = e.src AND fs.epistemic_status IN ('active','disputed')
         JOIN fact fd ON fd.id = e.dst AND fd.epistemic_status IN ('active','disputed')
        WHERE e.valid_to IS NULL
        ORDER BY e.src, e.dst`,
    )
    .all() as { src: string; dst: string; weight: number }[];
  return rows.map((r) => ({ src: r.src, dst: r.dst, weight: r.weight }));
}

/** 社区划分图输入：节点 + 边（确定性排序） */
export function loadCommunityGraph(db: Db): CommunityGraphInput {
  const nodes = loadCommunityNodes(db);
  const edges = loadCommunityEdges(db);
  return { nodes, edges, oldAssignment: loadOldAssignment(db) };
}

/** 旧分配：fact_id → community_id（仅非空行；空 Map = 首次划分） */
export function loadOldAssignment(db: Db): Map<string, number> {
  const rows = db
    .prepare('SELECT id, community_id FROM fact WHERE community_id IS NOT NULL')
    .all() as { id: string; community_id: number }[];
  return new Map(rows.map((r) => [r.id, r.community_id]));
}

/**
 * 写回划分结果：单事务内只更新变化行 + 推进 `community_rev`，返回写入行数。
 * 专用入口 `setCommunity`，不新增裸 SQL 到 core；`community_rev` 与写回同事务，
 * 避免"写了一半版本没推进"的中间态。
 */
export function applyCommunityAssignment(
  db: Db,
  assignment: ReadonlyMap<string, number>,
): number {
  return withTransaction(db, () => {
    const current = db
      .prepare('SELECT id, community_id FROM fact')
      .all() as { id: string; community_id: number | null }[];
    const currentById = new Map(current.map((r) => [r.id, r.community_id]));
    let wrote = 0;
    for (const [factId, cid] of assignment) {
      if ((currentById.get(factId) ?? null) !== cid) {
        setCommunity(db, factId, cid);
        wrote += 1;
      }
    }
    // 只有实际发生变化才推进版本：无变化的重跑不该产生"新版本"
    if (wrote > 0) setMeta(db, 'community_rev', String(communityRev(db) + 1));
    return wrote;
  });
}

/** 当前 community_rev（未初始化按 0 处理） */
export function communityRev(db: Db): number {
  const raw = getMeta(db, 'community_rev');
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** dryRun 用的"将写入"行数：与库内当前值比较，不落库（lint:lifecycle：core/app 不得持 db 句柄） */
export function countCommunityChanges(
  db: Db,
  assignment: ReadonlyMap<string, number>,
): number {
  const current = db
    .prepare('SELECT id, community_id FROM fact')
    .all() as { id: string; community_id: number | null }[];
  const currentById = new Map(current.map((r) => [r.id, r.community_id]));
  let changed = 0;
  for (const [factId, cid] of assignment) {
    if ((currentById.get(factId) ?? null) !== cid) changed += 1;
  }
  return changed;
}
