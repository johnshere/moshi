/**
 * `memory_correct` 的实现（详设 §4.1.4）。
 *
 * 这是四个工具里**唯一**会改既有行状态的，也是唯一 `destructiveHint: true` 的。
 * 三条语义约束在这里落地：
 *
 * 1. `epistemic_status: "invalidated"` **必须同时收口 `valid_to`**。
 *    只改状态不改时间会造出"已失效但仍然有效"的行，所有时态查询都会读错。
 *    所以这里走 `factRepo.invalidate()`——它把两件事绑在一个动作里，且拒绝重复收口。
 * 2. `content` / `attrs.frozen` 改不了。schema 层 `.strict()` 已经拒掉，这里再兜一次：
 *    万一将来有人绕过 schema 直接调这个函数，也必须炸。
 * 3. **每次调用写一条汇总 audit**。`setConfidence` 自己会写一条字段级审计（I10），
 *    但"这次纠正是一个事件"这件事只能由汇总行表达——`reason` 就挂在它上面。
 */
import { reconcileDerivedForFacts } from '../../core/lifecycle/consolidate.js';
import { MoshiError } from '../../domain/errors.js';
import { nowIso } from '../../domain/time.js';
import * as auditRepo from '../../infra/sqlite/auditRepo.js';
import * as factRepo from '../../infra/sqlite/factRepo.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import type { Fact } from '../../domain/types.js';
import type { McpDeps } from './deps.js';
import type { CorrectInput } from './schemas.js';

export interface CorrectResult {
  audit_id: string;
  fact_id: string;
  /** 实际发生变化的字段名；空数组表示 patch 与现状一致（幂等，不算错误） */
  changed: string[];
}

function snapshot(fact: Fact): Record<string, unknown> {
  return {
    confidence: fact.confidence,
    confidence_source: fact.confidenceSource,
    importance: fact.importance,
    strength: fact.strength,
    epistemic_status: fact.epistemicStatus,
    valid_to: fact.validTo,
  };
}

export function runMemoryCorrect(deps: McpDeps, input: CorrectInput): CorrectResult {
  const patch = input.patch as Record<string, unknown>;
  // 双重保险：schema 用 .strict() 已挡住，这里防的是绕过 schema 的调用方
  for (const forbidden of ['content', 'attrs', 'canonical_key', 'value_hash']) {
    if (forbidden in patch) {
      throw new MoshiError('E_IMMUTABLE', `事实内容不可改：${forbidden}`, { field: forbidden });
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new MoshiError('E_INPUT', 'patch 为空：至少要改一个字段', { factId: input.fact_id });
  }

  const before = factRepo.getFact(deps.db, input.fact_id);
  if (before === null) {
    throw new MoshiError('E_NOT_FOUND', `fact 不存在：${input.fact_id}`, { id: input.fact_id });
  }

  const ts = nowIso();
  const changed: string[] = [];
  let auditId = '';

  withTransaction(deps.db, () => {
    if (input.patch.confidence !== undefined && input.patch.confidence !== before.confidence) {
      factRepo.setConfidence(deps.db, before.id, {
        value: input.patch.confidence,
        source: 'human',
        reason: input.reason ?? 'memory_correct',
        ts,
      });
      changed.push('confidence');
    }
    if (input.patch.importance !== undefined && input.patch.importance !== before.importance) {
      factRepo.setImportance(deps.db, before.id, input.patch.importance, ts);
      changed.push('importance');
    }
    if (input.patch.strength !== undefined && input.patch.strength !== before.strength) {
      factRepo.setStrength(deps.db, before.id, input.patch.strength, ts);
      changed.push('strength');
    }

    const status = input.patch.epistemic_status;
    if (status !== undefined && status !== before.epistemicStatus) {
      if (status === 'invalidated') {
        // 已经收口过的行不能再收口：invalidate 会抛 E_IMMUTABLE，这正是想要的
        factRepo.invalidate(deps.db, before.id, { validTo: ts, status: 'invalidated' });
        changed.push('epistemic_status', 'valid_to');
      } else {
        if (before.validTo !== null) {
          throw new MoshiError(
            'E_IMMUTABLE',
            `事实已失效（valid_to=${before.validTo}），不能改回 ${status}：追加式失效不允许复活`,
            { id: before.id, status },
          );
        }
        factRepo.setEpistemicStatus(deps.db, before.id, status);
        changed.push('epistemic_status');
      }
    }

    const after = factRepo.getFact(deps.db, before.id);
    auditId = auditRepo.appendAudit(deps.db, {
      tbl: 'fact',
      rowId: before.id,
      field: 'patch',
      before: snapshot(before),
      after: after === null ? null : snapshot(after),
      source: 'human',
      reason: input.reason ?? null,
      ts,
    });
  });

  if (changed.includes('valid_to')) {
    // 源事实撤回后立刻对账；失败不影响已提交的纠正，下一轮 consolidate 会补
    try {
      reconcileDerivedForFacts(deps.db, [before.id]);
    } catch {
      /* 反向对账是维护动作，不让它把纠正结果变成错误 */
    }
  }

  return { audit_id: auditId, fact_id: before.id, changed };
}
