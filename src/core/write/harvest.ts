/**
 * 写入闭环的落库部分（详设 §2.8 幂等矩阵）。
 *
 * 四种情形必须严格区分，因为它们的副作用完全不同：
 *
 * | 情形 | 判定 | 动作 |
 * |---|---|---|
 * | A 全新 | 身份键无行 | 插入 |
 * | B 完全重复 | 有行且未失效 | 不新建，刷新 + 抬置信 + 记审计 |
 * | C 复活 | 有行但已失效 | **不复活旧行**，插新行 + supersedes |
 * | D 不同取值 | 同身份键、不同 value_hash | 按基数性：单值收口 / 序列并存 |
 *
 * 情形 C 特别容易写错：触发器禁止把 `valid_to` 改回 NULL，
 * 所以"复活"只能是新行——这也是"追加式失效"这个名字的由来。
 */
import type { Cardinality, ConfSource, EntityType, Ftype } from '../../domain/enums.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Fact } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as edgeRepo from '../../infra/sqlite/edgeRepo.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import { applyConflictPolicy, cardinalityOf, type ConflictResult, type OntologyHint } from './conflict.js';
import { mergeOnReobserve, type Priors, DEFAULT_PRIORS } from './confidence.js';
import { buildIdentity } from './identity.js';
import { resolveEntity, type IdentityState, type ResolveDeps } from './resolve.js';

export type UpsertOutcome = 'created' | 'refreshed' | 'recreated' | 'superseded' | 'coexist';

export interface FactDraft {
  subject: string;
  etype: EntityType;
  predicate: string;
  /** 已脱敏的取值（脱敏在解析之后、落库之前，见 §1.6） */
  value: unknown;
  content: string;
  ftype?: Ftype;
  confidence: number;
  confidenceSource: ConfSource;
  scope?: string;
  validAt?: string;
  sourceEpisode?: string | null;
  ext?: Record<string, unknown>;
  importance?: number;
  strength?: number;
  /** 已登记的基数性（来自 ontology 表）；不传则按谓词白名单推断 */
  cardinality?: Cardinality | null;
}

export interface UpsertResult {
  outcome: UpsertOutcome;
  factId: string;
  entityId: string;
  identity: IdentityState;
  conflict: ConflictResult;
}

export interface UpsertDeps extends ResolveDeps {
  priors?: Priors;
  ontology?: (predicate: string) => OntologyHint | null;
}

function draftToFact(
  draft: FactDraft,
  parts: {
    id: string;
    entityId: string;
    entityName: string;
    canonicalKey: string;
    valueHash: string;
    predicate: string;
    scope: string;
    ts: string;
  },
): Fact {
  return {
    id: parts.id,
    content: draft.content,
    ftype: draft.ftype ?? 'semantic',
    confidence: draft.confidence,
    confidenceSource: draft.confidenceSource,
    strength: draft.strength ?? 0.5,
    importance: draft.importance ?? 0.5,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs: {
      frozen: {
        subject: { entity_id: parts.entityId, name: parts.entityName },
        predicate: parts.predicate,
        value: draft.value,
      },
      ext: draft.ext ?? {},
    },
    canonicalKey: parts.canonicalKey,
    valueHash: parts.valueHash,
    scope: parts.scope,
    supersededBy: null,
    validAt: draft.validAt ?? parts.ts,
    validTo: null,
    recordedAt: parts.ts,
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: parts.ts,
    sourceEpisode: draft.sourceEpisode ?? null,
    span: null,
    createdAt: parts.ts,
    updatedAt: parts.ts,
  };
}

export function upsertFact(db: Db, draft: FactDraft, deps: UpsertDeps = {}): UpsertResult {
  const priors = deps.priors ?? DEFAULT_PRIORS;
  const scope = draft.scope ?? 'global';
  const ts = nowIso();

  return withTransaction(db, () => {
    const resolved = resolveEntity(
      db,
      { subject: draft.subject, etype: draft.etype, scope, ts },
      deps,
    );
    const identity = buildIdentity({
      scope,
      entityId: resolved.entity.id,
      predicate: draft.predicate,
      value: draft.value,
    });

    const existing = factRepo.findByIdentity(db, identity.canonicalKey, scope, identity.valueHash);
    const parts = {
      id: newId('fact'),
      entityId: resolved.entity.id,
      entityName: resolved.canonicalName,
      canonicalKey: identity.canonicalKey,
      valueHash: identity.valueHash,
      predicate: identity.predicate,
      scope,
      ts,
    };
    const emptyConflict: ConflictResult = {
      invalidated: [],
      supersedesEdges: [],
      mutexEdges: [],
      coOccurEdges: [],
      adjudications: [],
    };

    // ---- 情形 B：完全重复 ----
    if (existing !== null && existing.validTo === null) {
      factRepo.refreshRecordedAt(db, existing.id, ts);
      factRepo.touchAccess(db, [existing.id], ts);
      const merged = mergeOnReobserve(
        { value: existing.confidence, source: existing.confidenceSource },
        { value: draft.confidence, source: draft.confidenceSource },
        priors,
      );
      if (merged.changed) {
        factRepo.setConfidence(db, existing.id, {
          value: merged.value,
          source: merged.source,
          reason: merged.reason,
          ts,
        });
      }
      return {
        outcome: 'refreshed',
        factId: existing.id,
        entityId: resolved.entity.id,
        identity: resolved.identity,
        conflict: emptyConflict,
      };
    }

    // ---- 情形 C：复活（旧行已失效，插新行 + supersedes） ----
    if (existing !== null && existing.validTo !== null) {
      const fact = draftToFact(draft, parts);
      factRepo.insertFact(db, fact);
      edgeRepo.insertEdge(db, {
        id: newId('edge'),
        src: existing.id,
        dst: fact.id,
        etype: 'supersedes',
        validAt: fact.validAt,
      });
      return {
        outcome: 'recreated',
        factId: fact.id,
        entityId: resolved.entity.id,
        identity: resolved.identity,
        conflict: emptyConflict,
      };
    }

    // ---- A / D：新取值 ----
    const siblings = factRepo
      .listByIdentityKey(db, identity.canonicalKey, scope)
      .filter((s) => s.validTo === null && s.valueHash !== identity.valueHash);

    // 优先级：ontology 登记 > 草稿显式指定 > 谓词白名单默认
    const ontologyHint = deps.ontology?.(identity.predicate) ?? null;
    const card = cardinalityOf(
      identity.predicate,
      ontologyHint ?? (draft.cardinality === undefined ? null : { cardinality: draft.cardinality }),
    );
    const fact = draftToFact(draft, parts);
    factRepo.insertFact(db, fact);

    if (siblings.length === 0) {
      return {
        outcome: 'created',
        factId: fact.id,
        entityId: resolved.entity.id,
        identity: resolved.identity,
        conflict: emptyConflict,
      };
    }

    const conflict = applyConflictPolicy(db, fact, card);
    return {
      outcome: card === 'single-valued' ? 'superseded' : 'coexist',
      factId: fact.id,
      entityId: resolved.entity.id,
      identity: resolved.identity,
      conflict,
    };
  });
}
