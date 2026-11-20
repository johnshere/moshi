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
  | '--color-border-subtle'
  // 画布舞台（深场）：外壳可以是亮的，但点线在浅底上会被加法混合冲成白色
  | '--color-stage-base'
  | '--color-stage-raised'
  | '--color-stage-text'
  | '--color-stage-grid'
  // 字体族：标签/读数要跟外壳同一套字形（canvas 与 CSS2D 都拿不到继承）
  | '--font-ui'
  | '--font-mono';

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
  '--color-stage-base': '#05070d',
  '--color-stage-raised': '#0b1020',
  '--color-stage-text': '#e2e8f0',
  '--color-stage-grid': '#1e293b',
  '--font-ui': "'Segoe UI Variable Text', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
  '--font-mono': "'Cascadia Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace",
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
  procedural: '#34d399',
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
  // 舞台色：与外壳主题解耦，亮色外壳下画布仍是深场（见 app.css 的 --color-stage-*）
  return readToken('--color-stage-base');
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

/** 3D 背景：深场底 + 两团冷光（DOM 层，不占 3D draw call）
 *  只用「荧光青 + 月光」两枚冷色：紫调留给第二数据序列，不拿来做环境光。 */
export function sceneBackdropCss(): string {
  const base = bgBaseHex();
  const raised = readToken('--color-stage-raised');
  const glow = glowHex();
  const accent = accentHex();
  return [
    `radial-gradient(88% 66% at 34% 16%, ${mixWithTransparent(glow, 9)}, transparent 60%)`,
    `radial-gradient(110% 85% at 70% 80%, ${mixWithTransparent(accent, 7)}, transparent 68%)`,
    `linear-gradient(180deg, ${base} 0%, ${raised} 46%, ${base} 100%)`,
  ].join(', ');
}

/** 3D 雾：四周向背景色收拢（DOM 层，压在 canvas 之上、标签之下） */
export function sceneVignetteCss(): string {
  const base = bgBaseHex();
  return `radial-gradient(120% 100% at 50% 44%, transparent 42%, ${mixWithTransparent(base, 72)} 78%, ${base} 100%)`;
}

/** 2D 网格：24px 细格 + 144px 主格（两级参照系），透明度由 Graph2D 按缩放调 */
export function gridCss(): string {
  // `--color-stage-grid` 自带 0.1 alpha，再 color-mix 会二次相乘到看不见；
  // 所以两级格线都从舞台字色派生 alpha（同一冷色相，只是浓淡不同）。
  const ink = readToken('--color-stage-text');
  const fine = withAlpha(ink, 0.05);
  const major = withAlpha(ink, 0.11);
  const cell = 24;
  const block = cell * 6;
  return [
    `repeating-linear-gradient(0deg, ${fine} 0, ${fine} 1px, transparent 1px, transparent ${cell}px)`,
    `repeating-linear-gradient(90deg, ${fine} 0, ${fine} 1px, transparent 1px, transparent ${cell}px)`,
    `repeating-linear-gradient(0deg, ${major} 0, ${major} 1px, transparent 1px, transparent ${block}px)`,
    `repeating-linear-gradient(90deg, ${major} 0, ${major} 1px, transparent 1px, transparent ${block}px)`,
  ].join(', ');
}

/** 2D 背景：单团冷光（screen 混合只提亮不遮挡） */
export function stageGlowCss(): string {
  return [
    `radial-gradient(64% 50% at 50% 44%, ${mixWithTransparent(glowHex(), 7)}, transparent 72%)`,
    `radial-gradient(88% 70% at 68% 78%, ${mixWithTransparent(accentHex(), 5)}, transparent 74%)`,
  ].join(', ');
}

/** 3D 标签：等宽数字 + 方灯底片（读数感，替换原来的 hex 内联样式） */
export function labelCss(): string {
  const color = readToken('--color-stage-text');
  const base = bgBaseHex();
  const grid = readToken('--color-stage-grid');
  return `color:${color};font:11px/1.25 ui-sans-serif,system-ui;font-variant-numeric:tabular-nums;letter-spacing:0.01em;text-shadow:0 0 4px ${base},0 0 8px ${base};white-space:nowrap;padding:1px 4px;border-radius:2px;border:1px solid ${mixWithTransparent(grid, 55)};background:${mixWithTransparent(base, 62)};`;
}

/** sigma 标签色：与 3D 标签同一个舞台字色 */
export function labelColorCss(): string {
  return readToken('--color-stage-text');
}

/** sigma 标签底片：深场裁片，保证压在亮节点上也读得清 */
export function labelBgCss(): string {
  return mixWithTransparent(bgBaseHex(), 58);
}

/** sigma 标签字体族（`--font-ui`：中文正文字形，等宽只留给读数） */
export function labelFontFamilyCss(): string {
  return readToken('--font-ui');
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

// ── 仪器件：选中环 / 邻域 / 悬停读数（2D overlay 与 3D DOM 共用）──────

/** 选中节点准星与外环：accent，1px 级信号，不做实底 */
export function reticleColorCss(): string {
  return withAlpha(accentHex(), 0.92);
}

/** 选中环的内环 / 邻域环：同色低一档 */
export function neighborRingCss(): string {
  return withAlpha(accentHex(), 0.45);
}

/** 选中节点的邻域（1 跳）连线：只做关系提示，不抢节点 */
export function neighborEdgeCss(): string {
  return withAlpha(accentHex(), 0.26);
}

/** 1 跳邻域节点的细环：比选中环再低一档 */
export function neighborRingSoftCss(): string {
  return withAlpha(accentHex(), 0.28);
}

/** 选中节点的方向箭头：glow 细三角，表达 in/out 而不抢色 */
export function directionArrowCss(): string {
  return withAlpha(glowHex(), 0.6);
}

/** 等宽字体栈（canvas / DOM 读数，值来自 --font-mono） */
export function monoFontCss(): string {
  return readToken('--font-mono');
}

/** 2D 悬停读数牌：贴光标、等宽、方角、左侧 2px 信号条 */
export function hoverChipCss(): string {
  const accent = accentHex();
  const base = bgBaseHex();
  const mono = readToken('--font-mono');
  return [
    'position:absolute',
    'z-index:6',
    'pointer-events:none',
    'display:none',
    'transform:translate(14px, 14px)',
    `background:${mixWithTransparent(base, 86)}`,
    `border:1px solid ${withAlpha(accent, 0.38)}`,
    `border-left:2px solid ${withAlpha(accent, 0.9)}`,
    'border-radius:2px',
    `color:${readToken('--color-stage-text')}`,
    `font:11px/1.5 ${mono}`,
    'font-variant-numeric:tabular-nums',
    'letter-spacing:0.01em',
    'padding:4px 8px',
    'white-space:nowrap',
    `box-shadow:0 0 0 1px ${mixWithTransparent(base, 60)}`,
  ].join(';') + ';';
}

/** 3D 选中扫描光的颜色（shader uniform）：accent → 0–1 rgb，替代原来的纯白扫光 */
export function selectionSweepRgb(): [number, number, number] {
  return selectionRingRgb();
}
