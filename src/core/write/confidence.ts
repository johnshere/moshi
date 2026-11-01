/**
 * 置信（详设 §5.8）。
 *
 * 两条核心判断：
 * 1. **LLM 陈述只有 0.55**——初始置信是模型自评，没有共同标尺，必须压；
 * 2. **来源更强才抬，同源重复只微加**——重复观测是"更可信"，但不是"更正确"。
 */
import type { ConfSource } from '../../domain/enums.js';
import { clamp01 } from '../../domain/invariants.js';

export interface Priors {
  toolObs: number;
  toolInferred: number;
  userConfirm: number;
  llmClaim: number;
  llmGrounded: number;
  derivedCap: number;
  procedure: number;
  validateBump: number;
  validateMax: number;
}

/** 与 `config.toml [confidence]` 的默认值一致；app 层从配置注入，core 只认这个形状 */
export const DEFAULT_PRIORS: Priors = {
  toolObs: 0.95,
  toolInferred: 0.85,
  userConfirm: 0.98,
  llmClaim: 0.55,
  llmGrounded: 0.65,
  derivedCap: 0.9,
  procedure: 0.7,
  validateBump: 0.05,
  validateMax: 0.99,
};

export interface PriorOptions {
  /** tool_obs：输出是结构化的（exitCode + 正则命中）还是推断的（ps / ls） */
  structured?: boolean;
  /** llm_claim：是否引用了命令或文件 */
  grounded?: boolean;
  /** derived：源事实的均值，用于封顶 */
  sourceMean?: number;
}

export function priorFor(
  source: ConfSource,
  opts: PriorOptions = {},
  priors: Priors = DEFAULT_PRIORS,
): number {
  switch (source) {
    case 'tool_obs':
      return opts.structured === false ? priors.toolInferred : priors.toolObs;
    case 'user_confirm':
    case 'human':
      return priors.userConfirm;
    case 'llm_claim':
      return opts.grounded === true ? priors.llmGrounded : priors.llmClaim;
    case 'derived':
      return Math.min(opts.sourceMean ?? priors.derivedCap, priors.derivedCap);
    case 'procedure':
      return priors.procedure;
    case 'gat_delta':
      return priors.llmClaim;
  }
}

/** 来源强度序（详设 §2.8）：user_confirm(4) > tool_obs(3) > derived/procedure(2) > llm_claim(1) > gat_delta(0) */
export function rankOf(source: ConfSource): number {
  switch (source) {
    case 'user_confirm':
    case 'human':
      return 4;
    case 'tool_obs':
      return 3;
    case 'derived':
    case 'procedure':
      return 2;
    case 'llm_claim':
      return 1;
    case 'gat_delta':
      return 0;
  }
}

export interface ConfidenceState {
  value: number;
  source: ConfSource;
}

export interface MergeResult extends ConfidenceState {
  changed: boolean;
  reason: string;
}

/**
 * 情形 B（完全重复）的置信合并。
 * - 新来源更强：抬到 `max(旧值, 新先验)`，来源换成新的；
 * - 同等强度：`min(0.99, 旧值 + 0.03)`——重复观测的微弱加成，不是 0.05；
 * - 更弱：不动，只记访问。
 */
export function mergeOnReobserve(
  existing: ConfidenceState,
  incoming: ConfidenceState,
  priors: Priors = DEFAULT_PRIORS,
): MergeResult {
  const oldRank = rankOf(existing.source);
  const newRank = rankOf(incoming.source);

  if (newRank > oldRank) {
    const value = clamp01(Math.max(existing.value, incoming.value));
    if (value === existing.value && incoming.source === existing.source) {
      return { value: existing.value, source: existing.source, changed: false, reason: '无变化' };
    }
    return { value, source: incoming.source, changed: true, reason: '来源更强' };
  }
  if (newRank === oldRank) {
    const value = clamp01(Math.min(priors.validateMax, existing.value + 0.03));
    return value === existing.value
      ? { value, source: existing.source, changed: false, reason: '已到上限' }
      : { value, source: existing.source, changed: true, reason: '重复观测加成' };
  }
  return { value: existing.value, source: existing.source, changed: false, reason: '来源更弱' };
}

/**
 * 第 k 次独立观测的加成（详设 §5.8.2）。
 * "独立"由调用方判定：`source_episode` 不同且 `|valid_at 差| > 60s`。
 */
export function bumpOnValidate(
  current: number,
  priors: Priors = DEFAULT_PRIORS,
): number {
  return clamp01(Math.min(priors.validateMax, current + priors.validateBump));
}

/** 同一秒内的两次输出算同一次观测 */
export const INDEPENDENT_OBSERVATION_GAP_MS = 60_000;

export function isIndependentObservation(
  a: { sourceEpisode: string | null; validAt: string },
  b: { sourceEpisode: string | null; validAt: string },
): boolean {
  if (a.sourceEpisode === b.sourceEpisode) return false;
  const delta = Math.abs(Date.parse(a.validAt) - Date.parse(b.validAt));
  return delta > INDEPENDENT_OBSERVATION_GAP_MS;
}
