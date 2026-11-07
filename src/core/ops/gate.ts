/**
 * GAT 准入双门槛（详设 §7.6；台账 P3-09）。
 *
 * `gat_mode` 从 `off` 升到 `shadow`/`on` 必须同时满足：
 *   1. 非循环样本（`source='adjudication' AND label_kind='overturn'`）≥ 500；
 *   2. 最近 200 次**带 `subgraph_nodes` 埋点**的查询的平均子图节点数 ≥ 20。
 *
 * 这是硬门禁，不是提示：`moshi eval gate` 不达标返回非 0，daemon 启动时
 * 不达标就把有效 `gat_mode` 压回 `off`（不改配置文件，下次启动重新评估）。
 * 理由见综述 §15.2：无邻居时 GAT 退化为 MLP，录下来的对照样本全是噪声。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { recentSubgraphNodeStats } from '../../infra/sqlite/queryLogRepo.js';
import { countSamples } from '../../infra/sqlite/trainingSampleRepo.js';

export const GATE_MIN_OVERTURN_SAMPLES = 500;
export const GATE_MIN_AVG_SUBGRAPH_NODES = 20;
export const GATE_QUERY_WINDOW = 200;

export type GateReason = 'samples' | 'density';

export interface GateReadings {
  /** 非循环样本数 */
  samples: number;
  /** 窗口内平均子图节点数；没有任何带埋点的查询时为 null */
  avgSubgraphNodes: number | null;
  /** 窗口内实际带 `subgraph_nodes` 的查询数 */
  observedQueries: number;
  window: number;
}

export interface GatGateResult {
  ok: boolean;
  /** 第一条不达标门槛（都达标时缺省） */
  reason?: GateReason;
  /** 不达标门槛的当前值（密度保留一位小数；无数据为 0） */
  current?: number;
  required?: number;
  samples: { current: number; required: number };
  density: { current: number; required: number; window: number; observed: number };
}

/**
 * 展示用：截断到两位小数。
 *
 * 不能用四舍五入——19.96 四舍五入会显示 20，而判定用原始值判不达标，
 * 输出就变成 `current:20, required:20, ok:false` 的自相矛盾。截断保证
 * `current >= required` 与 `ok` 永远一致（整数平均、分母 ≤ 200 时没有浮点陷阱）。
 */
function floor2(n: number): number {
  // +1e-9 抵消 `n*100` 的二进制误差（如 19.99*100 = 1998.999…），否则会多截一位
  return Math.floor((n + 1e-9) * 100) / 100;
}

/** 纯函数：读数 → 判定（不碰库，单测直接打这里） */
export function evaluateGatGate(readings: GateReadings): GatGateResult {
  const samplesOk = readings.samples >= GATE_MIN_OVERTURN_SAMPLES;
  const density = readings.avgSubgraphNodes === null ? 0 : floor2(readings.avgSubgraphNodes);
  // 判定必须用原始均值：用展示值会让 19.95+ 蒙混过关（AC-5 的边界）
  const densityOk =
    readings.avgSubgraphNodes !== null &&
    readings.avgSubgraphNodes >= GATE_MIN_AVG_SUBGRAPH_NODES;

  const result: GatGateResult = {
    ok: samplesOk && densityOk,
    samples: { current: readings.samples, required: GATE_MIN_OVERTURN_SAMPLES },
    density: {
      current: density,
      required: GATE_MIN_AVG_SUBGRAPH_NODES,
      window: readings.window,
      observed: readings.observedQueries,
    },
  };
  if (!samplesOk) {
    result.reason = 'samples';
    result.current = readings.samples;
    result.required = GATE_MIN_OVERTURN_SAMPLES;
  } else if (!densityOk) {
    result.reason = 'density';
    result.current = density;
    result.required = GATE_MIN_AVG_SUBGRAPH_NODES;
  }
  return result;
}

/** 连库读数并判定（`moshi eval gate` 与 daemon 启动共用） */
export function checkGatGate(db: Db, window: number = GATE_QUERY_WINDOW): GatGateResult {
  const samples = countSamples(db, { source: 'adjudication', labelKind: 'overturn' });
  const stats = recentSubgraphNodeStats(db, window);
  return evaluateGatGate({
    samples,
    avgSubgraphNodes: stats.avg,
    observedQueries: stats.observed,
    window,
  });
}

export type GatMode = 'off' | 'shadow' | 'on';

export interface GatGateEnforcement {
  /** 门禁后的有效模式 */
  mode: GatMode;
  /** 因门槛不达标被拒绝（`gate` 此时必有值） */
  refused: boolean;
  gate?: GatGateResult;
}

/**
 * daemon 启动门禁：`shadow`/`on` 不达标就返回 `off`。
 *
 * 只算有效值，**不写配置文件**——数据攒够了下次启动自动放行，
 * 也不需要偷偷改用户的配置。
 */
export function enforceGatGate(mode: GatMode, db: Db, window?: number): GatGateEnforcement {
  if (mode === 'off') return { mode: 'off', refused: false };
  const gate = checkGatGate(db, window);
  return gate.ok ? { mode, refused: false } : { mode: 'off', refused: true, gate };
}
