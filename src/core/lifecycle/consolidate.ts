/**
 * 巩固之一：情景 → 语义（P2-09 / 详设 §8.3.1、概设 §5.5.2）。
 *
 * 同一 `canonical_key` 下积累了 ≥3 条 episodic 观测，就该给出一个"结论"：
 * 新增一条 `ftype='semantic'` 的要点 + 到每条源事实的 `derived_from` 边。
 * 「没有它，图会被重复观测灌满，且永远没有结论」（概设 §5.5.2）。
 *
 * **红线（概设 §5.5.4）**：本模块只**新增**事实与边；不 `UPDATE` 任何源事实的
 * `content` / `attrs` / `strength` / 状态，不删任何行。源事实的 id 集合进
 * `ext.derived_from` 指纹，所以重复跑同一组不会产生重复要点（可重入）。
 *
 * 三个实现口径（进度文档 D-107 记录取舍理由）：
 * 1. 身份唯一索引 `(canonical_key, scope, value_hash) WHERE valid_to IS NULL`
 *    让"同值重复观测"在写入时就被折叠（harvest 情形 B 只刷新不插行），
 *    所以真实数据里 ≥3 条同 key 的 episodic 必然**取值互不相同**——
 *    要点不能取单个 `{value}`，否则与活跃源行撞身份索引；取聚合结构。
 * 2. 因此 content 的 `{value}` 位置列出全部观测值（详设模板的 `{value}` 位展开成取值集合）。
 * 3. 同一组出现新观测后指纹变化 → 产出新要点，并把**上一条要点**（不是源事实）收口。
 *
 * 撤回语义（D-113）：
 * - **人工否决 = 墓碑**：同 key、同指纹的派生点被人工失效过，就不再重建；
 * - **自动对账不算否决**：源撤回导致活跃源 < 阈值时，本模块收口派生点并写
 *   `rule:consolidate_reconcile` audit；源恢复后仍可重新产出结论；
 * - 每轮开头扫一遍活跃派生点做反向对账，失效入口另有定向触发。
 */
import { isMoshiError } from '../../domain/errors.js';
import { canonicalJson, sha256Hex, valueHash } from '../../domain/hash.js';
import { newId } from '../../domain/ids.js';
import { addMs, nowIso } from '../../domain/time.js';
import type { Fact, FactAttrs } from '../../domain/types.js';
import { appendAudit } from '../../infra/sqlite/auditRepo.js';
import {
  countActiveConsolidationSources,
  hasHumanRejectedDerived,
  listActiveDerivedFacts,
  listActiveDerivedPointsForSources,
  listAllActiveDerivedPoints,
  listEpisodicGroups,
} from '../../infra/sqlite/consolidationRepo.js';
import type { Db } from '../../infra/sqlite/db.js';
import { insertEdge } from '../../infra/sqlite/edgeRepo.js';
import { findByIdentity, insertFact, invalidate, listByIds } from '../../infra/sqlite/factRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import { clipContent, DEFAULT_QUARANTINE } from '../write/quarantine.js';
import { round4 } from './strength.js';

/** 提炼阈值（详设 §8.3.1：同 key ≥3 条 episodic） */
export const CONSOLIDATE_MIN_OBSERVATIONS = 3;
/** 产出置信上限（详设 §8.3.1：`min(0.90, avg(源 confidence))`） */
export const CONSOLIDATE_MAX_CONFIDENCE = 0.9;
/** 限速：每秒最多处理多少组（详设 §8.3 总则：20 条/秒；`0` = 不限速） */
export const CONSOLIDATE_RATE_PER_SEC = 20;
/** 溯源边 provenance，与 `rule:tool_seq` / `rule:co_occur` 同一命名族 */
export const CONSOLIDATE_PROVENANCE = 'rule:consolidate';
/** 反向对账写 audit 的来源：与人工否决区分，避免源恢复后结论被永久压住 */
export const CONSOLIDATE_RECONCILE_SOURCE = 'rule:consolidate_reconcile';

export interface ConsolidateOptions {
  /** 触发阈值，默认 `CONSOLIDATE_MIN_OBSERVATIONS` */
  minObservations?: number;
  /** 限速（组/秒），默认 `CONSOLIDATE_RATE_PER_SEC`；`0` = 不限速 */
  ratePerSec?: number;
  /** 单次最多处理多少组；`0`/不传 = 全部 */
  maxGroups?: number;
  /** 只统计不写库（CLI `--dry-run`） */
  dryRun?: boolean;
  /** `content` 字节上限，默认 2048（与 `[ingest].max_fact_bytes` 默认值一致） */
  maxContentBytes?: number;
}

export interface ConsolidateResult {
  /** 候选组数 */
  groups: number;
  /** 产出的要点数（`dryRun` 时为"将会产出"） */
  created: number;
  /** 跳过数：指纹已存在（幂等）或组已不成立 */
  skipped: number;
  /** 被收口的旧要点数（`dryRun` 时为"将会收口"） */
  superseded: number;
  /** 因活跃源不足被反向对账收口的派生点数（`dryRun` 时为"将会收口"） */
  reconciled: number;
  ms: number;
}

/** 要点取值：观测集合的聚合结构（保证与任一源值身份不同，见文件头口径 1） */
export interface ConsolidatedValue {
  consolidated: true;
  observations: number;
  values: unknown[];
}

/**
 * 幂等键：源事实 id 集合的指纹。与顺序无关——`group_concat` 的顺序不受保证，
 * 而"同一批源"必须永远算出同一个键。
 */
export function derivedFromOf(ids: readonly string[]): string {
  return sha256Hex([...ids].sort().join('\n'));
}

function compareByJson(a: unknown, b: unknown): number {
  const x = canonicalJson(a);
  const y = canonicalJson(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 取值集合 → 聚合结构（排序固定，同样的观测集合必然得到同样的 value_hash） */
export function buildConsolidatedValue(values: readonly unknown[]): ConsolidatedValue {
  const sorted = [...values].sort(compareByJson);
  return { consolidated: true, observations: sorted.length, values: sorted };
}

/**
 * 要点正文：`{subject} 的 {谓词} 为 {各次取值}（由 {n} 个不同取值归纳）`。
 * 字符串取值原样列出，结构化取值用 canonicalJson（与 `value_hash` 同一序列化）。
 *
 * `n` 是组内行数，不是真实观测次数：同值重复观测已被 harvest 折叠（I-25）。
 */
export function renderConsolidatedContent(
  subject: string,
  predicate: string,
  values: readonly unknown[],
): string {
  const shown = values.map((v) => (typeof v === 'string' ? v : canonicalJson(v))).join('、');
  return `${subject} 的 ${predicate} 为 ${shown}（由 ${values.length} 个不同取值归纳）`;
}

/**
 * 2 KB 上限（详设 §5.3）：先按"前两句 + …"截断；派生正文往往只有一个长句，
 * `clipContent` 的 overflow 分支会返回原文 + `…`，这时按 UTF-8 字节安全硬截。
 */
function capConsolidatedContent(content: string, maxBytes: number): string {
  const clipped = clipContent(content, maxBytes);
  if (!clipped.overflow) return clipped.text;
  const ellipsis = '…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  const buf = Buffer.from(clipped.text, 'utf8');
  const cut = buf.subarray(0, Math.max(0, budget)).toString('utf8');
  // Buffer 截断多字节字符时末尾会留下 U+FFFD，去掉它再补省略号
  return `${cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut}${ellipsis}`;
}

/** `min(0.90, avg(源 confidence))`：巩固结论的置信永远不高于源观测均值（伪结论风险表） */
export function consolidatedConfidence(confidences: readonly number[]): number {
  if (confidences.length === 0) return 0;
  const sum = confidences.reduce((a, b) => a + b, 0);
  return round4(Math.min(CONSOLIDATE_MAX_CONFIDENCE, sum / confidences.length));
}

function byIdAsc(a: Fact, b: Fact): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildDerivedFact(
  group: { canonicalKey: string; scope: string },
  sources: readonly Fact[],
  fingerprint: string,
  now: string,
  maxContentBytes: number,
): Fact {
  const first = sources[0] as Fact;
  const { subject, predicate } = first.attrs.frozen;
  const value = buildConsolidatedValue(sources.map((s) => s.attrs.frozen.value));
  const attrs: FactAttrs = { frozen: { subject, predicate, value }, ext: { derived_from: fingerprint } };
  return {
    id: newId('fact'),
    content: capConsolidatedContent(
      renderConsolidatedContent(subject.name, predicate, value.values),
      maxContentBytes,
    ),
    ftype: 'semantic',
    confidence: consolidatedConfidence(sources.map((s) => s.confidence)),
    // 'derived' 既是 `confidence_source` 枚举的既有取值，也是"已提炼要点"的识别标记
    confidenceSource: 'derived',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs,
    canonicalKey: group.canonicalKey,
    valueHash: valueHash(value),
    scope: group.scope,
    supersededBy: null,
    validAt: now,
    validTo: null,
    recordedAt: now,
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: now,
    // 详设 §8.3.1：要点不是某一次观测，不挂 episode
    sourceEpisode: null,
    span: null,
    createdAt: now,
    updatedAt: now,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 反向对账：活跃源不足以支撑结论的派生点 → 收口。
 *
 * 只处理带 `ext.derived_from` 的巩固产出，不碰其它来源的 `derived` 行。
 * 收口写 `rule:consolidate_reconcile` audit，与人工否决区分：源恢复后还能重新产出。
 */
function reconcilePoints(
  db: Db,
  points: readonly Fact[],
  opts: { minObservations: number; dryRun: boolean; now: string },
): number {
  let reconciled = 0;
  for (const point of points) {
    if (countActiveConsolidationSources(db, point.id) >= opts.minObservations) continue;
    reconciled += 1;
    if (opts.dryRun) continue;

    // 理论上 valid_at <= now；同毫秒内收口时兜一个 +1ms，别撞 CHECK
    const validTo = point.validAt < opts.now ? opts.now : addMs(point.validAt, 1);
    try {
      withTransaction(db, () => {
        invalidate(db, point.id, { validTo, status: 'invalidated' });
        appendAudit(db, {
          tbl: 'fact',
          rowId: point.id,
          field: 'epistemic_status',
          before: {
            valid_to: point.validTo,
            epistemic_status: point.epistemicStatus,
            superseded_by: point.supersededBy,
          },
          after: { valid_to: validTo, epistemic_status: 'invalidated', superseded_by: null },
          source: CONSOLIDATE_RECONCILE_SOURCE,
          reason: 'sources_below_threshold',
        });
      });
    } catch (err) {
      // 与 daemon 的巩固轮并发时，对方可能已经收口同一行；这不是错误
      if (isMoshiError(err) && err.code === 'E_IMMUTABLE') continue;
      throw err;
    }
  }
  return reconciled;
}

/**
 * 定向对账：失效入口（批量 / PATCH / memory_correct）调用，立刻检查被撤回源事实
 * 指向的派生点，不必等下一轮 `consolidate`（没有新 annotation 时它不会跑）。
 */
export function reconcileDerivedForFacts(
  db: Db,
  factIds: readonly string[],
  opts: { minObservations?: number; dryRun?: boolean } = {},
): number {
  const points = listActiveDerivedPointsForSources(db, factIds);
  return reconcilePoints(db, points, {
    minObservations: opts.minObservations ?? CONSOLIDATE_MIN_OBSERVATIONS,
    dryRun: opts.dryRun ?? false,
    now: nowIso(),
  });
}

/**
 * 跑一轮情景→语义巩固。
 *
 * 单组事务内：插要点 → 建 `derived_from` 边 → 收口该 key 下**旧的要点**。
 * 源事实除了被边指向，一个字段都不动。
 */
export async function consolidate(
  db: Db,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const startedAt = performance.now();
  const minObservations = opts.minObservations ?? CONSOLIDATE_MIN_OBSERVATIONS;
  const ratePerSec = opts.ratePerSec ?? CONSOLIDATE_RATE_PER_SEC;
  const maxGroups = opts.maxGroups ?? 0;
  const dryRun = opts.dryRun ?? false;
  const maxContentBytes = opts.maxContentBytes ?? DEFAULT_QUARANTINE.maxContentBytes;

  const candidates = listEpisodicGroups(db, minObservations);
  const groups = maxGroups > 0 ? candidates.slice(0, maxGroups) : candidates;
  const res: ConsolidateResult = {
    groups: groups.length,
    created: 0,
    skipped: 0,
    superseded: 0,
    reconciled: 0,
    ms: 0,
  };

  // 先对账再提炼：源已撤回的旧结论不该继续以 active 留在库里
  res.reconciled = reconcilePoints(db, listAllActiveDerivedPoints(db), {
    minObservations,
    dryRun,
    now: nowIso(),
  });

  let processed = 0;
  for (const group of groups) {
    // 限速只在组与组之间：第一组不必等，`--dry-run` 不写库也不必等
    if (!dryRun && ratePerSec > 0 && processed > 0) {
      await delay(Math.ceil(1000 / ratePerSec));
    }
    processed += 1;

    const ids = [...group.ids].sort();
    const sources = listByIds(db, ids).sort(byIdAsc);
    if (sources.length < minObservations) {
      res.skipped += 1;
      continue;
    }

    const fingerprint = derivedFromOf(ids);
    if (
      hasHumanRejectedDerived(
        db,
        group.canonicalKey,
        group.scope,
        fingerprint,
        CONSOLIDATE_RECONCILE_SOURCE,
      )
    ) {
      res.skipped += 1;
      continue;
    }

    const activeDerived = listActiveDerivedFacts(db, group.canonicalKey, group.scope);
    if (activeDerived.some((f) => f.attrs.ext.derived_from === fingerprint)) {
      res.skipped += 1;
      continue;
    }

    const now = nowIso();
    const fact = buildDerivedFact(group, sources, fingerprint, now, maxContentBytes);
    const clash = findByIdentity(db, fact.canonicalKey, fact.scope, fact.valueHash);
    if (clash !== null && clash.validTo === null) {
      res.skipped += 1;
      continue;
    }

    res.created += 1;
    res.superseded += activeDerived.length;
    if (dryRun) continue;

    withTransaction(db, () => {
      insertFact(db, fact);
      for (const src of sources) {
        insertEdge(db, {
          id: newId('edge'),
          src: fact.id,
          dst: src.id,
          etype: 'derived_from',
          validAt: now,
          provenance: CONSOLIDATE_PROVENANCE,
        });
      }
      for (const old of activeDerived) {
        // 理论上 valid_at <= now；同毫秒内两次巩固时兜一个 +1ms，别撞 CHECK
        const validTo = old.validAt < now ? now : addMs(old.validAt, 1);
        invalidate(db, old.id, { validTo, supersededBy: fact.id, status: 'invalidated' });
      }
    });
  }

  res.ms = Math.round(performance.now() - startedAt);
  return res;
}
