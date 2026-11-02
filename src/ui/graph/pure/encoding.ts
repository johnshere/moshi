/**
 * 视觉编码的纯函数（详设 §10.3「视觉编码表」逐行落成代码）。
 *
 * 这个文件**只能有数学**：不 import three、不碰 DOM、不看 window。
 * 理由有两个：
 * 1. 根工程的 `pnpm typecheck` / `vitest` 会顺着测试的 import 把这里拉进 Node 侧编译，
 *    一旦引入 three 或 DOM 类型，根 tsconfig（lib 里没有 DOM）就会炸。
 * 2. 单测能直接断言数值，不需要 WebGL（jsdom 里跑不了 WebGL）。
 */

// ── 色板（详设 §10.3 表，一个字母都不改）─────────────────────────────

/** `fact.ftype` → 色相 */
export const FTYPE_HEX = {
  semantic: '#22d3ee',
  episodic: '#a78bfa',
  conditional: '#f59e0b',
} as const;

/** `edge.etype` → 色相；键用库里的真实枚举值（`mutually_exclusive` / `derived_from`） */
export const ETYPE_HEX = {
  depends_on: '#8b5cf6',
  logic: '#06b6d4',
  mutually_exclusive: '#f59e0b',
  co_occur: '#6b7280',
  supersedes: '#ef4444',
  derived_from: '#475569',
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
