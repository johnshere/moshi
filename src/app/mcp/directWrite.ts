/**
 * 直写闸门（P2-23 / 概设 §3.1.3 / 详设 §4.1.2）。
 *
 * `memory_annotate` 默认只入队——事实要经 harvest 六步才进图，这是"不让它写坏库"的
 * 第一层保险。但有些调用方（例如刚拿到用户确认的 Agent）需要"现在就落库"，
 * 并且边关系只有在事实已存在时才有意义。本模块提供这条窄路，四道闸一个都不能少：
 *
 * 1. **闸门**：`mcp.allow_direct_write = false` 时整批拒绝（`E_DIRECT_WRITE_DISABLED`），
 *    不回退成入队：静默降级会让调用方以为写成了。
 * 2. **类型白名单**：只允许「新事实」与 `co_occur` / `derived_from` 两类边。
 *    `depends_on` 是推理产物，直写会污染依赖图——扣进隔离区等审核；`supersedes`
 *    根本不在 schema enum 里，校验阶段就拒。
 * 3. **量级约束**：单批与每分钟双上限（`E_QUOTA`，带 `retryAfterMs`）。
 * 4. **可撤销**：整批打同一个 `batch_id`，撤销时边、事实、annotation 三样一起删，
 *    每条删除前写 audit——撤得掉，但要查得到。
 *
 * 不绕过校验：脱敏、结构性筛查、实体消解、身份与冲突判定全部照常走 `upsertFact`，
 * 与 harvest 是同一条落库路径，只是省掉了"排队等下一轮"。
 */
import { MoshiError } from '../../domain/errors.js';
import { newId } from '../../domain/ids.js';
import type { QuarantineReason } from '../../domain/enums.js';
import { nowIso } from '../../domain/time.js';
import type { Edge, Fact } from '../../domain/types.js';
import type { AnnotatePayload, UpsertResult } from '../../core/write/harvest.js';
import { upsertFact } from '../../core/write/harvest.js';
import { DEFAULT_QUARANTINE, enqueue, screen } from '../../core/write/quarantine.js';
import * as annotationRepo from '../../infra/sqlite/annotationRepo.js';
import * as auditRepo from '../../infra/sqlite/auditRepo.js';
import * as edgeRepo from '../../infra/sqlite/edgeRepo.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import { loadRegisteredKeys } from '../../infra/sqlite/ontologyRepo.js';
import {
  DIRECT_ORIGIN,
  countRecentDirect,
  listEdgesByBatch,
  listEdgesTouching,
  listFactsByBatch,
  markDirectFact,
  removeEdge,
  removeFact,
} from '../../infra/sqlite/directWriteRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import type { McpDeps } from './deps.js';
import type { AnnotateInput } from './schemas.js';

/**
 * 直写往哪儿写结果。定义在这里而不是 `annotate.ts`：annotate 依赖本模块，
 * 反向 import 会形成循环（`pnpm lint:deps` 会拦）。`AnnotateResult` 是它的别名。
 */
export interface DirectWriteCollector {
  accepted: string[];
  quarantined: { index: number; reason: QuarantineReason }[];
  rejected: { index: number; reason: string }[];
  batch_id?: string;
  edges?: string[];
}

type AnnotateFact = AnnotateInput['facts'][number];

/** 直写允许落边的类型（概设 §3.1.3①）。`depends_on` 不在此列——它要审核 */
const DIRECT_EDGE_WHITELIST = ['co_occur', 'derived_from'] as const;
type DirectEdgeType = (typeof DIRECT_EDGE_WHITELIST)[number];

/** 边权：共现是弱证据，派生关系是显式推理，两者不该同权 */
const EDGE_WEIGHT: Readonly<Record<DirectEdgeType, number>> = {
  co_occur: 0.5,
  derived_from: 0.9,
};

/** 调用方是否在要求直写：显式 `direct_write`，或带了边（边只对直写有意义） */
export function wantsDirectWrite(input: AnnotateInput): boolean {
  if (input.direct_write === true) return true;
  return input.facts.some((fact) => (fact.relations?.length ?? 0) > 0);
}

/**
 * 闸门 + 量级检查。**在写入之前**抛，保证"整批拒绝"而不是"写了一半才发现超限"。
 */
export function assertDirectWriteAllowed(deps: McpDeps, count: number): void {
  const mcp = deps.cfg.mcp;
  if (!mcp.allow_direct_write) {
    throw new MoshiError(
      'E_DIRECT_WRITE_DISABLED',
      '直写闸门未开：memory_annotate 只入队，事实由 harvest 合并进图。要立即落库请把 [mcp] allow_direct_write 设为 true',
      { config_key: 'mcp.allow_direct_write' },
    );
  }
  if (count > mcp.direct_write_batch_max) {
    throw new MoshiError(
      'E_QUOTA',
      `单批 ${count} 条超过直写上限 ${mcp.direct_write_batch_max} 条，请拆批`,
      { limit: mcp.direct_write_batch_max, actual: count, window: 'batch' },
    );
  }
  const since = new Date(Date.now() - 60_000).toISOString();
  const recent = countRecentDirect(deps.db, since);
  const total = recent + count;
  if (total > mcp.direct_write_per_minute_max) {
    throw new MoshiError(
      'E_QUOTA',
      `每分钟直写 ${total} 条超过上限 ${mcp.direct_write_per_minute_max} 条，请稍后重试`,
      {
        limit: mcp.direct_write_per_minute_max,
        actual: total,
        window: 'minute',
        recent,
      },
      60_000,
    );
  }
}

export interface DirectItem {
  index: number;
  fact: AnnotateFact;
  payload: AnnotatePayload;
  /** annotation 快照的去重键（与普通入队同算法，避免同一份内容重复留痕） */
  dedupKey: string;
}

type AnnotateRelation = NonNullable<AnnotateFact['relations']>[number];

function resolveEdgeTarget(
  db: McpDeps['db'],
  relation: AnnotateRelation,
  scope: string,
): string | null {
  const factId = relation.to_fact_id;
  if (factId !== undefined) {
    const target = factRepo.getFact(db, factId);
    if (target !== null && target.validTo === null) return target.id;
  }
  const key = relation.to_key;
  if (key === undefined) return null;
  const byKey = factRepo.listByIdentityKey(db, key, scope);
  const activeByKey = byKey.find((fact) => fact.validTo === null);
  if (activeByKey !== undefined) return activeByKey.id;
  const byName = factRepo.findActiveBySubjectName(db, key, scope);
  return byName[0]?.id ?? null;
}

/**
 * 执行一批直写。调用前必须已过 `assertDirectWriteAllowed`（`runMemoryAnnotate` 负责）。
 * 返回批次号，结果写进调用方传进来的 `result`（保留入参顺序）。
 */
export function runDirectWrite(
  deps: McpDeps,
  input: AnnotateInput,
  items: readonly DirectItem[],
  result: DirectWriteCollector,
): string {
  const batchId = newId('batch');
  const mark = {
    sessionId: input.session_id ?? null,
    turn: input.turn ?? null,
    batchId,
  };
  const reviewFlagged = new Set<number>();
  const edges: string[] = [];
  // 已登记 schema 每批只读一次；直写与 harvest 共用同一套校验 + 待晋升记录
  const schema = loadRegisteredKeys(deps.db);

  withTransaction(deps.db, () => {
    for (const { index, fact, payload, dedupKey } of items) {
      const screened = screen(
        { content: payload.content, value: payload.value, confidence: 1 },
        {
          ...DEFAULT_QUARANTINE,
          maxContentBytes: deps.cfg.ingest.max_fact_bytes,
          minConfidence: 0,
        },
      );
      if (!screened.accepted) {
        enqueue(deps.db, screened.reason ?? 'too_long', {
          content: payload.content,
          value: payload.value,
          confidence: payload.confidence ?? 0.55,
          subject: payload.subject,
          predicate: payload.predicate,
          detail: { channel: 'annotate', index, direct: true, batch: batchId },
        });
        result.quarantined.push({ index, reason: screened.reason ?? 'too_long' });
        continue;
      }

      // 与 harvest 同一条落库路径：实体消解、身份、生命周期字段都不跳过。
      // 但冲突裁决必须听白名单的：单值谓词换值会失效既有事实、还会建 supersedes /
      // mutually_exclusive 边，两者都在直写白名单外（且撤销不了旧事实的失效）。
      // 所以这里 blockOnConflict 把裁决抛回来，整条扣进隔离区，历史交给调用方。
      let upsert: UpsertResult;
      try {
        upsert = upsertFact(
          deps.db,
          {
            subject: payload.subject,
            etype: payload.etype,
            predicate: payload.predicate,
            value: payload.value,
            content: payload.content,
            confidence: payload.confidence ?? 0.55,
            confidenceSource: 'llm_claim',
            ftype: payload.ftype ?? 'semantic',
            ...(payload.scope === undefined ? {} : { scope: payload.scope }),
            ...(payload.validAt === undefined ? {} : { validAt: payload.validAt }),
            ...(payload.sourceEpisode === undefined ? {} : { sourceEpisode: payload.sourceEpisode }),
            ...(payload.importance === undefined ? {} : { importance: payload.importance }),
          },
          { blockOnConflict: true, schema },
        );
      } catch (err) {
        if (!(err instanceof MoshiError) || err.code !== 'E_CONFLICT_IDENTITY') throw err;
        enqueue(deps.db, 'conflict_needs_review', {
          content: payload.content,
          value: payload.value,
          confidence: payload.confidence ?? 0.55,
          subject: payload.subject,
          predicate: payload.predicate,
          detail: {
            channel: 'annotate',
            index,
            direct: true,
            batch: batchId,
            ...(err.detail ?? {}),
          },
        });
        result.quarantined.push({ index, reason: 'conflict_needs_review' });
        continue;
      }
      result.accepted.push(upsert.factId);

      // refreshed 是复用旧行：给它打批次号会让撤销删掉历史事实，所以只标新建的行
      if (upsert.outcome !== 'refreshed') {
        markDirectFact(deps.db, upsert.factId, mark);
      }

      // 队列快照：直写的行不受 harvest 管辖（立刻标成已消费），撤销时整批删
      const snapshot = annotationRepo.insert(deps.db, {
        dedupKey,
        payloadJson: JSON.stringify(payload),
        channel: 'annotate',
        origin: DIRECT_ORIGIN,
        batchId,
      });
      if (snapshot.created) annotationRepo.markHarvested(deps.db, snapshot.id);

      for (const relation of fact.relations ?? []) {
        if (relation.etype === 'depends_on') {
          // 推理产物不落边：扣进隔离区，等人或后续审核提升
          if (!reviewFlagged.has(index)) {
            reviewFlagged.add(index);
            result.quarantined.push({ index, reason: 'needs_review' });
          }
          enqueue(deps.db, 'needs_review', {
            content: payload.content,
            value: relation.note ?? payload.value,
            confidence: payload.confidence ?? 0.55,
            subject: payload.subject,
            predicate: payload.predicate,
            detail: {
              channel: 'annotate',
              index,
              batch: batchId,
              direct: true,
              etype: relation.etype,
              to_fact_id: relation.to_fact_id ?? null,
              to_key: relation.to_key ?? null,
            },
          });
          continue;
        }
        if (!isDirectEdgeType(relation.etype)) continue;

        const targetId = resolveEdgeTarget(deps.db, relation, payload.scope ?? 'global');
        if (targetId === null) {
          result.rejected.push({ index, reason: 'edge_target_not_found' });
          continue;
        }
        if (targetId === upsert.factId) continue; // self-edge 触发 CHECK，直接跳过
        if (edgeRepo.findActiveEdge(deps.db, upsert.factId, targetId, relation.etype) !== null) {
          continue;
        }
        const edgeId = newId('edge');
        edgeRepo.insertEdge(deps.db, {
          id: edgeId,
          src: upsert.factId,
          dst: targetId,
          etype: relation.etype,
          weight: EDGE_WEIGHT[relation.etype],
          confidence: payload.confidence ?? 0.55,
          validAt: nowIso(),
          provenance: `mcp_direct:${relation.etype}`,
          batchId,
        });
        edges.push(edgeId);
      }
    }
  });

  if (edges.length > 0) result.edges = edges;
  result.batch_id = batchId;
  return batchId;
}

function isDirectEdgeType(etype: string): etype is DirectEdgeType {
  return (DIRECT_EDGE_WHITELIST as readonly string[]).includes(etype);
}

export interface RevokeResult {
  batchId: string;
  facts: string[];
  edges: string[];
  annotations: string[];
}

/**
 * 按批次整批撤销（概设 §3.1.3③）。
 *
 * 三样东西一起回滚：边（含**别的批次**写在这批事实端点上的边，不然外键会挡住删除）、
 * 事实（连同 fts / 向量 / 引用）、annotation 快照。每删一行先写 audit：
 * 撤销是允许的，但"谁撤销了哪一批"必须可查。
 *
 * 幂等：批次号不存在时返回三个空数组，不抛错——重复撤销不算故障。
 */
export function revokeDirectBatch(db: McpDeps['db'], batchId: string): RevokeResult {
  const facts = listFactsByBatch(db, batchId);
  const factIds = facts.map((fact) => fact.id);
  const edges = new Map<string, Edge>();
  for (const edge of listEdgesByBatch(db, batchId)) edges.set(edge.id, edge);
  for (const edge of listEdgesTouching(db, factIds)) edges.set(edge.id, edge);
  const annotations = annotationRepo.listByBatch(db, batchId);

  const out: RevokeResult = { batchId, facts: [], edges: [], annotations: [] };

  withTransaction(db, () => {
    for (const edge of edges.values()) {
      auditRepo.appendAudit(db, {
        tbl: 'edge',
        rowId: edge.id,
        before: edge,
        after: null,
        source: 'mcp_direct_revoke',
        reason: batchId,
      });
      removeEdge(db, edge.id);
      out.edges.push(edge.id);
    }
    for (const fact of facts) {
      auditRepo.appendAudit(db, {
        tbl: 'fact',
        rowId: fact.id,
        before: fact,
        after: null,
        source: 'mcp_direct_revoke',
        reason: batchId,
      });
      removeFact(db, fact.id);
      out.facts.push(fact.id);
    }
    for (const row of annotations) {
      auditRepo.appendAudit(db, {
        tbl: 'annotation',
        rowId: row.id,
        before: row,
        after: null,
        source: 'mcp_direct_revoke',
        reason: batchId,
      });
      annotationRepo.remove(db, row.id);
      out.annotations.push(row.id);
    }
  });

  return out;
}

/** 给 CLI / 测试用：批次里还剩什么（撤销前后对账） */
export function inspectBatch(
  db: McpDeps['db'],
  batchId: string,
): { facts: Fact[]; edges: Edge[]; annotations: number } {
  return {
    facts: listFactsByBatch(db, batchId),
    edges: listEdgesByBatch(db, batchId),
    annotations: annotationRepo.listByBatch(db, batchId).length,
  };
}

/** 直写路径可能新增的隔离原因，供调用方解释 `quarantined[].reason` */
export type DirectQuarantineReason = Extract<QuarantineReason, 'needs_review'>;
