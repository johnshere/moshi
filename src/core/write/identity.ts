/**
 * 身份键（详设 §5.6）。
 *
 * 三个实现约束，每一条都对应一类真实故障：
 * 1. `predicate` 用规范化后的值——否则 `Installed Version` 与 `installed_version` 会算出两个 key；
 * 2. `value` 必须过 canonicalJson——不可序列化就抛 `E_INPUT`，**不要**静默降级成字符串；
 * 3. `scope` 进 key，Phase 0 恒为 `global`，写入时断言（v1.1 才放开）。
 */
import { MoshiError } from '../../domain/errors.js';
import { canonicalKey, valueHash } from '../../domain/hash.js';
import { normalizePredicate } from '../parse/normalizers.js';

/** Phase 0 唯一合法作用域；v1.1 由 V-01 放开 */
export const PHASE0_SCOPE = 'global';

export function assertScope(scope: string): void {
  if (scope !== PHASE0_SCOPE) {
    throw new MoshiError(
      'E_INPUT',
      `Phase 0 只允许 scope='global'，收到 '${scope}'（作用域在 v1.1 启用）`,
      { scope },
    );
  }
}

export interface Identity {
  canonicalKey: string;
  valueHash: string;
  /** 规范化后的谓词，落库时写这个值 */
  predicate: string;
}

export interface IdentityInput {
  scope: string;
  entityId: string;
  predicate: string;
  /** 已脱敏的取值；未脱敏的原文不许进来（§1.6：哈希在脱敏之后算） */
  value: unknown;
}

export function buildIdentity(input: IdentityInput): Identity {
  assertScope(input.scope);
  const predicate = normalizePredicate(input.predicate);
  if (predicate === null) {
    throw new MoshiError('E_INPUT', `谓词规范化失败：'${input.predicate}'`, {
      predicate: input.predicate,
    });
  }
  return {
    canonicalKey: canonicalKey(input.scope, input.entityId, predicate),
    valueHash: valueHash(input.value),
    predicate,
  };
}
