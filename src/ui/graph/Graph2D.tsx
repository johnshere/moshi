/**
 * 2D 记忆图谱（sigma.js + graphology，P2-03；详设 §10.1 `<Graph2D>` / 概设 §8.7「2D = 确认」）。
 *
 * 三个不变量，改动前先读：
 * 1. **坐标只从布局表来**：节点位置 = `layout.x` / `layout.z`（经 `pure/graph2d.ts` 的
 *    `projectTo2D`），这里一行力导向都没有（概设 §8.9 纪律 1）。sigma 自带布局的入口
 *    一个都没调——图上每个点落在哪，只由库里那张 `layout` 表决定。
 * 2. **颜色 / 尺寸 / 失效区分全部来自 `pure/encoding.ts`**，本文件不出现第二个色表。
 * 3. **选中态只走 `state/selection.ts`**：与 3D 是同一个 store，不是两套高亮。
 */
import { useEffect, useRef } from 'react';
import { MultiGraph } from 'graphology';
import Sigma from 'sigma';
import type { GraphEdge, GraphNode, GraphPayload } from '../api.js';
import { useActivity } from '../state/activity.js';
import { useSelection } from '../state/selection.js';
import { edgeKey, type ActivitySnapshot } from './pure/activity.js';
import { ACTIVITY_TTL_MS, clamp01, type VisualState } from './pure/encoding.js';
import { edge2DAttrs, focusAttrs, node2DAttrs } from './pure/graph2d.js';
import {
  brighterState,
  edgeRefKey,
  traceEdgeAttrsFor,
  traceNodeHops,
  traceNodeState,
  type TraceEdgeAttr,
  type TraceRecord,
} from './pure/trace.js';
import { useTrace } from '../state/trace.js';
import {
  beginDrag,
  dragScreenBox,
  screenBoxToWorld,
  selectIdsInBox,
  updateDrag,
  type Box,
  type DragState,
} from './pure/select.js';
import { publishSelectedIds } from './selectBridge.js';

const BG_COLOR = '#05070d';

export interface Graph2DStats {
  fps: number;
  nodeCount: number;
  edgeCount: number;
  selectedId: string | null;
  /** 活跃集规模（详设 §10.3.1 验收 ③/⑥） */
  activeNodes: number;
  activeEdges: number;
}

/**
 * sigma 4 的样式表：显式绑死每个视觉变量对应的节点属性。
 *
 * v4 取消了 v2/v3 的 `nodeReducer` / `edgeReducer`，改成这一张声明表；**给了 styles
 * 就整体替换 `DEFAULT_STYLES`**，所以 x / y / size / color / label / labelVisibility
 * 必须自己写全（否则节点直接不画或不带标签）。默认表里没有 `opacity`，而 strength
 * 的透明度正是靠它，所以这一条是本表存在的首要原因。
 */
const SIGMA_STYLES = {
  nodes: {
    x: { attribute: 'x' },
    y: { attribute: 'y' },
    size: { attribute: 'size' },
    color: { attribute: 'color' },
    opacity: { attribute: 'opacity' },
    label: { attribute: 'label' },
    labelVisibility: { attribute: 'labelVisibility' },
    labelSize: 11,
  },
  edges: {
    size: { attribute: 'size' },
    color: { attribute: 'color' },
    opacity: { attribute: 'opacity' },
  },
  stage: { background: BG_COLOR },
} as const;

class SigmaScene {
  private readonly host: HTMLElement;
  private readonly onStats: ((s: Graph2DStats) => void) | undefined;
  private readonly graph = new MultiGraph();
  private renderer: Sigma | null = null;
  private readonly unsubSelection: () => void;
  private readonly unsubActivity: () => void;

  /** 原始数据：样式要按活跃态重算，所以不能只留 sigma 图属性 */
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private readonly rawNodeById = new Map<string, GraphNode>();
  private readonly rawEdgeByKey = new Map<string, GraphEdge>();
  private activity: ActivitySnapshot | null = null;
  /** 证据链（P2-25）：2D 没有流动动画，用 mass 抬边的不透明度/宽度表达"证据更重" */
  private trace: TraceRecord | null = null;
  private traceNodeHops = new Map<string, 0 | 1 | 2>();
  private readonly traceEdgeByKey = new Map<string, TraceEdgeAttr | null>();

  private selectedId: string | null = null;
  /** 框选（P2-19A-18）：按下鼠标后即进入 pending，越过阈值才抬成"正在框选" */
  private drag: DragState | null = null;
  /** 半透明选框是普通 DOM，不新增 WebGL draw call（渲染管线上限 12 不破） */
  private readonly boxEl: HTMLDivElement;
  /** 拖框结束后的第一次 click 要吞掉：否则 sigma 的 clickStage 会把刚选好的框选清空 */
  private suppressClick = false;
  /** 共享选中集（可能多选）：与 `state/selection.ts` 的 `selectedIds` 同引用 */
  private selectedIds: ReadonlySet<string> = new Set<string>();
  private readonly unsubKey: () => void;
  private raf = 0;
  private disposed = false;
  private frames = 0;
  private fpsAt = performance.now();
  private fps = 0;
  private publishAt = 0;
  private readonly unsubTrace: () => void;

  constructor(host: HTMLElement, onStats?: (s: Graph2DStats) => void) {
    this.host = host;
    this.onStats = onStats;
    this.selectedId = useSelection.getState().focusId;
    this.selectedIds = useSelection.getState().selectedIds;
    this.activity = useActivity.getState().snapshot;
    // 选框只在拖拽时显示；`pointer-events: none` 保证它永远不抢事件（否则拖到一半就丢了 move）
    this.boxEl = document.createElement('div');
    this.boxEl.style.cssText = [
      'position:absolute',
      'display:none',
      'pointer-events:none',
      'border:1px solid rgba(125,211,252,0.85)',
      'background:rgba(56,189,248,0.12)',
      'border-radius:2px',
      'z-index:4',
    ].join(';');
    host.appendChild(this.boxEl);
    // 命令式渲染器订阅 store：3D 点选 / 框选后切到 2D，这里要立刻高亮（不是等下一次刷新）
    this.unsubSelection = useSelection.subscribe((state, prev) => {
      if (state.selectedIds === prev.selectedIds && state.focusId === prev.focusId) return;
      this.selectedIds = state.selectedIds;
      this.selectedId = state.focusId;
      this.applyVisuals();
      this.publishSelected();
    });
    // Esc 清空选中（概设 §8.9 键盘可达）。输入框里的 Esc 不抢（那是关弹层用的）。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      useSelection.getState().clear();
    };
    window.addEventListener('keydown', onKeyDown);
    this.unsubKey = () => window.removeEventListener('keydown', onKeyDown);
    // 活跃集与选中态是两个来源（D-89），一起决定节点的最终样式
    this.unsubActivity = useActivity.subscribe((state, prev) => {
      if (state.snapshot === prev.snapshot) return;
      this.activity = state.snapshot;
      this.applyVisuals();
    });
    // 证据链（P2-25）：只读快照，换一次查询才变；与活跃集在样式上取较亮者
    this.trace = useTrace.getState().trace;
    this.recaptureTrace();
    this.unsubTrace = useTrace.subscribe((state, prev) => {
      if (state.trace === prev.trace) return;
      this.trace = state.trace;
      this.recaptureTrace();
      this.applyVisuals();
    });
    this.loop();
  }

  setData(data: GraphPayload): void {
    this.graph.clear();
    this.rawNodeById.clear();
    this.rawEdgeByKey.clear();
    this.nodes = data.nodes;
    this.edges = data.edges;
    this.trace = useTrace.getState().trace;
    this.recaptureTrace();
    for (const node of data.nodes) {
      // 去重靠接口保证，但重复 id 会直接抛，所以这里兜一层
      if (this.graph.hasNode(node.id)) continue;
      this.rawNodeById.set(node.id, node);
      this.graph.addNode(node.id, node2DAttrs(node));
    }
    for (const edge of data.edges) {
      // 端点在别页（cursor 翻页场景）就丢掉，与 3D `buildEdgeBuffers` 同口径
      if (!this.graph.hasNode(edge.src) || !this.graph.hasNode(edge.dst)) continue;
      const key = this.graph.addEdge(edge.src, edge.dst, edge2DAttrs(edge));
      this.rawEdgeByKey.set(key, edge);
    }

    if (this.renderer === null) this.createRenderer();
    else this.renderer.refresh();

    // 刷新后沿用 store 里的选中（刷新不该把正在确认的那个点弄丢）
    this.selectedId = useSelection.getState().focusId;
    this.selectedIds = useSelection.getState().selectedIds;
    this.activity = useActivity.getState().snapshot;
    this.applyVisuals();
    this.publish(performance.now(), true);
  }

  private createRenderer(): void {
    const renderer = new Sigma(this.graph, this.host, {
      styles: SIGMA_STYLES,
      // sigma v4 把 rendering 选项收在 `settings` 里（`SigmaOptions.settings`）
      settings: {
        renderEdgeLabels: false,
        // 边/标签在相机移动时不许隐藏：那会让 fps 虚高，2D 的职责就是"看清拓扑"
        hideEdgesOnMove: false,
        hideLabelsOnMove: false,
        // 边命中关掉：2000 节点 6000 边下它是白给的开销，本视图只需要点节点
        enableEdgeEvents: false,
        // 标签：每个 180px 网格里只出 1 条（sigma 取格内最大的节点），再叠一道
        // 7px 尺寸地板。2000 节点全标 = 糊成一片，2D 的职责是"看清拓扑 + 精确点选"，
        // 认出个别节点靠的是选中后的强制标签（见 `focusAttrs`），不是满屏文字。
        labelDensity: 0.5,
        labelGridCellSize: 180,
        labelRenderedSizeThreshold: 7,
        stagePadding: 24,
        // `size` 属性按屏幕像素解释，`radiusForImportance` 的 3–12 才是像素语义
        itemSizesReference: 'screen',
      },
    });
    // 点选 = 写共享选中态（唯一真相源在 state/selection.ts，3D 订阅它做高亮）。
    renderer.on('clickNode', (payload) => {
      if (this.consumeSuppressedClick()) return;
      useSelection.getState().select(payload.node);
    });
    // 点空白 = 取消选中：2D 的使命是确认，点完一定会想收拾（概设 §8.7），空白区域也远大于 3D。
    renderer.on('clickStage', () => {
      // 刚结束一次框选：这一次 click 是拖拽的尾巴，不能把框选结果清掉
      if (this.consumeSuppressedClick()) return;
      useSelection.getState().clear();
    });
    // 框选（P2-19A-18）：只在**空白处**按下才起框。`downNode` 不进来，点节点仍是点选；
    // 同时 preventSigmaDefault 阻止 sigma 把这次拖动当成相机平移（框选期间相机不动）。
    renderer.on('downStage', (payload) => {
      payload.event.preventSigmaDefault();
      const original = payload.event.original as MouseEvent;
      this.beginBoxDrag(payload.event.x, payload.event.y, original.shiftKey);
    });
    this.renderer = renderer;
  }

  /** 开始 pending 框选：此时还不动选中集，越过阈值才显示选框 */
  private beginBoxDrag(x: number, y: number, additive: boolean): void {
    if (this.renderer === null) return;
    this.suppressClick = false;
    this.drag = beginDrag({ x, y }, additive);
    window.addEventListener('pointermove', this.handleBoxMove);
    window.addEventListener('pointerup', this.handleBoxUp);
  }

  private handleBoxMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag === null) return;
    const rect = this.host.getBoundingClientRect();
    this.drag = updateDrag(drag, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (this.drag.moved) this.showBox(dragScreenBox(this.drag));
  };

  private handleBoxUp = (event: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    window.removeEventListener('pointermove', this.handleBoxMove);
    window.removeEventListener('pointerup', this.handleBoxUp);
    this.hideBox();
    if (drag === null) return;
    const rect = this.host.getBoundingClientRect();
    const finalDrag = updateDrag(drag, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    if (!finalDrag.moved) return; // 只是点击空白：让 sigma 的 clickStage 正常清空
    const renderer = this.renderer;
    if (renderer === null) return;
    // 屏幕坐标 → 图坐标：复用 sigma 的相机逆变换（与点选同一套 pan/zoom），
    // 不自己拿 zoom 比例乘像素，否则拖框与命中会错位。
    const box = screenBoxToWorld(
      { viewportToGraph: (point) => renderer.viewportToGraph(point) },
      finalDrag.start,
      finalDrag.current,
    );
    const ids = selectIdsInBox(
      this.nodes.map((node) => ({ id: node.id, x: node.x, y: node.z })),
      box,
    );
    this.suppressClick = true;
    useSelection.getState().setSelected(ids, { additive: finalDrag.additive });
    this.publish(performance.now(), true);
  };

  private consumeSuppressedClick(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  private showBox(box: Box): void {
    this.boxEl.style.display = 'block';
    this.boxEl.style.left = `${box.x0}px`;
    this.boxEl.style.top = `${box.y0}px`;
    this.boxEl.style.width = `${Math.max(box.x1 - box.x0, 1)}px`;
    this.boxEl.style.height = `${Math.max(box.y1 - box.y0, 1)}px`;
  }

  private hideBox(): void {
    this.boxEl.style.display = 'none';
  }

  private publishSelected(): void {
    publishSelectedIds([...this.selectedIds]);
  }

  /**
   * 节点此刻的状态：**只由活跃集决定**，选中不参与（与 3D 同一条口径）。
   *
   * 选中的表达是"放大 + 常显标签"这条常驻通道（见 `applyVisuals` 末尾），不占用颜色
   * 亮度——否则点过的节点永远挂在活跃态，沉默态就无从谈起。
   */
  private stateOfNode(id: string): VisualState {
    // P2-25：证据链优先与活跃集取较亮者（hop0 = active，hop>0 = secondary）
    const fromTrace = traceNodeState(this.traceNodeHops, id);
    return brighterState(this.activity?.states.get(id) ?? 'dormant', fromTrace ?? 'dormant');
  }

  /** 证据边属性：先试正向 `(src,dst,etype)`，再试反向（库里边的几何方向不定） */
  private traceAttrOf(edge: GraphEdge): TraceEdgeAttr | null | undefined {
    const forward = this.traceEdgeByKey.get(edgeRefKey(edge.src, edge.dst, edge.etype));
    if (forward !== undefined) return forward;
    return this.traceEdgeByKey.get(edgeRefKey(edge.dst, edge.src, edge.etype));
  }

  /** 用当前 `this.trace` 重算逐边证据属性（换边表 / 换 trace 都走这里） */
  private recaptureTrace(): void {
    this.traceEdgeByKey.clear();
    const attrs = traceEdgeAttrsFor(this.edges, this.trace);
    this.traceNodeHops = traceNodeHops(this.trace);
    for (let i = 0; i < this.edges.length; i += 1) {
      const edge = this.edges[i]!;
      this.traceEdgeByKey.set(edgeRefKey(edge.src, edge.dst, edge.etype), attrs[i] ?? null);
    }
  }

  /** 边此刻的状态：活跃集 + 证据链取较亮者（hop1 = 活跃，hop2+ = 次级） */
  private stateOfEdge(edge: GraphEdge): VisualState {
    const snapshot = this.activity;
    let state: VisualState = 'dormant';
    if (snapshot !== null) {
      if (snapshot.edges.has(edgeKey(edge.src, edge.dst))) state = 'active';
      else {
        const a = snapshot.states.get(edge.src);
        const b = snapshot.states.get(edge.dst);
        if (a !== undefined || b !== undefined) state = 'secondary';
      }
    }
    const traceAttr = this.traceAttrOf(edge) ?? null;
    if (traceAttr !== null) state = brighterState(state, traceAttr.hop === 1 ? 'active' : 'secondary');
    return state;
  }

  /**
   * 按"沉默 / 次级 / 活跃"重算所有节点与边的颜色、透明度、尺寸（详设 §10.3.1 那张表）。
   *
   * 为什么整表重算而不是只改增量：一条边是否是"活跃边"取决于**两端**的状态，增量更新
   * 要维护反向索引（节点 → 邻边），代码量翻倍而收益只是点击时省几毫秒。2000 节点
   * 6000 边一次全量重算实测在 10ms 量级，点一下卡一帧可以接受。
   */
  private applyVisuals(): void {
    const renderer = this.renderer;
    if (renderer === null) return;
    for (const node of this.nodes) {
      if (!this.graph.hasNode(node.id)) continue;
      const attrs = node2DAttrs(node, this.stateOfNode(node.id));
      // 选中：只叠"放大 + 强制标签"，颜色仍是状态色（ftype 色相是信息，选中不覆盖它）
      // 多选（框选）时集合里的每个节点都走这条通道，主焦点不再单独特殊化。
      const focused = this.selectedIds.has(node.id) || node.id === this.selectedId;
      const patch = focusAttrs(attrs, focused);
      this.graph.setNodeAttribute(node.id, 'color', attrs.color);
      this.graph.setNodeAttribute(node.id, 'opacity', attrs.opacity);
      this.graph.setNodeAttribute(node.id, 'size', patch.size);
      this.graph.setNodeAttribute(node.id, 'baseSize', attrs.baseSize);
      // 活跃态与选中态都强制显示标签（sigma 的 forced label，不吃网格抽样）
      this.graph.setNodeAttribute(node.id, 'labelVisibility', patch.labelVisibility);
    }
    this.graph.forEachEdge((key, _attrs, _source, _target) => {
      const edge = this.rawEdgeByKey.get(key);
      if (edge === undefined) return;
      const attrs = edge2DAttrs(edge, this.stateOfEdge(edge));
      // 2D 没有流动动画：证据质量换成"更不透明 + 略宽"的静态通道（与 3D 的 aMass 同义）
      const traceAttr = this.traceAttrOf(edge) ?? null;
      const opacity = traceAttr === null ? attrs.opacity : clamp01(attrs.opacity + 0.35 * traceAttr.mass);
      const size = traceAttr === null ? attrs.size : attrs.size + 0.6 * traceAttr.mass;
      this.graph.setEdgeAttribute(key, 'color', attrs.color);
      this.graph.setEdgeAttribute(key, 'size', size);
      this.graph.setEdgeAttribute(key, 'opacity', opacity);
    });
    renderer.scheduleRefresh();
    this.publish(performance.now(), true);
  }

  /**
   * 选中态只在 `useSelection` 订阅回调里统一处理（`selectedId` / `selectedIds` 一起更新后
   * 调一次 `applyVisuals`）：放大与强制标签都写在 `applyVisuals` 里，颜色不动——ftype
   * 色相是信息，选中不该把它覆盖掉（与 `focusAttrs` 的注释同一条理由）。
   */

  /** 节点在视口里的像素位置：验收脚本用它证明"位置随布局变" */
  private screenPos(id: string): { x: number; y: number } | null {
    const renderer = this.renderer;
    if (renderer === null || !this.graph.hasNode(id)) return null;
    const pos = renderer.graphToViewport({
      x: this.graph.getNodeAttribute(id, 'x') as number,
      y: this.graph.getNodeAttribute(id, 'y') as number,
    });
    const rect = this.host.getBoundingClientRect();
    return { x: rect.left + pos.x, y: rect.top + pos.y };
  }

  private publish(now: number, force = false): void {
    if (!force && now - this.publishAt < 500) return;
    this.publishAt = now;
    const stats: Graph2DStats = {
      fps: Math.round(this.fps * 10) / 10,
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      selectedId: this.selectedId,
      activeNodes: this.activity?.activeNodes ?? 0,
      activeEdges: this.activity?.activeEdges ?? 0,
    };
    window.__moshiGraph2d = { ...stats, screenPos: (id) => this.screenPos(id) };
    // 2D 视图没有 3D 场景在跑 publish，选中集得由这里补写到同一个验收对象上（只加字段）
    this.publishSelected();
    this.onStats?.(stats);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (document.hidden) {
      // 后台标签页的 rAF 被节流到 1Hz，计进 fps 会得到一条假红线
      this.frames = 0;
      this.fpsAt = now;
      return;
    }
    // 活跃态到点自己暗回去：不依赖谁来"清场"，这样即使没人再点，图也会回沉默
    if (this.activity !== null && now - this.activity.hitAt >= ACTIVITY_TTL_MS) {
      this.activity = null;
      this.applyVisuals();
    }
    this.frames += 1;
    const elapsed = now - this.fpsAt;
    if (elapsed >= 500) {
      this.fps = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.fpsAt = now;
    }
    // sigma 是按需渲染的，主循环不会自己跑：这里每帧排一次渲染，
    // fps 才是"这张图一帧多贵"（与 3D 的持续 rAF 同口径，可横向比较）
    this.renderer?.scheduleRender();
    this.publish(now);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointermove', this.handleBoxMove);
    window.removeEventListener('pointerup', this.handleBoxUp);
    this.unsubSelection();
    this.unsubActivity();
    this.unsubTrace();
    this.unsubKey();
    this.boxEl.remove();
    this.renderer?.kill();
    this.renderer = null;
    delete window.__moshiGraph2d;
  }
}

export interface Graph2DProps {
  data: GraphPayload;
  onStats?: (s: Graph2DStats) => void;
}

export function Graph2D({ data, onStats }: Graph2DProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SigmaScene | null>(null);
  const statsRef = useRef(onStats);
  statsRef.current = onStats;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const scene = new SigmaScene(host, (s) => {
      statsRef.current?.(s);
    });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setData(data);
  }, [data]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0, background: BG_COLOR }} />;
}
