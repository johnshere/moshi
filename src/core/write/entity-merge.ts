/**
 * 实体合并（P2-19A-09，概设 §8.1 / 详设 §10.5）。
 *
 * 为什么不是「UPDATE fact SET entity_id=...」：
 * - `fact` 没有 entity_id 列，实体归属在 `attrs.frozen.subject.entity_id`；
 * - `attrs.frozen` 有 I2 触发器，合并不能改写历史事实的归属（append-only）。
 *
 * 因此合并的实际语义是：
 * 1. loser 实体行写 `merged_into=winner`（不物理删除），写入期消解走
 *    `resolveEntity → followMerge` 自动归到 winner；
 * 2. loser 名下的 `canonical_key` 按 winner 重算（canonical_key 是独立列，
 *    不受 I2 约束），后续按身份键的查询/去重都归到 winner；
 * 3. 别名改指 winner；
 * 4. 若 loser 与 winner 存在**完全重复**（同 key + 同 value_hash）的活跃事实，
 *    保留 winner 行，loser 行按生命周期收口（valid_to + superseded_by），
 *    不物理删除。
 *
 * 冲突（同谓词不同 value_hash）只列出、不自动裁决，`conflicts_resolved` 恒为 0。
 *
 * 不可撤销口径：撤销需要把每条事实的 canonical_key、valid_to、superseded_by 与
 * 别名归属整体回滚，当前 op 存储（`routes/batch.ts` 的 30s 快照）不覆盖实体改判；
 * 本接口明确返回 `undoable:false`，不签发伪 op_id。
 */
import { MoshiError } from '../../domain/errors.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as auditRepo from '../../infra/sqlite/auditRepo.js';
import * as entityRepo from '../../infra/sqlite/entityRepo.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import { communityRev } from '../../infra/sqlite/communityRepo.js';
import { setMeta } from '../../infra/sqlite/metaRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import { buildIdentity } from './identity.js';

export interface EntityMergeSide {
  entity_id: string;
  canonical_name: string;
  etype: string;
  /** 直接挂在实体名下的活跃事实数（合并前预览；列表接口会用归并后计数） */
  fact_count: number;
  /** 与该实体事实相连的活跃边数 */
  edge_count: number;
  alias_count: number;
}

export interface EntityMergeConflict {
  predicate: string;
  from: { fact_id: string; value_hash: string; value: unknown };
  to: { fact_id: string; value_hash: string; value: unknown };
}

export interface EntityMergePreview {
  from: EntityMergeSide;
  to: EntityMergeSide;
  conflicts: EntityMergeConflict[];
  will_move: { facts: number; edges: number; aliases: number };
  can_merge: boolean;
  blocking_reason?: string;
}

export interface MergeEntitiesResult {
  ok: true;
  from: EntityMergeSide;
  to: EntityMergeSide;
  moved_facts: number;
  /** edge 两端是 fact.id，没有实体列；事实改判不移动边 */
  moved_edges: number;
  merged_aliases: number;
  /** 与 winner 完全重复、按生命周期收口的 loser 行数 */
  deduped_facts: number;
  conflicts_resolved: 0;
  undoable: false;
  undo_reason: string;
}

export interface MergeEntitiesInput {
  fromId: string;
  toId: string;
  now?: string;
}

function requireEntity(db: Db, id: string, which: 'from' | 'to') {
  const entity = entityRepo.getEntity(db, id);
  if (entity === null) {
    throw new MoshiError('E_NOT_FOUND', `实体不存在：${id}`, {
      reason: 'entity_not_found',
      which,
      entity_id: id,
    });
  }
  return entity;
}

function checkMergeable(db: Db, fromId: string, toId: string) {
  if (fromId === toId) {
    throw new MoshiError('E_INPUT', '不能把实体合并到自身', {
      reason: 'same_entity',
      entity_id: fromId,
    });
  }
  const from = requireEntity(db, fromId, 'from');
  const to = requireEntity(db, toId, 'to');
  if (from.etype !== to.etype) {
    throw new MoshiError(
      'E_INPUT',
      `etype 不同禁止合并：${from.etype} vs ${to.etype}（未提供 allow_etype_mismatch）`,
      { reason: 'etype_mismatch', from_etype: from.etype, to_etype: to.etype },
    );
  }
  return { from, to };
}

function sideOf(db: Db, entity: ReturnType<typeof requireEntity>): EntityMergeSide {
  return {
    entity_id: entity.id,
    canonical_name: entity.canonicalName,
    etype: entity.etype,
    fact_count: entityRepo.countActiveFactsForEntity(db, entity.id),
    edge_count: entityRepo.countActiveEdgesForEntity(db, entity.id),
    alias_count: entityRepo.countAliasesForEntity(db, entity.id),
  };
}

/** 活跃事实：valid_to 为空且状态为 active（disputed 不参与冲突预览） */
function isActiveFact(fact: entityRepo.EntityFactForMerge): boolean {
  return fact.validTo === null && fact.epistemicStatus === 'active';
}

/**
 * 合并后同一 predicate 下两实体各持不同取值 → 需要人工裁决的冲突。
 * 这里按 predicate 分组做笛卡尔积，不同 value_hash 才列出。
 */
function findConflicts(
  fromFacts: readonly entityRepo.EntityFactForMerge[],
  toFacts: readonly entityRepo.EntityFactForMerge[],
): EntityMergeConflict[] {
  const fromActive = fromFacts.filter(isActiveFact);
  const toActive = toFacts.filter(isActiveFact);
  const conflicts: EntityMergeConflict[] = [];
  for (const f of fromActive) {
    for (const t of toActive) {
      if (f.predicate !== t.predicate) continue;
      if (f.valueHash === t.valueHash) continue;
      conflicts.push({
        predicate: f.predicate,
        from: { fact_id: f.factId, value_hash: f.valueHash, value: f.value },
        to: { fact_id: t.factId, value_hash: t.valueHash, value: t.value },
      });
    }
  }
  return conflicts;
}

export function previewEntityMerge(db: Db, input: { fromId: string; toId: string }): EntityMergePreview {
  const { from, to } = checkMergeable(db, input.fromId, input.toId);
  const fromFacts = entityRepo.listEntityFactsForMerge(db, from.id);
  const toFacts = entityRepo.listEntityFactsForMerge(db, to.id);
  const conflicts = findConflicts(fromFacts, toFacts);

  let canMerge = true;
  let blockingReason: string | undefined;
  if (from.mergedInto !== null && from.mergedInto === to.id) {
    canMerge = false;
    blockingReason = 'already_merged';
  } else if (from.mergedInto !== null) {
    canMerge = false;
    blockingReason = 'from_already_merged';
  } else if (to.mergedInto !== null) {
    canMerge = false;
    blockingReason = 'to_already_merged';
  }

  return {
    from: sideOf(db, from),
    to: sideOf(db, to),
    conflicts,
    will_move: {
      facts: fromFacts.length,
      edges: entityRepo.countActiveEdgesForEntity(db, from.id),
      aliases: entityRepo.countAliasesForEntity(db, from.id),
    },
    can_merge: canMerge,
    ...(blockingReason === undefined ? {} : { blocking_reason: blockingReason }),
  };
}

export function mergeEntities(db: Db, input: MergeEntitiesInput): MergeEntitiesResult {
  const { from, to } = checkMergeable(db, input.fromId, input.toId);
  const ts = input.now ?? nowIso();

  // 幂等：已经合并到同一个 winner → 成功返回 0 变更，不再写任何行
  if (from.mergedInto === to.id) {
    return {
      ok: true,
      from: sideOf(db, from),
      to: sideOf(db, to),
      moved_facts: 0,
      moved_edges: 0,
      merged_aliases: 0,
      deduped_facts: 0,
      conflicts_resolved: 0,
      undoable: false,
      undo_reason: 'entity_merge_not_snapshotted',
    };
  }
  if (from.mergedInto !== null || to.mergedInto !== null) {
    throw new MoshiError('E_CONFLICT_IDENTITY', '实体已合并过，不能重复合并到不同目标', {
      reason: 'already_merged',
      from_merged_into: from.mergedInto,
      to_merged_into: to.mergedInto,
    });
  }

  const result = withTransaction(db, () => {
    const fromFacts = entityRepo.listEntityFactsForMerge(db, from.id);
    let movedFacts = 0;
    let dedupedFacts = 0;

    for (const fact of fromFacts) {
      let identity;
      try {
        identity = buildIdentity({
          scope: fact.scope,
          entityId: to.id,
          predicate: fact.predicate,
          value: fact.value,
        });
      } catch (err) {
        throw new MoshiError('E_CONFLICT_IDENTITY', `事实 ${fact.factId} 的身份键无法重算`, {
          reason: 'identity_rebuild_failed',
          fact_id: fact.factId,
          cause: (err as Error).message,
        });
      }

      // 完全重复：winner 侧已有同 key+value 的活跃行 → loser 行收口，不删
      const existing = factRepo.findByIdentity(
        db,
        identity.canonicalKey,
        fact.scope,
        identity.valueHash,
      );
      if (
        existing !== null &&
        existing.id !== fact.factId &&
        existing.validTo === null &&
        fact.validTo === null
      ) {
        entityRepo.closeFactAsDuplicate(db, fact.factId, existing.id, ts);
        dedupedFacts += 1;
        continue;
      }

      // 重算不改变 value_hash（值没动），只改主体身份键
      if (identity.canonicalKey !== fact.canonicalKey) {
        entityRepo.updateFactCanonicalKey(db, fact.factId, identity.canonicalKey, ts);
      }
      movedFacts += 1;
    }

    const mergedAliases = entityRepo.moveAliasesToEntity(db, from.id, to.id);
    entityRepo.markMerged(db, from.id, to.id);

    auditRepo.appendAudit(db, {
      tbl: 'entity',
      rowId: from.id,
      field: 'merge',
      before: {
        entity_id: from.id,
        canonical_name: from.canonicalName,
        etype: from.etype,
      },
      after: {
        from: from.id,
        to: to.id,
        moved_facts: movedFacts,
        moved_edges: 0,
        merged_aliases: mergedAliases,
        deduped_facts: dedupedFacts,
      },
      source: 'human',
      reason: 'entity.merge',
      ts,
    });

    // 社区划分依赖实体归并结果，推 community_rev 让 communityRunner 重算
    setMeta(db, 'community_rev', String(communityRev(db) + 1));

    return { movedFacts, mergedAliases, dedupedFacts };
  });

  return {
    ok: true,
    from: sideOf(db, from),
    to: sideOf(db, to),
    moved_facts: result.movedFacts,
    moved_edges: 0,
    merged_aliases: result.mergedAliases,
    deduped_facts: result.dedupedFacts,
    conflicts_resolved: 0,
    undoable: false,
    undo_reason: 'entity_merge_not_snapshotted',
  };
}
