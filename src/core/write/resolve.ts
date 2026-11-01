/**
 * 实体消解（详设 §5.5 / 概设 §3.6.1）。
 *
 * 三级顺序不能调换：
 *   1. 规则级（规范化 + 精确匹配）—— 覆盖 90% 的情况，零成本；
 *   2. 向量级（相似度）—— **只建 alias，不合并**。合并是不可逆操作，交给人工；
 *   3. provisional —— 规范化失败也必须有实体，否则 `canonical_key` 为空，
 *      幂等索引形同不存在，每次 harvest 都会新建一行。
 *
 * 向量级在 P0 阶段没有实现（embedding 是 Phase 1 的事），但接口留好了：
 * 传入 `vectorResolver` 就启用，不传就跳过。
 */
import type { EntityType } from '../../domain/enums.js';
import type { Entity } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as entityRepo from '../../infra/sqlite/entityRepo.js';
import { nowIso } from '../../domain/time.js';
import { normalizeSubject } from '../parse/normalizers.js';

export type ResolveLevel = 'rule' | 'vector' | 'provisional';
export type IdentityState = 'resolved' | 'unresolved';

export interface ResolveInput {
  /** 原文主体，如 "Node.js" / ":8080" / "/usr/bin/node" */
  subject: string;
  etype: EntityType;
  scope?: string;
  ts?: string;
}

export interface ResolveResult {
  entity: Entity;
  /** 本次是否新建了实体（向量级只在新建时触发） */
  created: boolean;
  level: ResolveLevel;
  /** 进证据包时体现：unresolved 的事实要标出来，别让 Agent 以为它已确认 */
  identity: IdentityState;
  /** 规范化后的名字；provisional 时等于去空白后的原文 */
  canonicalName: string;
}

/** 向量级钩子（Phase 1 注入）。返回命中的实体与相似度，不做任何写操作 */
export type VectorResolver = (
  subject: string,
  etype: EntityType,
) => { entityId: string; similarity: number } | null;

export interface ResolveDeps {
  vectorResolver?: VectorResolver;
  /** 相似度 ≥ 此值建 alias；以下走人工队列（详设 §5.5 第 2 级） */
  vectorThreshold?: number;
  vectorQueueLow?: number;
}

function followMerge(db: Db, entity: Entity): Entity {
  let current = entity;
  const seen = new Set<string>();
  while (current.mergedInto !== null) {
    if (seen.has(current.id)) break; // 防御：合并链成环时不死循环
    seen.add(current.id);
    const next = entityRepo.getEntity(db, current.mergedInto);
    if (next === null) break;
    current = next;
  }
  return current;
}

export function resolveEntity(
  db: Db,
  input: ResolveInput,
  deps: ResolveDeps = {},
): ResolveResult {
  const scope = input.scope ?? 'global';
  const ts = input.ts ?? nowIso();
  const raw = input.subject.trim();

  // ---- 第 1 级：规则 ----
  const name = normalizeSubject(raw, input.etype);
  if (name !== null) {
    const found = entityRepo.findByCanonical(db, name, input.etype, scope);
    if (found !== null) {
      const entity = followMerge(db, found);
      entityRepo.addAlias(db, { alias: raw, entityId: entity.id, source: 'rule', confidence: 1.0, ts });
      return {
        entity,
        created: false,
        level: 'rule',
        identity: 'resolved',
        canonicalName: name,
      };
    }

    const created = entityRepo.insertEntity(db, { canonicalName: name, etype: input.etype, scope, ts });
    entityRepo.addAlias(db, { alias: raw, entityId: created.id, source: 'rule', confidence: 1.0, ts });

    // ---- 第 2 级：向量（只建 alias，不合并） ----
    const vectorHit = deps.vectorResolver?.(raw, input.etype) ?? null;
    if (vectorHit !== null && vectorHit.entityId !== created.id) {
      const high = deps.vectorThreshold ?? 0.92;
      const low = deps.vectorQueueLow ?? 0.6;
      if (vectorHit.similarity >= high) {
        entityRepo.addAlias(db, {
          alias: raw,
          entityId: vectorHit.entityId,
          source: 'vector',
          confidence: vectorHit.similarity,
          ts,
        });
      } else if (vectorHit.similarity >= low) {
        // 进人工队列的数据由 P2-07 的队列读 alias.source='vector' 且低置信的记录
        entityRepo.addAlias(db, {
          alias: raw,
          entityId: vectorHit.entityId,
          source: 'vector',
          confidence: vectorHit.similarity,
          ts,
        });
      }
    }

    return {
      entity: created,
      created: true,
      level: 'rule',
      identity: 'resolved',
      canonicalName: name,
    };
  }

  // ---- 第 3 级：provisional ----
  const provisional = entityRepo.ensureProvisional(db, raw, ts);
  entityRepo.addAlias(db, {
    alias: raw,
    entityId: provisional.id,
    source: 'rule',
    confidence: 0.5,
    ts,
  });
  return {
    entity: provisional,
    created: false,
    level: 'provisional',
    identity: 'unresolved',
    canonicalName: raw,
  };
}
