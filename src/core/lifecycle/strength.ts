/**
 * 强度方程与惰性衰减（详设 §8.1 / 概设 §5.5.1）。
 *
 * 强度是**惰性**维护的：不跑定时任务，只在两个时机各算一次——
 * 读路径返回前（`core/read/search.ts`）、写入后（`infra/sqlite/factRepo.ts` 的事件入口）。
 * 惰性成立的前提是 `last_decay_at` 恒为「上次把强度落库的时刻」：
 * 于是 `s(t) = s(t0)·e^{-λ(t-t0)}` 只需 t0 与当前 s，复利不会被重复计算。
 *
 * 三个必须写死的细节（概设 §5.5.1）：
 *   1. 变化不足 1e-3 就不写库（否则「读也写库」会把 WAL 打爆，详见实现在 factRepo）；
 *   2. `valid_to !== null` 的失效事实强度恒为 0，但**永不物理删除**（行保留）；
 *   3. 淘汰是软删（`epistemic_status = 'pruned'`），物理删除只走用户显式的隐私 purge。
 *
 * 本模块是纯函数：只吃 `Fact`、只吐数值，不碰 db、不碰时钟。
 */
import { parseTs } from '../../domain/time.js';
import type { Fact } from '../../domain/types.js';

/** 半衰期：普通事实 14 天，procedure 事实 60 天（概设 §5.5.1） */
export const HALF_LIFE_MS = {
  default: 14 * 864e5,
  procedure: 60 * 864e5,
} as const;

// 占位参数，待标定（概设 §5.5.1）——形态已定，数值靠数据校准；
// 改动必须过 golden set（详设 §10.3），不许顺手调。
export const ADOPT_ALPHA = 0.15;
export const REJECT_BETA = 0.7;
export const VALIDATE_FLOOR = 0.6;

export type StrengthEvent = { kind: 'adopt' | 'reject' | 'validate' | 'none' };

/** 写库前的 4 位小数（详设 §1.3）：浮点尾巴不许进库，否则 golden set 天天漂 */
export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** 谓词承载约定（概设 §5.6）：`procedure:` 前缀 = 操作流程类事实，衰减更慢 */
export function isProcedure(f: Fact): boolean {
  return f.attrs.frozen.predicate.startsWith('procedure:');
}

export function halfLifeOf(f: Fact): number {
  return isProcedure(f) ? HALF_LIFE_MS.procedure : HALF_LIFE_MS.default;
}

/**
 * 算「现在这一刻」的强度：惰性补衰减 → 叠加事件 → clamp → 4 位小数。
 *
 * - 失效事实（`validTo !== null`）直接 0：行留着，但不再有检索价值；
 * - `dt <= 0` 时衰减因子为 1，负 dt 不增不减（时钟回拨不许凭空加强度）；
 * - 事件在衰减**之后**叠加，顺序不能换：先加后衰会漏掉这一段的衰减。
 */
export function applyStrength(f: Fact, event: StrengthEvent, now: number): number {
  if (f.validTo !== null) return 0;

  // 时间只经 domain 的唯一解析入口（详设 §1.2）：非法串抛 E_INPUT，而不是静默 NaN
  const dt = Math.max(0, now - parseTs(f.lastDecayAt));
  let s = f.strength * Math.exp((-Math.LN2 * dt) / halfLifeOf(f));

  switch (event.kind) {
    case 'adopt':
      // 饱和增量：越接近 1 加得越少，永远不越界
      s += ADOPT_ALPHA * (1 - s);
      break;
    case 'reject':
      // 乘性惩罚：高置信也要真掉，低值不会被压成负数
      s *= REJECT_BETA;
      break;
    case 'validate':
      // 独立验证：设下限，不设加分（多次一致不该无限逼近 1）
      s = Math.max(s, VALIDATE_FLOOR);
      break;
    case 'none':
      break;
  }

  return round4(clamp01(s));
}
