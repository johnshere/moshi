/**
 * 视觉编码的纯函数（详设 §10.3「视觉编码表」逐行落成代码）。
 *
 * 这个文件**只能有数学**：不 import three、不碰 DOM、不看 window。
 * 理由有两个：
 * 1. 根工程的 `pnpm typecheck` / `vitest` 会顺着测试的 import 把这里拉进 Node 侧编译，
 *    一旦引入 three 或 DOM 类型，根 tsconfig（lib 里没有 DOM）就会炸。
 * 2. 单测能直接断言数值，不需要 WebGL（jsdom 里跑不了 WebGL）。
 */

import { etypeHex, ftypeHex } from './palette.js';

// ── 色板（详设 §10.3 表；颜色值统一收在 pure/palette.ts，这里只保留键名映射）──

/** `fact.ftype` → 色相（取值转调 palette，token 化后这里不再有颜色字面量） */
export const FTYPE_HEX = {
  semantic: ftypeHex('semantic'),
  episodic: ftypeHex('episodic'),
  conditional: ftypeHex('conditional'),
} as const;

/** `edge.etype` → 色相；键用库里的真实枚举值（`mutually_exclusive` / `derived_from`） */
export const ETYPE_HEX = {
  depends_on: etypeHex('depends_on'),
  logic: etypeHex('logic'),
  mutually_exclusive: etypeHex('mutually_exclusive'),
  co_occur: etypeHex('co_occur'),
  supersedes: etypeHex('supersedes'),
  derived_from: etypeHex('derived_from'),
} as const;

/** shader 里 `aType` 的下标顺序，必须与 `ETYPE_ORDER_RGB` 对齐 */
export const ETYPE_ORDER = [
  'depends_on',
  'logic',
  'mutually_exclusive',
  'co_occur',
  'supersedes',
  'derived_from',
] as const;

export type Etype = (typeof ETYPE_ORDER)[number];

// ── Y 轴四层（strength）─────────────────────────────────────────────

export const LAYER_TOP = 60;
export const LAYER_MID = 0;
export const LAYER_LOW = -60;
export const LAYER_INVALID = -100;
/** 层内 ±20 的线性微调幅度 */
export const LAYER_BAND = 20;

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * strength → Y 坐标。
 *
 * 四层：`≥0.7→+60`、`0.3–0.7→0`、`<0.3→−60`、失效→`−100`；
 * 层内按 strength 在本层区间的位置再线性偏 ±20。
 * 失效层不参与微调（它是一条"墓碑层"，位置本身就是语义）。
 */
export function layerY(strength: number, invalidated = false): number {
  if (invalidated) return LAYER_INVALID;
  const s = clamp01(strength);
  if (s >= 0.7) return LAYER_TOP - LAYER_BAND + ((s - 0.7) / 0.3) * 2 * LAYER_BAND;
  if (s >= 0.3) return LAYER_MID - LAYER_BAND + ((s - 0.3) / 0.4) * 2 * LAYER_BAND;
  return LAYER_LOW - LAYER_BAND + (s / 0.3) * 2 * LAYER_BAND;
}

/** 顶部活跃层（`strength ≥ 0.7` 的那层）的下边界，标签只对活跃层显示 */
export const ACTIVE_LAYER_MIN_Y = LAYER_TOP - LAYER_BAND;

/**
 * 事实是否已失效。
 *
 * 事实是否已失效：`strength` 归零，或内容本身就带 `[失效]` 前缀（人工标注）。
 * **节点 Y 与社区包络球心必须用同一个判定**，否则失效节点画在 −100、包络中心
 * 算在 −80，球罩不住自己的成员（P2-02 复审 H-1 实测 30/30 落在球外）。
 */
export function isInvalidated(node: { strength: number; label: string }): boolean {
  return node.strength <= 0 || node.label.startsWith('[失效]');
}

/**
 * 事实渲染用的 Y：`layerY` + 失效判定，二者绑在一起，避免调用点漏传
 * `invalidated`（P2-02 复审 H-1 就是这么漏的）。
 */
export function renderY(node: { strength: number; label: string }): number {
  return layerY(node.strength, isInvalidated(node));
}

export function isActiveLayer(y: number): boolean {
  return y >= ACTIVE_LAYER_MIN_Y;
}

// ── 尺寸 / 不透明度 / 边宽 ──────────────────────────────────────────

/** `importance` → 半径（世界单位，等价于详设里的 3–12px） */
export function radiusForImportance(importance: number): number {
  return 3 + 9 * clamp01(importance);
}

/**
 * 选中高亮的放大倍数：2D / 3D 共用同一个数。
 *
 * 两视图的选中态要"看起来是同一件事"——3D 里放大的是球体直径，2D 里放大的是
 * 圆点半径，倍数一致才能让"点一下、换个视图还是它"读得出来（P2-03）。
 */
export const FOCUS_SCALE = 1.9;

/** `strength` → 不透明度 `0.35 + 0.65s` */
export function alphaForStrength(strength: number): number {
  return 0.35 + 0.65 * clamp01(strength);
}

/** `edge.confidence` → 边宽 `0.5 + 1.5c`（px） */
export function edgeWidthForConfidence(confidence: number): number {
  return 0.5 + 1.5 * clamp01(confidence);
}

/** 访问活跃度（0–1，已归一化）→ 流动速度；0 即静止 */
export function flowSpeedForActivity(activity: number): number {
  return 0.6 * clamp01(activity);
}

/** `access_count` 按本批最大值归一化；全 0 时一律 0（避免除零） */
export function normalizeActivity(accessCount: number, maxAccess: number): number {
  if (!Number.isFinite(accessCount) || !Number.isFinite(maxAccess) || maxAccess <= 0) return 0;
  return clamp01(accessCount / maxAccess);
}

// ── 查询命中脉冲 ────────────────────────────────────────────────────

/** 脉冲持续 2s */
export const PULSE_DURATION_S = 2;

/** `scale *= 1 + 0.6·sin(8t)·e^(−t/2)`，窗口外恒为 1 */
export function pulseScale(t: number): number {
  if (!Number.isFinite(t) || t < 0 || t > PULSE_DURATION_S) return 1;
  return 1 + 0.6 * Math.sin(t * 8) * Math.exp(-t / 2);
}

// ── 下沉动画 ────────────────────────────────────────────────────────

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

/** 下沉动画时长（详设要求 2–3s，取中值 2.5s） */
export const SINK_DURATION_MS = 2500;

/**
 * 跨层过渡：从 `fromY` 到 `toY`，`elapsedMs` 走 `easeOutCubic`。
 * 永远不瞬移——`strength` 从 0.8 掉到 0.2 时，Y 必须在这 2.5s 里滑下去。
 */
export function sinkY(fromY: number, toY: number, elapsedMs: number, durationMs = SINK_DURATION_MS): number {
  if (durationMs <= 0) return toY;
  const t = clamp01(elapsedMs / durationMs);
  return fromY + (toY - fromY) * easeOutCubic(t);
}

// ── 颜色 ────────────────────────────────────────────────────────────

/** `#rrggbb` → `[r, g, b]`，分量 0–1；非法输入给中性灰 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null || m[1] === undefined) return [0.6, 0.6, 0.6];
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export function ftypeColor(ftype: string): [number, number, number] {
  const hex = (FTYPE_HEX as Record<string, string | undefined>)[ftype] ?? FTYPE_HEX.semantic;
  return hexToRgb(hex);
}

/** 兼容详设表里的短名（`mutex` / `derived`）与库里的全名 */
const ETYPE_ALIAS: Record<string, string> = {
  mutex: 'mutually_exclusive',
  derived: 'derived_from',
};

export function etypeColor(etype: string): [number, number, number] {
  const key = ETYPE_ALIAS[etype] ?? etype;
  const hex = (ETYPE_HEX as Record<string, string | undefined>)[key] ?? ETYPE_HEX.derived_from;
  return hexToRgb(hex);
}

/** `aType` 用的下标（未知类型落到 `derived_from` 的槽位） */
export function etypeIndex(etype: string): number {
  const key = ETYPE_ALIAS[etype] ?? etype;
  const i = (ETYPE_ORDER as readonly string[]).indexOf(key);
  return i < 0 ? ETYPE_ORDER.length - 1 : i;
}

/** `ETYPE_ORDER` 对应的 rgb 常量，供 shader uniform 一次写死 */
export function etypeColorTable(): [number, number, number][] {
  return ETYPE_ORDER.map((e) => hexToRgb(ETYPE_HEX[e]));
}

// ── 双态视觉规范（详设 §10.3.1；台账 D-88 / D-89 / I-15）──────────────
//
// 一句话：**画布默认沉默，只有"被调用"的那一小块亮起来**。全量高亮等于没有高亮。
// 这张表是 2D 与 3D 的**唯一**参数来源：`Graph2D` 与 `Graph3D` 都调下面两个函数，
// 谁想再写一套色表/透明度表，就是在制造"两个视图看起来不是同一个库"。

/** 三种视觉状态：沉默（存量）/ 次级（命中节点的 1-hop）/ 活跃（此刻被调用） */
export type VisualState = 'dormant' | 'secondary' | 'active';

/** 活跃态 TTL（详设要求 4–6s，取中值 5s） */
export const ACTIVITY_TTL_MS = 5000;
/** 活跃态末段的淡出时长：让 `exp(-t/2)` 在 TTL 处落到 0，而不是"啪"一下关掉 */
export const ACTIVITY_FADE_MS = 800;
/** 衰减时间常数：`exp(-t/2)`（t 以秒计） */
export const DECAY_TAU_S = 2;
/** 并发上限：活跃节点 ≤ 64、活跃边 ≤ 256（超限按 importance / confidence 截断） */
export const ACTIVE_NODE_CAP = 64;
export const ACTIVE_EDGE_CAP = 256;
/** "跳跃"观感：路径上每隔 180ms 依次触发节点脉冲 */
export const WAVE_STEP_MS = 180;

/** 沉默态包络透明度（只给"有边界"的暗示）／活跃态所属社区 */
export const ENVELOPE_DORMANT = 0.015;
export const ENVELOPE_ACTIVE = 0.06;

/**
 * 活跃度权重：`exp(-t/2)`，末段 `ACTIVITY_FADE_MS` 内线性压到 0。
 *
 * 只用 `exp` 会在 TTL 处从 0.082 硬切到 0（光晕"啪"一下消失）；加一段淡出既保留
 * 指数回落的手感，又保证收尾连续。窗口外一律 0。
 */
export function decayWeight(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (ageMs >= ACTIVITY_TTL_MS) return 0;
  const tail = clamp01((ACTIVITY_TTL_MS - ageMs) / ACTIVITY_FADE_MS);
  return Math.exp(-ageMs / 1000 / DECAY_TAU_S) * tail;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 1) + 1) % 1;
  const sat = clamp01(s);
  const light = clamp01(l);
  if (sat === 0) {
    const v = Math.round(light * 255);
    return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number): number => {
    const tt = ((t % 1) + 1) % 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const to255 = (x: number): string =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to255(channel(hue + 1 / 3))}${to255(channel(hue))}${to255(channel(hue - 1 / 3))}`;
}

/**
 * 去饱和 + 压明度：`satKeep` 保留多少饱和度，`lightScale` 乘在明度上。
 *
 * 沉默态 `(0.2, 0.45)`、次级 `(0.5, 1.0)`（详设 §10.3.1 参数表前两行）。
 */
export function dimHex(hex: string, satKeep: number, lightScale: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex(h, s * clamp01(satKeep), l * lightScale);
}

export interface NodeVisual {
  /** 节点色（hex）：沉默/次级去过饱和，活跃是原色 */
  color: string;
  /** 不透明度 */
  opacity: number;
  /** 尺寸倍数（沉默 ×0.85） */
  scale: number;
  /** 光晕不透明度，0 = 关（沉默与次级都不发光） */
  halo: number;
  /** 是否允许出标签（只有活跃态允许） */
  label: boolean;
}

/** 节点三态参数（详设 §10.3.1 参数表）。`decay` 只影响光晕的 0.2→0.35 回落 */
export function nodeVisual(state: VisualState, ftype: string, strength: number, decay = 1): NodeVisual {
  const base = (FTYPE_HEX as Record<string, string | undefined>)[ftype] ?? FTYPE_HEX.semantic;
  const s = clamp01(strength);
  if (state === 'active') {
    return {
      color: base,
      opacity: 0.85 + 0.15 * s,
      scale: 1,
      halo: 0.2 + 0.15 * clamp01(decay),
      label: true,
    };
  }
  if (state === 'secondary') {
    return { color: dimHex(base, 0.5, 1), opacity: 0.35 + 0.35 * s, scale: 1, halo: 0, label: false };
  }
  return { color: dimHex(base, 0.2, 0.45), opacity: 0.1 + 0.12 * s, scale: 0.85, halo: 0, label: false };
}

export interface EdgeVisual {
  /** 不透明度（0.05 / 0.25 / 0.55+0.35c） */
  opacity: number;
  /** 流动速度倍数，0 = 静止 */
  flow: number;
  /** 2D 的"流动"替身：活跃边加粗（2D 没有 dash 动画，见详设 §10.3.1 注脚） */
  width: number;
}

export function edgeVisual(state: VisualState, confidence: number, decay = 1): EdgeVisual {
  const c = clamp01(confidence);
  if (state === 'active') return { opacity: 0.55 + 0.35 * c, flow: flowSpeedForActivity(decay), width: 1.5 };
  if (state === 'secondary') return { opacity: 0.25, flow: 0, width: 1.2 };
  return { opacity: 0.05, flow: 0, width: 1 };
}
