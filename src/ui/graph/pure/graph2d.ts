/**
 * 2D 视图（sigma）的纯映射层（P2-03）：布局 → 平面坐标，以及颜色/尺寸/透明度的取值。
 *
 * 与 `encoding.ts` / `geometry.ts` 同层：没有 DOM、没有 three、没有 sigma / graphology，
 * 根 `vitest`（node 环境）直接测——这几条映射"算错了也看不出来"（点选能对上、颜色错了
 * 也像对的），所以钉在测试里。
 *
 * 三条规矩：
 * 1. **坐标只从布局表来**：`projectTo2D` 只吃 `layout.x` / `layout.z`。布局的 Y 是
 *    strength 分层（详设 §10.3 的 ±60 / −100 四层），不是空间轴，二维平面上没有它的
 *    对应物——丢掉它，绝不拿它参与投影。
 * 2. 颜色 / 尺寸 / 失效区分全部转调 `encoding.ts`，这里不许出现第二套色表。
 * 3. 不 import `api.ts`：它带 `window` / `fetch`，根 `tsconfig` 的 lib 只有 ES2023，
 *    拉进来会让 `pnpm typecheck` 报 DOM 类型缺失。用结构化的入参类型代替。
 */
import {
  FOCUS_SCALE,
  clamp01,
  edgeVisual,
  edgeWidthForConfidence,
  etypeColor,
  ftypeColor,
  isInvalidated,
  dimHex,
  nodeVisual,
  radiusForImportance,
  type VisualState,
} from './encoding.js';

/** 2D 标签最多显示多少字符：sigma 的标签不换行，过长会盖住半张图 */
export const LABEL_MAX_CHARS = 26;

/**
 * 2D 的 alpha 重映射（台账 D-92 / D-93）。
 *
 * 详设 §10.3.1 的 alpha 是给 **3D 加法混合** 写的：6000 条边每条 0.05 的 alpha 叠在一起
 * 能形成一层可见的网，2000 个 0.10 的节点靠亮度累加也有实体感。sigma 是**一次成图**、
 * 透明按 over 合成，同一个 0.05 在深色底上就是几乎看不见——照抄数字会得到一张空图。
 *
 * 所以 2D 不照抄绝对值，只保留表里的**相对关系**（沉默 ≪ 次级 < 活跃），把整个区间抬进
 * 可见范围。节点与边**用两条不同的曲线**：实测同一条线性曲线要么把节点压得看不见、
 * 要么把 6000 条边叠成灰雾——节点的下限必须比边高一大截，图才既看得清团块又不糊。
 */
export function to2DAlphaNode(alpha: number): number {
  // 节点是"图的主体"：抬得更狠（0.38 起），沉默态也还看得见团块轮廓
  return clamp01(0.38 + 0.62 * clamp01(alpha));
}

export function to2DAlphaEdge(alpha: number): number {
  // 边是"背景纹理"：抬得轻（0.06 起），否则 6000 条边叠成一层雾，
  // 沉默态的图会从"淡淡的网"变成"糊掉的灰"
  return clamp01(0.06 + 0.94 * clamp01(alpha));
}

/** 沉默态节点的颜色兜底：`nodeVisual` 的 20% 饱和 / ×0.45 明度在 3D 加法混合下还能看，
 *  在 2D 的 over 合成 + 近黑底上就是一团黑。2D 只把它调到"暗但认得出色相"。 */
const DORMANT_NODE_SAT_KEEP = 0.55;
const DORMANT_NODE_LIGHT_SCALE = 0.72;

/** 沉默态边的颜色兜底：同理，边比节点再暗一档，避免整张图被边糊住 */
const DORMANT_EDGE_SAT_KEEP = 0.35;
const DORMANT_EDGE_LIGHT_SCALE = 0.55;

/** `node2DAttrs` 的入参：`GraphNode` 的子集，避免 import `api.ts`（见文件头第 3 条） */
export interface Node2DInput {
  x: number;
  y: number;
  z: number;
  ftype: string;
  importance: number;
  strength: number;
  label: string;
}

export interface Node2DAttrs {
  x: number;
  y: number;
  size: number;
  color: string;
  opacity: number;
  label: string;
  /** 选中前的原始半径：高亮时 `size = baseSize * FOCUS_SCALE`，取消时按它还原 */
  baseSize: number;
  labelVisibility: 'auto' | 'visible';
}

/**
 * 布局 `(x, z)` → sigma 的图坐标 `(x, y)`。
 *
 * sigma 只认二维坐标，所以 `y` 这个槽位装的是布局的 `z`。这是 P2-03 唯一的坐标变换，
 * 也是"2D 与 3D 看的是同一张布局表"的落点（详设 §10.1 补注 / 台账 D-90）。
 */
export function projectTo2D(node: { x: number; z: number }): { x: number; y: number } {
  return { x: node.x, y: node.z };
}

function toHex(rgb: [number, number, number]): string {
  const parts = rgb.map((v) => {
    const clamped = Math.min(Math.max(v, 0), 1);
    return Math.round(clamped * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${parts.join('')}`;
}

/** `ftype` → 与 3D 同一张色表（`encoding.ftypeColor`），只是转成 sigma 要的 hex */
export function nodeColorHex(ftype: string): string {
  return toHex(ftypeColor(ftype));
}

/** `etype` → 与 3D 同一个边色（含 `mutex` / `derived` 别名） */
export function edgeColorHex(etype: string): string {
  return toHex(etypeColor(etype));
}

/**
 * `strength` → 不透明度（**沉默态**的取值，见表 `nodeVisual`）。
 *
 * 3D 里"失效"还有 Y = −100 的墓碑层这条通道，2D 是单平面，只剩透明度可用，所以把
 * `isInvalidated` 压到沉默态的下限（strength = 0 那一档）。这是 2D 里失效节点唯一的
 * 视觉区分——详见台账 D-93。
 */
export function nodeOpacity(node: { strength: number; label: string }): number {
  const raw = nodeVisual('dormant', 'semantic', node.strength).opacity;
  return to2DAlphaNode(isInvalidated(node) ? nodeVisual('dormant', 'semantic', 0).opacity : raw);
}

export function shortLabel(label: string, max = LABEL_MAX_CHARS): string {
  const text = label.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 节点样式：`state` 决定色相/透明度/尺寸，全部转调 `encoding.nodeVisual`。
 *
 * 默认 `dormant`——**沉默是常态**。活跃/次级只由 `useActivity` 的快照驱动，
 * 不允许调用方"顺手给个亮的状态"（那会让默认视图又变成满屏高亮）。
 */
export function node2DAttrs(node: Node2DInput, state: VisualState = 'dormant'): Node2DAttrs {
  const visual = nodeVisual(state, node.ftype, node.strength);
  const size = radiusForImportance(node.importance) * visual.scale;
  const rawOpacity = isInvalidated(node)
    ? Math.min(visual.opacity, nodeVisual('dormant', node.ftype, 0).opacity)
    : visual.opacity;
  return {
    ...projectTo2D(node),
    size,
    baseSize: size,
    color: state === 'dormant' ? dimHex(nodeColorHex(node.ftype), DORMANT_NODE_SAT_KEEP, DORMANT_NODE_LIGHT_SCALE) : visual.color,
    opacity: to2DAlphaNode(rawOpacity),
    label: shortLabel(node.label),
    // 活跃态给 'visible' = sigma 的 forced label：不吃网格抽样与尺寸地板（见 encoding 注释）
    labelVisibility: visual.label ? 'visible' : 'auto',
  };
}

export interface Edge2DAttrs {
  color: string;
  size: number;
  opacity: number;
}

export function edge2DAttrs(edge: { etype: string; confidence: number }, state: VisualState = 'dormant'): Edge2DAttrs {
  const visual = edgeVisual(state, edge.confidence);
  const color = edgeColorHex(edge.etype);
  return {
    color: state === 'dormant' ? dimHex(color, DORMANT_EDGE_SAT_KEEP, DORMANT_EDGE_LIGHT_SCALE) : color,
    // 2D 没有流动动画，`width` 就是"这条边是热的"的唯一替身（详设 §10.3.1 注脚）
    size: edgeWidthForConfidence(edge.confidence) * visual.width,
    opacity: to2DAlphaEdge(visual.opacity),
  };
}

/**
 * 选中 / 取消选中：只改 `size` 与 `labelVisibility`。
 *
 * 不改 `color`——ftype 色相是信息，选中不该把它覆盖掉；放大 + 常显标签已经足够
 * 把人眼钉在同一个点上（3D 侧同一套规则，见 `Graph3D.writeNodeMatrix`）。
 */
export function focusAttrs(
  attrs: Node2DAttrs,
  focused: boolean,
): Pick<Node2DAttrs, 'size' | 'labelVisibility'> {
  return focused
    ? { size: attrs.baseSize * FOCUS_SCALE, labelVisibility: 'visible' }
    : { size: attrs.baseSize, labelVisibility: 'auto' };
}
