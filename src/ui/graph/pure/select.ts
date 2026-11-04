/**
 * 2D 框选的纯映射层（P2-19A-18 / 概设 §8.1「框选 → 跳批量影响预览」）。
 *
 * 为什么不写在 `Graph2D.tsx` 里：框选涉及三件"算错了也看不出来"的事——屏幕坐标 →
 * 图坐标的换算、矩形的归一化、选中集的替换/合并。它们与 sigma、React 都无关，放这层
 * 才能在 node 环境直接单测（与 `graph2d.ts` / `trace.ts` 同一条规矩）。
 *
 * 坐标系有两套，别混：
 * - **屏幕/容器坐标**：sigma 事件给的 `event.x / event.y`，相对容器左上角、像素单位；
 * - **图坐标（世界坐标）**：sigma 图属性里的 `x / y`，也就是 `layout.x / layout.z`
 *   （见 `projectTo2D`）——相机 pan/zoom 的逆变换由 `renderer.viewportToGraph` 负责，
 *   本文件只调传进来的 `viewportToGraph`，不自己乘缩放（否则拖框与点选会错位）。
 */

export interface Point {
  x: number;
  y: number;
}

/** 轴对齐矩形：`x0/x1`、`y0/y1` 不保证大小顺序（构造时归一化） */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 框选只需要节点 id 与世界坐标——不 import `api.ts`（根 tsconfig 没有 DOM lib） */
export interface BoxNode {
  id: string;
  x: number;
  y: number;
}

/** 超过这个像素位移才算"拖框"，否则当点击（点节点 = 选中 / 点空白 = 清空） */
export const DRAG_THRESHOLD_PX = 4;

export interface DragState {
  start: Point;
  current: Point;
  /** Shift 按下 = 合并到现有选中集；否则替换 */
  additive: boolean;
  /** 是否已越过阈值（未越过时不动选中集，也不画选框） */
  moved: boolean;
}

export function boxFromPoints(a: Point, b: Point): Box {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

/** 点是否在框内（边界算命中；`pad` 给一点容差，e.g. 恰好压在节点中心） */
export function boxContainsPoint(box: Box, point: Point, pad = 0): boolean {
  return (
    point.x >= box.x0 - pad &&
    point.x <= box.x1 + pad &&
    point.y >= box.y0 - pad &&
    point.y <= box.y1 + pad
  );
}

/**
 * 屏幕矩形 → 图坐标矩形。四个参数只用到两个对角，经 `viewportToGraph` 逆变换后归一化。
 *
 * 注意：必须对**两个角**都做逆变换，不能只算一个角再按像素宽度缩放——相机有 pan/zoom
 * 时屏幕上的宽高与图坐标宽高不成固定比例（虽然 sigma 是等比，但 pan 会平移，仍要两角）。
 */
export function screenBoxToWorld(
  view: { viewportToGraph(point: Point): Point },
  a: Point,
  b: Point,
): Box {
  return boxFromPoints(view.viewportToGraph(a), view.viewportToGraph(b));
}

/** 框内节点 id（按入参顺序，保证"两次框同一区域 → 同一序列"）；空框返回空数组 */
export function selectIdsInBox(nodes: readonly BoxNode[], box: Box): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (boxContainsPoint(box, { x: node.x, y: node.y })) out.push(node.id);
  }
  return out;
}

export function beginDrag(start: Point, additive: boolean): DragState {
  return { start, current: start, additive, moved: false };
}

/** 更新拖拽终点；一旦越过阈值就定格 `moved=true`（不会因抖回起点又变回"点击"） */
export function updateDrag(drag: DragState, point: Point, threshold = DRAG_THRESHOLD_PX): DragState {
  const dx = Math.abs(point.x - drag.start.x);
  const dy = Math.abs(point.y - drag.start.y);
  const moved = drag.moved || dx >= threshold || dy >= threshold;
  return { ...drag, current: point, moved };
}

/** 屏幕坐标下的选框矩形（用于画那个半透明 div） */
export function dragScreenBox(drag: DragState): Box {
  return boxFromPoints(drag.start, drag.current);
}

/**
 * 选中集合并：`additive=false` 时完全替换，`true` 时保留旧集合再加新 id。
 * 返回新 Set（zustand 靠引用变化通知订阅方；同一个 Set 原地改会让渲染器漏刷新）。
 */
export function mergeSelection(
  prev: ReadonlySet<string>,
  ids: readonly string[],
  additive: boolean,
): Set<string> {
  const next = new Set<string>(additive ? prev : []);
  for (const id of ids) if (id.length > 0) next.add(id);
  return next;
}

/** 框选后的主选中：取最后一个命中（与点击"最近一次"语义一致）；空框且非合并 → null */
export function focusAfterBox(
  prevFocus: string | null,
  ids: readonly string[],
  additive: boolean,
): string | null {
  const last = ids.length > 0 ? (ids[ids.length - 1] ?? null) : null;
  if (last !== null) return last;
  return additive ? prevFocus : null;
}
