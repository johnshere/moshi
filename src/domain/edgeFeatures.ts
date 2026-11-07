/**
 * 边特征（`edge_attr`）16 维唯一权威定义（详设 §4.5，P3-00）。
 *
 * 模型签名里的 `edge_dim=16` 此前只有数字、没有逐维语义；本文件把 16 维
 * 定死并给出纯函数实现。拼接顺序改动即升 `moshi-subgraph/2`。
 *
 * 逐维：
 * - 0–5   `etype` one-hot，顺序与 `domain/enums.ts` 的 `ETYPE` 一致
 * - 6     `weight`，0–1（缺省 1.0 由边存储/调用方保证）
 * - 7     `confidence`，0–1
 * - 8     `hop` 归一化：1 跳 → 0.5，2 跳 → 1.0，非路径边（null）→ 0
 * - 9     方向：src→dst 前进 +1，逆序 −1，无向 0
 * - 10–15 保留位，恒 0，永不复用
 *
 * 白名单：入参只允许 `etype / weight / confidence / hop / direction`；
 * 生命周期与治理字段（`strength`、`pool`、`access_count`、`last_access_at`、
 * `archive_meta.*`、`layout.*`、`community_summary.derived_at`）禁止进入边特征。
 * 类型层挡不住 JS 运行时多传的字段，所以本文件在入口显式校验并抛 `E_INPUT`。
 *
 * 本模块是纯函数：不读 DB、不查边、不依赖 sidecar。`direction` 由调用方
 * （P3-01 在子图 JSON 组装层）按 `src`/`dst` 的下标关系换算后传入。
 */
import { ETYPE, type Etype } from './enums.js';
import { MoshiError } from './errors.js';

/** 边特征总维度（详设 §4.5：`edge_attr.shape == (1, 192, 16)`）。 */
export const EDGE_FEAT_DIM = 16;

/** 保留段起点；`[EDGE_RESERVED_FROM, EDGE_FEAT_DIM)` 恒置 0，永不复用。 */
export const EDGE_RESERVED_FROM = 10;

/**
 * 边 padding 目标行数（详设 §4.5 / §6.6：边上限 192）。
 *
 * 与 `src/core/read/subgraph.ts` 的 `MAX_EDGES` / `[search].max_edges` 默认值
 * 同源；P3-01 组装子图 JSON 时以契约为准，本卡不改 subgraph.ts。
 */
export const EDGE_PAD_MAX = 192;

/** 允许进入边特征的字段（白名单；顺序仅用于错误信息展示）。 */
export const EDGE_FEATURE_KEYS = ['etype', 'weight', 'confidence', 'hop', 'direction'] as const;

export interface EdgeFeatureInput {
  readonly etype: Etype;
  /** 结构权重，0–1；缺省 1.0 由边存储/调用方保证。 */
  readonly weight: number;
  readonly confidence: number;
  /** 1 跳 / 2 跳 / 非路径边（null）。 */
  readonly hop: 1 | 2 | null;
  /** src→dst 前进 +1，逆序边 −1，无向边 0。 */
  readonly direction: 1 | -1 | 0;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>(EDGE_FEATURE_KEYS);

function inputError(message: string, detail: Record<string, unknown>): MoshiError {
  return new MoshiError('E_INPUT', message, detail);
}

/** 白名单校验：多传一个治理字段就拒绝，避免“静默进特征”。 */
function assertWhitelisted(input: EdgeFeatureInput): void {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw inputError(
        `edgeFeatures: 字段 "${key}" 不在边特征白名单内（只允许 ${EDGE_FEATURE_KEYS.join('/')}）`,
        { field: key },
      );
    }
  }
}

function clamp01(value: number, field: 'weight' | 'confidence'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw inputError(`edgeFeatures: ${field} 必须是有限数值`, { field, value: String(value) });
  }
  return Math.min(1, Math.max(0, value));
}

function hopFeature(hop: EdgeFeatureInput['hop']): number {
  switch (hop) {
    case 1:
      return 0.5;
    case 2:
      return 1.0;
    case null:
      return 0;
    default:
      throw inputError('edgeFeatures: hop 只能是 1、2 或 null', { hop: String(hop) });
  }
}

function directionFeature(direction: EdgeFeatureInput['direction']): number {
  switch (direction) {
    case 1:
    case -1:
    case 0:
      return direction;
    default:
      throw inputError('edgeFeatures: direction 只能是 1、-1 或 0', { direction: String(direction) });
  }
}

/**
 * 单条边 → 16 维特征。
 *
 * @throws MoshiError `E_INPUT`——未知 `etype`、非有限 weight/confidence、
 *         非法 hop/direction、或入参含白名单外字段。
 */
export function edgeFeatures(input: EdgeFeatureInput): number[] {
  assertWhitelisted(input);

  const etypeIndex = ETYPE.indexOf(input.etype);
  if (etypeIndex < 0) {
    throw inputError(`edgeFeatures: 未知 etype "${String(input.etype)}"（只允许 ${ETYPE.join('/')}）`, {
      etype: String(input.etype),
    });
  }

  const out = new Array<number>(EDGE_FEAT_DIM).fill(0);
  out[etypeIndex] = 1; // 0–5 etype one-hot
  out[6] = clamp01(input.weight, 'weight');
  out[7] = clamp01(input.confidence, 'confidence');
  out[8] = hopFeature(input.hop);
  out[9] = directionFeature(input.direction);
  // 10–15 保留位：new Array().fill(0) 已保证，这里再显式写一遍契约
  for (let i = EDGE_RESERVED_FROM; i < EDGE_FEAT_DIM; i += 1) {
    out[i] = 0;
  }
  return out;
}

/**
 * 多条边 → padding 到 `maxEdges` 的 16 维行（供契约测试与 P3-01/P3-02 复用）。
 *
 * - 不足 `maxEdges` 补全 0（无边的行全 0，Python 侧以 `edge_mask` 区分）；
 * - 超过 `maxEdges` 直接截断，保留前 `maxEdges` 条；
 * - `edges` 为空也返回 `maxEdges` 行全 0——契约形状 `(192, 16)` 不随边数变化。
 */
export function edgeFeaturesPadded(edges: readonly EdgeFeatureInput[], maxEdges = EDGE_PAD_MAX): number[][] {
  if (!Number.isInteger(maxEdges) || maxEdges < 0) {
    throw inputError('edgeFeaturesPadded: maxEdges 必须是非负整数', { maxEdges: String(maxEdges) });
  }

  const rows: number[][] = [];
  const kept = Math.min(edges.length, maxEdges);
  for (let i = 0; i < kept; i += 1) {
    rows.push(edgeFeatures(edges[i]!));
  }
  while (rows.length < maxEdges) {
    rows.push(new Array<number>(EDGE_FEAT_DIM).fill(0));
  }
  return rows;
}
