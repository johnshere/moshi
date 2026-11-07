/**
 * 冲突检测与写入时裁决（详设 §5.7）。
 *
 * 最重要的一个判断是 **D9：默认 `set`，不默认 `single-valued`**。
 * 默认单值会让"磁盘用量""构建次数"这类观测序列每两条就成互斥对，互斥边爆炸，
 * 读取时还会把大量正常事实标成 disputed。漏报的代价是"Agent 看到两条并存"，
 * 误报的代价是"Agent 看到已被裁决的错误结论"——两者不对称，选漏报。
 *
 * 另一条：写入只**记录**裁决快照，不决定胜者。胜者在读取时按当前置信算（§6.6）——
 * 置信会变，写时算出的胜者会过期。
 */
import type { Cardinality } from '../../domain/enums.js';
import { newId } from '../../domain/ids.js';
import type { Fact } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as adjudicationRepo from '../../infra/sqlite/adjudicationRepo.js';
import * as edgeRepo from '../../infra/sqlite/edgeRepo.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';

/** 白名单谓词才默认单值；其余一律 set，等 schema infer 晋升（§8.5） */
export const DEFAULT_SINGLE_VALUED: ReadonlySet<string> = new Set([
  'installed_version',
  'runtime_version',
  'package_manager',
  'occupied_by',
  'git_branch',
  'git_head',
  'env_var',
  'build_result',
  'test_result',
]);

export interface OntologyHint {
  cardinality?: Cardinality | null;
}

export function cardinalityOf(predicate: string, ontology?: OntologyHint | null): Cardinality {
  const declared = ontology?.cardinality;
  if (declared !== undefined && declared !== null) return declared;
  return DEFAULT_SINGLE_VALUED.has(predicate) ? 'single-valued' : 'set';
}

export interface ConflictResult {
  invalidated: string[];
  supersedesEdges: string[];
  mutexEdges: string[];
  coOccurEdges: string[];
  adjudications: string[];
}

const empty = (): ConflictResult => ({
  invalidated: [],
  supersedesEdges: [],
  mutexEdges: [],
  coOccurEdges: [],
  adjudications: [],
});

function linkEdge(
  db: Db,
  src: string,
  dst: string,
  etype: 'supersedes' | 'mutually_exclusive' | 'co_occur',
  validAt: string,
  weight: number,
): string | null {
  if (src === dst) return null;
  if (edgeRepo.findActiveEdge(db, src, dst, etype) !== null) return null;
  const id = newId('edge');
  edgeRepo.insertEdge(db, { id, src, dst, etype, validAt, weight });
  return id;
}

/**
 * 对同身份的兄弟事实应用基数性策略。
 * **必须在目标事实已插入之后调用**：`superseded_by` 有外键，指向还不存在的行会失败。
 */
export function applyConflictPolicy(
  db: Db,
  target: Fact,
  cardinality: Cardinality,
): ConflictResult {
  const result = empty();
  if (cardinality === 'set') return result;

  const siblings = factRepo
    .listByIdentityKey(db, target.canonicalKey, target.scope)
    .filter((s) => s.id !== target.id && s.validTo === null);

  for (const s of siblings) {
    if (s.valueHash === target.valueHash) continue;

    if (cardinality === 'series') {
      const edgeId = linkEdge(db, s.id, target.id, 'co_occur', target.validAt, 0.5);
      if (edgeId !== null) result.coOccurEdges.push(edgeId);
      continue;
    }

    // single-valued：追加式失效 + 保留冲突证据
    factRepo.invalidate(db, s.id, { validTo: target.validAt, supersededBy: target.id });

    const sup = linkEdge(db, s.id, target.id, 'supersedes', target.validAt, 1.0);
    if (sup !== null) result.supersedesEdges.push(sup);

    const mutex = linkEdge(db, s.id, target.id, 'mutually_exclusive', target.validAt, 1.0);
    if (mutex !== null) result.mutexEdges.push(mutex);

    const adjId = adjudicationRepo.openAdjudication(db, {
      kind: 'temporal_invalidate',
      factIds: [s.id, target.id],
      decidedBy: 'single_valued_supersede@1',
      decidedAt: target.validAt,
    });
    result.adjudications.push(adjId);
    result.invalidated.push(s.id);
  }

  return result;
}

/** 包一层事务：插入 + 失效 + 建边 + 快照必须原子 */
export function applyConflictPolicyTx(db: Db, target: Fact, cardinality: Cardinality): ConflictResult {
  return withTransaction(db, () => applyConflictPolicy(db, target, cardinality));
}

// ---------------------------------------------------------------- I-49：outcome 回填
//
// `outcome` 的语义是"规则在 t 时刻的裁决，在 t' 时刻是否被新观测推翻"。
// 只有**写入侧的新观测**能回答这个问题，读取侧仍然只开裁决、不写 outcome：
//   - favored fact 被再次观测（case B refresh）      → upheld
//   - favored fact 被后续新值失效（case D invalidation）→ overturned
// 非 favored 的刷新/失效证据不足，保持 open；已 resolved 的裁决不覆盖（`outcome IS NULL`）。

/**
 * case B（完全重复 refresh）：若被再次观测的 fact 是某条 open 裁决的 favored，
 * 说明"留住它"的裁决被新观测证实 → `upheld`，`outcome_at` 用本次观测时刻。
 * 返回本次真实写入的条数（幂等重跑为 0）。
 */
export function resolveOutcomesForRefresh(db: Db, fact: Fact, ts: string): number {
  let written = 0;
  for (const row of adjudicationRepo.listOpenAdjudicationsForFact(db, fact.id)) {
    if (adjudicationRepo.favoredFactId(row) !== fact.id) continue;
    adjudicationRepo.resolveAdjudication(db, row.id, 'upheld', fact.id, ts);
    written += 1;
  }
  return written;
}

/**
 * case D（single-valued 新值失效旧值）：若被失效的 fact 是某条 open 裁决的 favored，
 * 说明规则押注的那条事实被后续新观测推翻 → `overturned`。
 *
 * evidence 用**新观测** `target.id`（推翻它的是这条新事实），`outcome_at` 用新观测的
 * `validAt` 而不是执行时刻——回填的历史时间线必须跟事实本身对齐。`ts` 只在 validAt
 * 缺省（空串）时兜底。
 * 返回本次真实写入的条数（幂等重跑为 0）。
 */
export function resolveOutcomesForInvalidation(
  db: Db,
  target: Fact,
  invalidatedIds: readonly string[],
  ts: string,
): number {
  const at = target.validAt === '' ? ts : target.validAt;
  let written = 0;
  for (const id of invalidatedIds) {
    for (const row of adjudicationRepo.listOpenAdjudicationsForFact(db, id)) {
      if (adjudicationRepo.favoredFactId(row) !== id) continue;
      adjudicationRepo.resolveAdjudication(db, row.id, 'overturned', target.id, at);
      written += 1;
    }
  }
  return written;
}
