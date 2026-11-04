/**
 * 颜色 token 契约（P2-19-B，D-133）。
 *
 * 本文件是 `src/ui/graph/**` 里**唯一**允许出现颜色字面量的地方：其他文件只能从这里
 * 取色（`readToken` / `ftypeHex` / `etypeHex` / `*Css`）。等 task-29 把 token 写进
 * `src/ui/styles/app.css` 后，运行时自动以 CSS 变量为准；token 未就绪时用下面这份
 * fallback（与 P2-03 的旧色板逐字相同，删 fallback 时视觉不会跳一次）。
 *
 * 约束：
 * - 不 import three / sigma，根 `vitest`（node 环境）可以直接 import；
 * - 没有 `document` 时（node 测试）只返回 fallback，不抛错；
 * - `getComputedStyle` 的读取结果做进程内缓存：一次会话只读一次，避免每帧查样式。
 */

export type PaletteToken =
  | '--color-bg-base'
  | '--color-bg-raised'
  | '--color-accent'
  | '--color-accent-alt'
  | '--color-glow'
  | '--color-text-primary'
  | '--color-text-secondary'
  | '--color-text-muted'
  | '--color-danger'
  | '--color-border-subtle';

/** token 名固定（与 task-29 的 CSS 变量对齐）；fallback 是旧色板的值 */
const TOKEN_FALLBACK: Record<PaletteToken, string> = {
  '--color-bg-base': '#05070d',
  '--color-bg-raised': '#0b1020',
  '--color-accent': '#22d3ee',
  '--color-accent-alt': '#a78bfa',
  '--color-glow': '#7dd3fc',
  '--color-text-primary': '#e2e8f0',
  '--color-text-secondary': '#94a3b8',
  '--color-text-muted': '#64748b',
  '--color-danger': '#ef4444',
  '--color-border-subtle': '#1e293b',
};

/** 纯白：光晕贴图/高光的内核色（不属于 token 表，集中在这里） */
const INK = '#ffffff';

/**
 * `fact.ftype` 的色相。语义色尽量挂到 token 上（`accent` / `accent-alt`），
 * `conditional` 没有对应 token，用旧值兜底。
 */
const FTYPE_FALLBACK = {
  semantic: '#22d3ee',
  episodic: '#a78bfa',
  conditional: '#f59e0b',
} as const;

/** `edge.etype` 的色相（旧色板原值；`danger` / `text-muted` / `border-subtle` 可映射到 token） */
const ETYPE_FALLBACK = {
  depends_on: '#8b5cf6',
  logic: '#06b6d4',
  mutually_exclusive: '#f59e0b',
  co_occur: '#6b7280',
  supersedes: '#ef4444',
  derived_from: '#475569',
} as const;

const cache = new Map<string, string>();

/** 结构化的全局访问面：根 tsconfig 没有 DOM lib，不能用 `document` 标识符，
 * 这里只声明"如果存在长这样"，浏览器里成立、node 里为 undefined。 */
interface StyleReader {
  getPropertyValue(name: string): string;
}
interface PaletteGlobal {
  document?: { documentElement?: object | null } | null;
  getComputedStyle?: (el: object) => StyleReader;
}

/** 测试用：清掉缓存，让下一次读取重新走 `getComputedStyle` */
export function resetPaletteCache(): void {
  cache.clear();
}

/** 读一个颜色 token：CSS 变量优先，空值/异常时回落 fallback；结果缓存 */
export function readToken(token: PaletteToken): string {
  const hit = cache.get(token);
  if (hit !== undefined) return hit;
  let value = '';
  const g = globalThis as PaletteGlobal;
  const el = g.document?.documentElement;
  if (el !== undefined && el !== null && typeof g.getComputedStyle === 'function') {
    try {
      value = g.getComputedStyle(el).getPropertyValue(token).trim();
    } catch {
      value = '';
    }
  }
  const resolved = value === '' ? TOKEN_FALLBACK[token] : value;
  cache.set(token, resolved);
  return resolved;
}

export function ftypeHex(ftype: string): string {
  const key = ftype as keyof typeof FTYPE_FALLBACK;
  const fallback = FTYPE_FALLBACK[key] ?? FTYPE_FALLBACK.semantic;
  // 语义/情景两色跟随 token；conditional 没有 token，直接返回 fallback
  if (ftype === 'semantic') return readToken('--color-accent');
  if (ftype === 'episodic') return readToken('--color-accent-alt');
  return fallback;
}

export function etypeHex(etype: string): string {
  const key = etype as keyof typeof ETYPE_FALLBACK;
  const fallback = ETYPE_FALLBACK[key] ?? ETYPE_FALLBACK.derived_from;
  if (etype === 'logic') return readToken('--color-accent');
  if (etype === 'supersedes') return readToken('--color-danger');
  if (etype === 'co_occur') return readToken('--color-text-muted');
  if (etype === 'derived_from') return readToken('--color-border-subtle');
  return fallback;
}

// ── hex / rgba 派生 ─────────────────────────────────────────────────

/** `#rrggbb` → 0–255 三段；非法输入给中性灰 */
function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null || m[1] === undefined) return [150, 150, 150];
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** `hex` + alpha → `rgba(...)`（本文件外不允许写 `rgba(...)` 字面量） */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  const a = Math.min(Math.max(alpha, 0), 1);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** `color-mix` 派生：把 token 色按百分比与透明混合（背景/网格/边框都用它） */
export function mixWithTransparent(hex: string, percent: number): string {
  const p = Math.min(Math.max(percent, 0), 100);
  return `color-mix(in srgb, ${hex} ${p}%, transparent)`;
}

export function mixWith(hex: string, other: string, percent: number): string {
  const p = Math.min(Math.max(percent, 0), 100);
  return `color-mix(in srgb, ${hex} ${p}%, ${other})`;
}

// ── 具体用途的取色（graph 目录其他文件只调这些）─────────────────────

export function bgBaseHex(): string {
  return readToken('--color-bg-base');
}

export function accentHex(): string {
  return readToken('--color-accent');
}

export function glowHex(): string {
  return readToken('--color-glow');
}

export function dangerHex(): string {
  return readToken('--color-danger');
}

/** 3D 背景：深空蓝紫底 + 两团径向雾（DOM 层，不占 3D draw call） */
export function sceneBackdropCss(): string {
  const base = bgBaseHex();
  const raised = readToken('--color-bg-raised');
  const glow = glowHex();
  const accentAlt = readToken('--color-accent-alt');
  return [
    `radial-gradient(90% 70% at 30% 18%, ${mixWithTransparent(accentAlt, 16)}, transparent 62%)`,
    `radial-gradient(110% 85% at 72% 78%, ${mixWithTransparent(glow, 12)}, transparent 66%)`,
    `linear-gradient(180deg, ${base} 0%, ${raised} 48%, ${base} 100%)`,
  ].join(', ');
}

/** 3D 雾：四周向背景色收拢（DOM 层，压在 canvas 之上、标签之下） */
export function sceneVignetteCss(): string {
  const base = bgBaseHex();
  return `radial-gradient(120% 100% at 50% 44%, transparent 42%, ${mixWithTransparent(base, 72)} 78%, ${base} 100%)`;
}

/** 2D 网格：双轴细线 + 中心向外淡出（网格雾），透明度由 Graph2D 按缩放调 */
export function gridCss(): string {
  const line = mixWithTransparent(readToken('--color-border-subtle'), 42);
  const cell = 44;
  return [
    `repeating-linear-gradient(0deg, ${line} 0, ${line} 1px, transparent 1px, transparent ${cell}px)`,
    `repeating-linear-gradient(90deg, ${line} 0, ${line} 1px, transparent 1px, transparent ${cell}px)`,
  ].join(', ');
}

/** 2D 背景：径向光晕 + 底色（DOM 层，压在 sigma canvas 之上，用 screen 混合只提亮不遮挡） */
export function stageGlowCss(): string {
  const glow = glowHex();
  const accentAlt = readToken('--color-accent-alt');
  return [
    `radial-gradient(70% 55% at 48% 42%, ${mixWithTransparent(glow, 10)}, transparent 70%)`,
    `radial-gradient(85% 65% at 70% 76%, ${mixWithTransparent(accentAlt, 8)}, transparent 72%)`,
  ].join(', ');
}

/** 3D 标签：颜色 + 双层描边（替换原来的 hex 内联样式） */
export function labelCss(): string {
  const color = readToken('--color-text-primary');
  const base = bgBaseHex();
  return `color:${color};font:11px/1.2 ui-sans-serif,system-ui;text-shadow:0 0 4px ${base},0 0 8px ${base};white-space:nowrap;padding:1px 3px;border-radius:3px;`;
}

/** 3D 网页光晕贴图的三段 stop（内芯 → 中段 → 外圈透明） */
export function haloStops(): [string, string, string] {
  return [withAlpha(INK, 0.9), withAlpha(glowHex(), 0.28), withAlpha(glowHex(), 0)];
}

/** 2D 框选：边框 / 填充（原来是 rgba 字面量） */
export function boxBorderCss(): string {
  return withAlpha(glowHex(), 0.85);
}

export function boxFillCss(): string {
  return withAlpha(accentHex(), 0.12);
}

/** 2D 箭头：证据流的方向箭头用强调色，透明度按 mass 走 */
export function arrowCss(mass: number): string {
  return withAlpha(glowHex(), 0.35 + 0.5 * Math.min(Math.max(mass, 0), 1));
}

/** 选中扫描环（shader uniform）：accent 色转 0–1 rgb */
export function selectionRingRgb(): [number, number, number] {
  const [r, g, b] = parseHex(accentHex());
  return [r / 255, g / 255, b / 255];
}

/** 3D 四层参考平面的颜色：活跃层 accent / 中低层 muted / 失效层 danger */
export function layerPlaneHexes(): [string, string, string, string] {
  return [
    readToken('--color-accent'),
    readToken('--color-text-muted'),
    readToken('--color-border-subtle'),
    readToken('--color-danger'),
  ];
}
