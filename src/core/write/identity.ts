/**
 * 身份键（详设 §5.6）。
 *
 * 三个实现约束，每一条都对应一类真实故障：
 * 1. `predicate` 用规范化后的值——否则 `Installed Version` 与 `installed_version` 会算出两个 key；
 * 2. `value` 必须过 canonicalJson——不可序列化就抛 `E_INPUT`，**不要**静默降级成字符串；
 * 3. `scope` 进 key；v1.1 起允许 `global` 与 `project:<cwd>`（见 `domain/scope.ts`）。
 */
import { MoshiError } from '../../domain/errors.js';
import { canonicalKey, valueHash } from '../../domain/hash.js';
import { normalizePredicate } from '../parse/normalizers.js';
import { assertScope } from '../../domain/scope.js';

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
