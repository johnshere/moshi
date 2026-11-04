/**
 * 图谱纯视觉辅助（P2-19-B）：方向箭头采样、扫描环角度、网格雾衰减。
 *
 * 与 `encoding.ts` / `palette.ts` 同层：只做数学，不碰 DOM / three / sigma，
 * 根 `vitest`（node 环境）直接测。shader 里用的是同一条公式，常量在这里定义，
 * 避免"单测测的是一条、shader 跑的是另一条"。
 */
import { clamp01 } from './encoding.js';

/** 2D 视口内同屏最多画多少支方向箭头（按密度跳采样，不是每边一支） */
export const ARROW_MAX_2D = 140;

/** 边在屏幕上的长度短于这个值就不画箭头（挤在一起只是噪点） */
export const ARROW_MIN_LENGTH_PX = 18;

/** 箭头沿边前进的基准速度（世界/秒的相位比例） */
export const ARROW_SPEED = 0.35;

/**
 * 密度裁剪：N 条可见证据边、最多画 `max` 支 → 每隔 `stride` 条画一支。
 * 返回值至少 1，保证"只有一条边时也画"。
 */
export function arrowStride(visibleEdges: number, max = ARROW_MAX_2D): number {
  if (!Number.isFinite(visibleEdges) || !Number.isFinite(max) || max <= 0) return 1;
  if (visibleEdges <= 0) return 1;
  return Math.max(1, Math.ceil(visibleEdges / max));
}

/** 箭头在边上的参数 t ∈ [0,1)：随时间与 hop 相位推进；flow=0 时停在 0（静止）。 */
export function arrowPhase(elapsedS: number, flow: number, hopPhase: number, speed = ARROW_SPEED): number {
  if (!Number.isFinite(elapsedS) || !Number.isFinite(flow) || !Number.isFinite(hopPhase)) return 0;
  const raw = elapsedS * flow * speed + hopPhase;
  return ((raw % 1) + 1) % 1;
}

export interface ProjectedEdge {
  /** 屏幕坐标（src → dst），调用方已做 viewport 变换 */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  mass: number;
  flow: number;
  hopPhase: number;
  /** 1 = 与几何方向相反（trace 的传播方向） */
  dir: 0 | 1;
}

export interface ArrowPlacement {
  x: number;
  y: number;
  /** 指向 dst 的屏幕角度（rad） */
  angle: number;
  mass: number;
}

/**
 * 一条边上的箭头位置/朝向：`dir=1` 时从 dst 量到 src（证据传播方向），
 * t=0 在起点、t→1 在终点前一点（不压到节点上）。
 */
export function placeArrow(edge: ProjectedEdge, t: number): ArrowPlacement {
  const fromX = edge.dir === 1 ? edge.bx : edge.ax;
  const fromY = edge.dir === 1 ? edge.by : edge.ay;
  const toX = edge.dir === 1 ? edge.ax : edge.bx;
  const toY = edge.dir === 1 ? edge.ay : edge.by;
  const tt = 0.06 + 0.88 * clamp01(t);
  return {
    x: fromX + (toX - fromX) * tt,
    y: fromY + (toY - fromY) * tt,
    angle: Math.atan2(toY - fromY, toX - fromX),
    mass: clamp01(edge.mass),
  };
}

/** 屏幕长度：用来做密度裁剪（太短不画） */
export function screenLength(edge: ProjectedEdge): number {
  const dx = edge.bx - edge.ax;
  const dy = edge.by - edge.ay;
  return Math.hypot(dx, dy);
}

// ── 选中扫描环（3D shader 与测试共用同一组数）──────────────────────

/** 扫描角速度（rad/s）：转一圈约 3.6s */
export const SCAN_SPEED = 1.75;

/** 扫描环的角宽（rad）：越小越像一道细扫描线 */
export const SCAN_WIDTH = 0.85;

/** 当前扫描角 0–2π */
export function scanAngle(elapsedS: number, speed = SCAN_SPEED): number {
  if (!Number.isFinite(elapsedS)) return 0;
  const tau = Math.PI * 2;
  return ((elapsedS * speed) % tau + tau) % tau;
}

/** 角度与扫描线的最短角距（0–π） */
export function angularDistance(angle: number, scan: number): number {
  const tau = Math.PI * 2;
  const d = Math.abs(((angle - scan + Math.PI) % tau + tau) % tau - Math.PI);
  return d;
}

/** 扫描带强度：离扫描线越近越亮，0–1（shader 里是 `1 - smoothstep(0, SCAN_WIDTH, d)`） */
export function scanBand(angle: number, scan: number, width = SCAN_WIDTH): number {
  const d = angularDistance(angle, scan);
  return clamp01(1 - d / width);
}

// ── 节点环遮罩（与 shader 的 rim 公式对齐）─────────────────────────

/** 球面 rim 值：0 = 正对相机（内芯），1 = 轮廓边缘 */
export function sphereRim(normalViewZ: number): number {
  if (!Number.isFinite(normalViewZ)) return 0;
  return clamp01(1 - Math.abs(normalViewZ));
}

/** 环带强度（0.74–0.86 亮起，0.96 后收掉）：与 shader 的 smoothstep 同参 */
export function ringBand(rim: number): number {
  return smoothstep(0.74, 0.86, rim) * (1 - smoothstep(0.96, 1.0, rim));
}

/** 内芯亮度：中心 1，rim 0.45 之后收掉 */
export function coreGlow(rim: number): number {
  return 1 - smoothstep(0.0, 0.45, rim);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ── 2D 网格雾：缩放越大越淡，避免摩尔纹 ───────────────────────────

/** 网格透明度：缩放比例 0–1 时给 0.12–0.42 之间的过渡，超出范围夹住 */
export function gridOpacity(zoom: number): number {
  if (!Number.isFinite(zoom)) return 0;
  const t = clamp01(zoom);
  return 0.42 - 0.3 * t;
}
