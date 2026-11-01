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
import { MoshiError } from '../../domain/errors.js';
import type { Cardinality, ConfSource, EntityType, Ftype } from '../../domain/enums.js';
import { newId } from '../../domain/ids.js';
import { nowIso } from '../../domain/time.js';
import type { Fact } from '../../domain/types.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as annotationRepo from '../../infra/sqlite/annotationRepo.js';
import type { AnnotationRow } from '../../infra/sqlite/annotationRepo.js';
import * as edgeRepo from '../../infra/sqlite/edgeRepo.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import { parseTurn } from '../parse/registry.js';
import { applyConflictPolicy, cardinalityOf, type ConflictResult, type OntologyHint } from './conflict.js';
import { mergeOnReobserve, type Priors, DEFAULT_PRIORS } from './confidence.js';
import { buildIdentity } from './identity.js';
import type { ToolTurnPayload } from './ingest.js';
import {
  DEFAULT_QUARANTINE,
  enqueue,
  screen,
  type QuarantineOptions,
  type QuarantinePayload,
} from './quarantine.js';
import { redactText, redactValue, type RedactOptions } from './redact.js';
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

// ---------------------------------------------------------------- harvest 六步

/**
 * 六步事务（详设 §5.10）：
 *
 * ```
 * 1. 取一批 harvested_at IS NULL 的 annotation（先进先出，默认 200 条）
 * 2. 逐条：脱敏 → 解析 → 筛（隔离区）→ 消解 → 身份 → 冲突 → 落库 → 标 harvested_at
 * 3. 一批一个事务；提交后 setImmediate 让出事件循环
 * 4. 结束：写 harvest.done 日志（由调用方打，core 只返回统计）
 * ```
 *
 * 三条容易写错的地方：
 *
 * - **一片一事务**：整批回滚是设计意图（崩溃重跑幂等），但**单条**出错不能连累整批，
 *   所以每条外面套 try/catch，失败的那条写 `annotation.error` 并**照样标 harvested_at**。
 *   否则一条毒数据会让 harvest 每轮都在它身上失败，队列永久堵死。
 * - **`content` 用截断后的版本**：`content` 不可变（触发器拦 UPDATE），截断只能发生在
 *   写入前；写进去之后再想截断就得删行重插，而删行会断掉所有指向它的边。
 * - **`source_episode` 必须带**：不带的话 §5.8.2 的"独立观测"永远判定为不独立，
 *   置信度永远停在先验上。
 */
export interface HarvestOptions {
  batchSize?: number;
  priors?: Priors;
  quarantine?: QuarantineOptions;
  redact?: RedactOptions;
  ontology?: (predicate: string) => OntologyHint | null;
  /** 片间是否让出事件循环；测试里关掉可以跑得更快（默认开） */
  yieldBetweenBatches?: boolean;
}

export interface HarvestResult {
  batches: number;
  scanned: number;
  created: number;
  refreshed: number;
  recreated: number;
  superseded: number;
  coexist: number;
  quarantined: number;
  skipped: number;
  failed: number;
  ms: number;
}

function emptyResult(): HarvestResult {
  return {
    batches: 0,
    scanned: 0,
    created: 0,
    refreshed: 0,
    recreated: 0,
    superseded: 0,
    coexist: 0,
    quarantined: 0,
    skipped: 0,
    failed: 0,
    ms: 0,
  };
}

interface HarvestContext {
  priors: Priors;
  quarantine: QuarantineOptions;
  redact: RedactOptions;
  ontology?: (predicate: string) => OntologyHint | null;
  ts: string;
}

/** 标注里 payload 的形状（R1 通道直接给一条草稿） */
export interface AnnotatePayload {
  subject: string;
  etype: EntityType;
  predicate: string;
  value: unknown;
  content: string;
  confidence?: number;
  confidenceSource?: ConfSource;
  ftype?: Ftype;
  scope?: string;
  validAt?: string;
  sourceEpisode?: string | null;
  importance?: number;
  ext?: Record<string, unknown>;
}

function quarantinePayload(
  draft: { content: string; value: unknown; confidence: number; subject: string; predicate: string },
  extra: Record<string, unknown>,
): QuarantinePayload {
  return {
    content: draft.content,
    value: draft.value,
    confidence: draft.confidence,
    subject: draft.subject,
    predicate: draft.predicate,
    detail: extra,
  };
}

/** 落一条已筛过的事实；返回落库结果 */
function writeOne(
  db: Db,
  ctx: HarvestContext,
  input: {
    subject: string;
    etype: EntityType;
    predicate: string;
    value: unknown;
    content: string;
    confidence: number;
    confidenceSource: ConfSource;
    ftype: Ftype;
    scope?: string;
    validAt?: string;
    sourceEpisode?: string | null;
    importance?: number;
    ext?: Record<string, unknown>;
  },
): UpsertResult {
  const draft: FactDraft = {
    subject: input.subject,
    etype: input.etype,
    predicate: input.predicate,
    value: input.value,
    content: input.content,
    confidence: input.confidence,
    confidenceSource: input.confidenceSource,
    ftype: input.ftype,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.validAt === undefined ? {} : { validAt: input.validAt }),
    ...(input.sourceEpisode === undefined ? {} : { sourceEpisode: input.sourceEpisode }),
    ...(input.importance === undefined ? {} : { importance: input.importance }),
    ...(input.ext === undefined ? {} : { ext: input.ext }),
  };
  return upsertFact(db, draft, {
    priors: ctx.priors,
    ...(ctx.ontology === undefined ? {} : { ontology: ctx.ontology }),
  });
}

/** 处理一条 annotation。抛错由调用方转成 `annotation.error` */
function applyAnnotation(db: Db, row: AnnotationRow, ctx: HarvestContext, stats: HarvestResult): void {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    throw new MoshiError('E_INPUT', `annotation payload 不是合法 JSON：${row.id}`, { id: row.id });
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MoshiError('E_INPUT', `annotation payload 不是对象：${row.id}`, { id: row.id });
  }

  if (row.channel === 'annotate') {
    const p = payload as AnnotatePayload;
    const content = redactText(p.content, ctx.redact).text;
    const value = redactValue(p.value, ctx.redact);
    const confidence = p.confidence ?? 0.55;
    const s = screen({ content, value, confidence }, ctx.quarantine);
    if (!s.accepted) {
      enqueue(
        db,
        s.reason ?? 'low_confidence',
        quarantinePayload(
          { content, value, confidence, subject: p.subject, predicate: p.predicate },
          { channel: row.channel, annotationId: row.id },
        ),
        ctx.ts,
      );
      stats.quarantined += 1;
      annotationRepo.markHarvested(db, row.id, ctx.ts);
      return;
    }
    const r = writeOne(db, ctx, {
      subject: p.subject,
      etype: p.etype,
      predicate: p.predicate,
      value,
      content: s.content,
      confidence,
      confidenceSource: p.confidenceSource ?? 'llm_claim',
      ftype: p.ftype ?? 'semantic',
      ...(p.scope === undefined ? {} : { scope: p.scope }),
      ...(p.validAt === undefined ? {} : { validAt: p.validAt }),
      ...(p.sourceEpisode === undefined ? {} : { sourceEpisode: p.sourceEpisode }),
      ...(p.importance === undefined ? {} : { importance: p.importance }),
      ext: redactValue(p.ext ?? {}, ctx.redact) as Record<string, unknown>,
    });
    stats[r.outcome] += 1;
    annotationRepo.markHarvested(db, row.id, ctx.ts);
    return;
  }

  // tool_parse / harvest：payload 是一条工具回合
  const turn = payload as ToolTurnPayload;
  const parsed = parseTurn({
    tool: turn.tool,
    cmd: redactText(turn.cmd, ctx.redact).text,
    output: redactText(turn.output, ctx.redact).text,
    exitCode: turn.exitCode,
    ...(turn.cwd === undefined ? {} : { cwd: turn.cwd }),
    ...(turn.ts === undefined ? {} : { ts: turn.ts }),
  });

  if (parsed.unparsed) {
    stats.skipped += 1;
    annotationRepo.markHarvested(db, row.id, ctx.ts);
    return;
  }

  for (const f of parsed.facts) {
    const content = redactText(f.content, ctx.redact).text;
    const value = redactValue(f.value, ctx.redact);
    const s = screen({ content, value, confidence: f.confidence }, ctx.quarantine);
    if (!s.accepted) {
      enqueue(
        db,
        s.reason ?? 'low_confidence',
        quarantinePayload(
          { content, value, confidence: f.confidence, subject: f.subject.name, predicate: f.predicate },
          { channel: row.channel, annotationId: row.id, parser: f.ext?.['parser'] },
        ),
        ctx.ts,
      );
      stats.quarantined += 1;
      continue;
    }
    const r = writeOne(db, ctx, {
      subject: f.subject.name,
      etype: f.subject.type,
      predicate: f.predicate,
      value,
      content: s.content,
      confidence: f.confidence,
      confidenceSource: f.confidenceSource ?? 'tool_obs',
      ftype: f.ftype,
      ...(turn.episodeId === undefined ? {} : { sourceEpisode: turn.episodeId }),
      ...(f.importance === undefined ? {} : { importance: f.importance }),
      ...(f.ext === undefined ? {} : { ext: redactValue(f.ext, ctx.redact) as Record<string, unknown> }),
    });
    stats[r.outcome] += 1;
  }
  annotationRepo.markHarvested(db, row.id, ctx.ts);
}

/**
 * 跑一轮 harvest。**幂等**：重复跑同一批 annotation 不会产生新事实
 * （`harvested_at` 已非空 + 幂等键 + 唯一索引三重保险）。
 */
export async function harvest(db: Db, opts: HarvestOptions = {}): Promise<HarvestResult> {
  const batchSize = opts.batchSize ?? 200;
  const stats = emptyResult();
  const ctx: HarvestContext = {
    priors: opts.priors ?? DEFAULT_PRIORS,
    quarantine: opts.quarantine ?? DEFAULT_QUARANTINE,
    redact: opts.redact ?? {},
    ...(opts.ontology === undefined ? {} : { ontology: opts.ontology }),
    ts: nowIso(),
  };
  const started = Date.now();

  for (;;) {
    const rows = annotationRepo.listPending(db, batchSize);
    if (rows.length === 0) break;

    withTransaction(db, () => {
      for (const row of rows) {
        stats.scanned += 1;
        try {
          applyAnnotation(db, row, ctx, stats);
        } catch (err) {
          stats.failed += 1;
          annotationRepo.markError(db, row.id, (err as Error).message, ctx.ts);
        }
      }
    });

    stats.batches += 1;
    if (rows.length < batchSize) break;
    if (opts.yieldBetweenBatches !== false) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  stats.ms = Date.now() - started;
  return stats;
}

/** 队列状态（doctor / UI 用） */
export function harvestQueueState(db: Db): { pending: number; errors: number } {
  return { pending: annotationRepo.countPending(db), errors: annotationRepo.countErrors(db) };
}
