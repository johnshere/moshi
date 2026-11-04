/**
 * 3D 记忆图谱（详设 §10.3 逐行落成代码，P2-02；双态视觉 §10.3.1，P2-03）。
 *
 * 五个不变量，改动前先读：
 * 1. **坐标只从 `/api/graph` 拿**，前端绝不跑力导向（概设 §8.9 纪律 1）。这里出现的
 *    只有"把数据摆到画面上"，任何看起来像布局的计算都属于 `src/app/jobs/layout.ts`。
 * 2. **`renderer.info.render.calls ≤ 12`**：节点 1（InstancedMesh）+ 边 1（LineSegments）
 *    + 光晕 1（instanced billboard）+ 社区包络 1（instanced icosahedron）+ 参考平面 4 = 8。
 *    所以"每社区一个 mesh""每节点一个 Sprite"这类写法一律不许出现——它们会把 draw call
 *    打成 C / N。
 * 3. **不用 postprocessing bloom**（概设 §8.5.4）：光晕是贴图 + 加色混合，不是后处理。
 * 4. **选中态只有一个来源**：`state/selection.ts` 的 `useSelection`。本文件不存自己的
 *    选中，只负责"把 focusId 画出来"——放大 `FOCUS_SCALE` 倍 + 标签常显（与 2D 同一套
 *    规则）。高亮不加 draw call：改的是节点矩阵，不是新开一个 mesh。
 * 5. **默认沉默**（详设 §10.3.1 / D-88 / D-89）：光晕实例池常驻但 `count = 0`，边不
 *    流动，节点按沉默态去饱和。只有活跃集（命中 + 1-hop，`state/activity.ts`）里的
 *    节点才亮，且 4–6 秒后自己暗回去。全量高亮等于没有高亮。
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { GraphEdge, GraphPayload } from '../api.js';
import { useActivity } from '../state/activity.js';
import { useSelection } from '../state/selection.js';
import {
  ACTIVE_NODE_CAP,
  ENVELOPE_ACTIVE,
  ENVELOPE_DORMANT,
  FOCUS_SCALE,
  LAYER_INVALID,
  LAYER_LOW,
  LAYER_MID,
  LAYER_TOP,
  PULSE_DURATION_S,
  SINK_DURATION_MS,
  WAVE_STEP_MS,
  ACTIVITY_TTL_MS,
  decayWeight,
  edgeVisual,
  nodeVisual,
  pulseScale,
  radiusForImportance,
  renderY,
  sinkY,
  type VisualState,
} from './pure/encoding.js';
import { edgeKey, waveOffsetMs, type ActivitySnapshot } from './pure/activity.js';
import { buildEdgeBuffers, communityBounds, type EdgeBuffers } from './pure/geometry.js';
import {
  brighterState,
  hopBand,
  traceEdgeAttrsFor,
  traceEdgeReadout,
  traceNodeHops,
  traceNodeState,
  traceSummary,
  type TraceEdgeAttr,
  type TraceEdgeReadout,
  type TraceRecord,
  type TraceSummary,
} from './pure/trace.js';
import { useTrace } from '../state/trace.js';

const BG_COLOR = 0x05070d;
const MAX_LABELS = 48;
/** 光晕相对节点半径的倍数与不透明度：集显上这两个数直接决定填充率 */
const HALO_SCALE = 2.2;
const HALO_OPACITY = 0.2;
const LABEL_MAX_DISTANCE = 120;
const SINK_MS = SINK_DURATION_MS;

export interface GraphStats {
  fps: number;
  renderCalls: number;
  nodeCount: number;
  edgeCount: number;
  labelCount: number;
  /** 当前上屏的光晕实例数：沉默态必须是 0（详设 §10.3.1 验收 ①） */
  halos: number;
  /** 活跃集规模（验收 ③/⑥） */
  activeNodes: number;
  activeEdges: number;
  /** 当前选中节点 id（= state/selection.ts 的 focusId）；显式发布出来，验收脚本才能证明
   *  3D 确实在画这个选中，而不是只能靠肉眼比对截图 */
  focusId: string | null;
}

interface LayerPlane {
  y: number;
  color: number;
  opacity: number;
}

const PLANES: readonly LayerPlane[] = [
  { y: LAYER_TOP, color: 0x22d3ee, opacity: 0.2 },
  { y: LAYER_MID, color: 0x64748b, opacity: 0.14 },
  { y: LAYER_LOW, color: 0x475569, opacity: 0.1 },
  { y: LAYER_INVALID, color: 0xef4444, opacity: 0.08 },
];

/**
 * 边：顶点属性 `aType` 选色 + `aVis` 定透明度 + `uv.x` 流动 + `aConf` 调亮端；
 * P2-25 起再叠三个证据链属性（详设 §10.3.2）：
 * - `aFlow`：hop 分档流速（0 直击 / 0.6 一跳 / 0.3 两跳+），0 = 静止；
 * - `aMass`：PPR 沿边扩散份额 0–1，驱动亮度；
 * - `aHop`：原始跳数 0/1/2，只做相位滞后（hop 越大越晚到）；
 * - `aDir`：0 = 沿边几何 src→dst 流，1 = 反向（trace 的 path 方向才是证据传播方向）。
 */
const EDGE_VERT = /* glsl */ `
  attribute float aType;
  attribute float aConf;
  attribute float aFlow;
  attribute float aVis;
  attribute float aMass;
  attribute float aHop;
  attribute float aDir;
  uniform float uTime;
  uniform float uFlowScale;
  uniform vec3 uEtypeColors[6];
  varying vec3 vColor;
  varying float vAlpha;
  varying float vVis;
  varying float vMass;
  varying float vFlow;
  varying vec2 vUv;
  varying float vPhase;

  vec3 pickEtype(float t) {
    if (t < 0.5) return uEtypeColors[0];
    if (t < 1.5) return uEtypeColors[1];
    if (t < 2.5) return uEtypeColors[2];
    if (t < 3.5) return uEtypeColors[3];
    if (t < 4.5) return uEtypeColors[4];
    return uEtypeColors[5];
  }

  void main() {
    vColor = pickEtype(aType);
    vAlpha = clamp(aConf, 0.0, 1.0);
    vVis = aVis;
    vMass = aMass;
    vFlow = aFlow;
    // 方向：trace 的 path 是「种子 → 1 跳 → 2 跳」的传播方向，库里边的几何方向不一定
    // 与它一致（co_occur 两个方向都合法），所以按 aDir 翻转 uv，而不是按 etype 语义猜。
    float u = mix(uv.x, 1.0 - uv.x, aDir);
    vUv = vec2(u, uv.y);
    // 流动点：uv.x 沿边参数 + 时间偏移 + hop×0.33 相位滞后。没有 trace 的边 aFlow=0、
    // aHop=0 → vPhase 恒 0，片元里的 dot 通道自动熄灭（"边不流动"不需要额外开关）。
    vPhase = uTime * aFlow * uFlowScale + aHop * 0.33;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EDGE_FRAG = /* glsl */ `
  uniform float uDash;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vVis;
  varying float vMass;
  varying float vFlow;
  varying vec2 vUv;
  varying float vPhase;

  void main() {
    float x = fract(vUv.x * uDash - vPhase);
    float dot = smoothstep(0.72, 1.0, x);
    float flowing = step(0.0001, vFlow);
    // 亮度/透明度：状态表 + 流动点 + 证据质量（aMass 让证据边在沉默底上也亮得起来）。
    // 加法混合下 aVis 仍是底，dot 是运动的高光，aMass 是「这条边确实参与了扩散」的读数。
    float intensity = 0.5 + 0.5 * vAlpha + 1.6 * dot * flowing + 1.4 * vMass;
    float alpha = vVis + 0.45 * dot * flowing + 0.55 * vMass;
    gl_FragColor = vec4(vColor * intensity, clamp(alpha, 0.0, 1.0));
  }
`;

/** 社区包络：菲涅尔边缘亮、中间几乎透明；每实例自己的透明度（沉默 0.015 / 活跃 0.06） */
const ENVELOPE_VERT = /* glsl */ `
  attribute vec3 aCommColor;
  attribute float aCommAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vNormalV;
  varying vec3 vViewDir;

  void main() {
    vColor = aCommColor;
    vAlpha = aCommAlpha;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const ENVELOPE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vNormalV;
  varying vec3 vViewDir;

  void main() {
    // 多个社区的包络球经常同心嵌套（布局未按社区分离时），加法混合会迅速叠到纯白，
    // 所以整体再乘一个系数把每一层的贡献压小。
    float d = 1.0 - abs(dot(vNormalV, vViewDir));
    gl_FragColor = vec4(vColor, vAlpha * (0.6 + 1.4 * d * d));
  }
`;

/** 光晕：instanced 方形 billboard，贴一张径向渐变贴图 */
const HALO_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length(instanceMatrix[0].xyz);
    center.xy += position.xy * s;
    gl_Position = projectionMatrix * center;
  }
`;

const HALO_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec4 texel = texture2D(uMap, vUv);
    gl_FragColor = vec4(texel.rgb, texel.a * uOpacity);
  }
`;

function radialGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.35, 'rgba(190,225,255,0.28)');
    g.addColorStop(1, 'rgba(120,180,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

class GraphScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly controls: OrbitControls;
  private readonly host: HTMLElement;
  private readonly onStats: ((s: GraphStats) => void) | undefined;

  private raf = 0;
  private disposed = false;
  private readonly clock = new THREE.Clock();
  private frames = 0;
  private fpsAt = performance.now();
  private fps = 0;

  private nodesMesh: THREE.InstancedMesh | null = null;
  private edgesMesh: THREE.LineSegments | null = null;
  private halos: THREE.InstancedMesh | null = null;
  private envelopes: THREE.InstancedMesh | null = null;
  private readonly grids: THREE.GridHelper[] = [];
  private edgeMaterial: THREE.ShaderMaterial | null = null;
  private nodeGeometry: THREE.SphereGeometry | null = null;
  private nodeMaterial: THREE.MeshBasicMaterial | null = null;
  private glowTexture: THREE.Texture | null = null;

  private nodes: GraphPayload['nodes'] = [];
  private edgeCount = 0;
  private pos = new Float32Array(0); // 3N：x / 当前 y / z
  private targetY = new Float32Array(0);
  private sinkFrom = new Float32Array(0);
  private sinkStart = new Float32Array(0); // ms，-1 表示已归位
  /** 节点半径以「像素」存，写入矩阵时乘以 pxScale 换算成世界单位（详设：3+9×importance px） */
  private radius = new Float32Array(0);
  private pxScale = 1;
  /** 数据包围球半径：标签的可见距离按它缩放（详见 frameAll） */
  private fitRadius = 120;
  private pulseAt = new Float32Array(0); // ms，-1 表示无脉冲
  private prevAccess = new Map<string, number>();
  /** 选中节点的实例下标（-1 = 无选中）：来自共享 store，不是本场景自己的状态 */
  private focusIndex = -1;
  private readonly indexOfId = new Map<string, number>();
  private readonly unsubSelection: () => void;
  private readonly unsubActivity: () => void;

  /** 活跃集快照（`state/activity.ts` 的同一份数据，本类只读） */
  private activity: ActivitySnapshot | null = null;
  private edges: GraphEdge[] = [];
  /** 每节点当前不透明度（沉默 0.10–0.22 / 次级 / 活跃，见 `nodeVisual`） */
  private nodeAlphaAttr: THREE.InstancedBufferAttribute | null = null;
  /** 每节点当前尺寸倍数（沉默 ×0.85） */
  private stateScale = new Float32Array(0);
  /** 边数组下标 → 顶点属性起始下标（-1 = 端点缺失、已被 `buildEdgeBuffers` 丢弃） */
  private edgeVertex = new Int32Array(0);
  private edgeVisAttr: THREE.BufferAttribute | null = null;
  private edgeFlowAttr: THREE.BufferAttribute | null = null;
  /** P2-25 证据链的逐边属性（都是已有 LineSegments 上的 attribute，不增 draw call） */
  private edgeMassAttr: THREE.BufferAttribute | null = null;
  private edgeHopAttr: THREE.BufferAttribute | null = null;
  private edgeDirAttr: THREE.BufferAttribute | null = null;
  /** 当前证据链（`useTrace` 的同一份快照；本类只读，不自己发起请求） */
  private trace: TraceRecord | null = null;
  /** 与 `edges` 逐条对齐；`null` = 这条边不在证据链里 */
  private traceAttrs: (TraceEdgeAttr | null)[] = [];
  private traceNodeHops = new Map<string, 0 | 1 | 2>();
  private traceSummary: TraceSummary | null = null;
  /** `window.__moshiGraph.edges` 的缓存：只在 trace 变化时重算，不每帧重建数组 */
  private traceReadout: TraceEdgeReadout = { aFlow: [], aMass: [], aHop: [], count: 0 };
  /** 已为哪一次查询播过入场脉冲：同一 trace 被重复发布时不重播 */
  private pulsedQueryId: string | null = null;
  private readonly unsubTrace: () => void;
  private haloMaterial: THREE.ShaderMaterial | null = null;
  /** 当前上屏的活跃节点下标（光晕只为它们存在；空数组 = `halos.count = 0`） */
  private activeIndices: number[] = [];
  private envelopeAlphaAttr: THREE.InstancedBufferAttribute | null = null;
  private readonly envelopeByCommunity = new Map<number, number>();

  private readonly labelPool: { obj: CSS2DObject; div: HTMLDivElement }[] = [];
  private labelTickAt = 0;
  private labelCount = 0;

  private readonly m4 = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  constructor(host: HTMLElement, onStats?: (s: GraphStats) => void) {
    this.host = host;
    this.onStats = onStats;

    this.scene.background = new THREE.Color(BG_COLOR);

    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    this.camera = new THREE.PerspectiveCamera(55, width / height, 1, 6000);
    this.camera.position.set(0, 150, 420);

    // 集显（UHD 630）上 MSAA 是最大的一笔固定开销：1080p × 4x 采样白给。
    // 节点是圆球、边是细线，关掉 MSAA 后靠光晕的柔边遮掩锯齿，实测收益远大于画质损失。
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(BG_COLOR, 1);
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(width, height);
    const labelStyle = this.labelRenderer.domElement.style;
    labelStyle.position = 'absolute';
    labelStyle.top = '0';
    labelStyle.left = '0';
    labelStyle.pointerEvents = 'none';
    host.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 2600;
    this.controls.target.set(0, 0, 0);

    for (const plane of PLANES) {
      const grid = new THREE.GridHelper(1600, 32, plane.color, plane.color);
      grid.position.y = plane.y;
      const material = grid.material as THREE.Material;
      material.transparent = true;
      material.opacity = plane.opacity;
      material.depthWrite = false;
      this.grids.push(grid);
      this.scene.add(grid);
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(host);

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointer);

    // 3D → store → 2D：点选写进共享 store，2D 那边订阅同一份状态
    this.unsubSelection = useSelection.subscribe((state, prev) => {
      if (state.focusId !== prev.focusId) this.setFocus(state.focusId);
    });

    // 活跃集（命中 + 1-hop）来自 `useActivity`：同一份快照，2D 与状态栏也读它
    this.unsubActivity = useActivity.subscribe((state, prev) => {
      if (state.snapshot === prev.snapshot) return;
      this.activity = state.snapshot;
      this.restyleAll();
    });

    // 证据链（P2-25）与活跃集分开订阅：trace 是只读快照、没有 TTL，换一次查询才变；
    // 两者在节点状态上取较亮者（`stateOf`），互不覆盖。
    this.trace = useTrace.getState().trace;
    this.unsubTrace = useTrace.subscribe((state, prev) => {
      if (state.trace === prev.trace) return;
      this.applyTrace(state.trace);
    });

    this.loop();
  }

  private readonly resizeObserver: ResizeObserver;

  private handlePointer = (event: PointerEvent): void => {
    if (this.nodesMesh === null) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.nodesMesh, false)[0];
    if (hit === undefined || hit.instanceId === undefined) return;
    const node = this.nodes[hit.instanceId];
    if (node === undefined) return;
    // 命中即脉冲（详设「查询命中→脉冲」的交互版）
    this.pulse(hit.instanceId);
    // 同时写共享选中态：2D 视图/检查器都读这一份（P2-03）
    useSelection.getState().select(node.id);
  };

  /**
   * 把 store 里的 `focusId` 画出来：放大 + 标签常显（与 `Graph2D` 同一套规则）。
   *
   * 不做"描边/加环"是为了不加 draw call（不变量 2）也不新增美术资产——放大与常显
   * 标签在 2D/3D 都能一眼认出来，切视图后是同一种"高亮"（台账 D-91）。
   */
  private setFocus(id: string | null): void {
    const next = id === null ? -1 : (this.indexOfId.get(id) ?? -1);
    const prev = this.focusIndex;
    if (next === prev) return;
    this.focusIndex = next;
    for (const i of [prev, next]) {
      if (i >= 0 && i < this.nodes.length) this.writeNodeMatrix(i);
    }
    if (this.nodesMesh !== null) this.nodesMesh.instanceMatrix.needsUpdate = true;
    // 选中标签立刻进池，不等 300ms 的节流
    this.labelTickAt = 0;
  }

  private resize(): void {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);
  }

  pulse(index: number): void {
    if (index < 0 || index >= this.pulseAt.length) return;
    this.pulseAt[index] = performance.now();
  }

  setData(data: GraphPayload): void {
    const now = performance.now();
    const firstLoad = this.nodes.length === 0;
    const previous = new Map<string, number>();
    for (let i = 0; i < this.nodes.length; i += 1) previous.set(this.nodes[i]!.id, this.pos[i * 3 + 1]!);

    this.disposeData();
    this.nodes = data.nodes;
    this.indexOfId.clear();
    const n = this.nodes.length;
    this.pos = new Float32Array(n * 3);
    this.targetY = new Float32Array(n);
    this.sinkFrom = new Float32Array(n);
    this.sinkStart = new Float32Array(n).fill(-1);
    this.radius = new Float32Array(n);
    this.pulseAt = new Float32Array(n).fill(-1);

    this.edges = data.edges;
    this.edgeVertex = new Int32Array(this.edges.length).fill(-1);
    this.stateScale = new Float32Array(n).fill(1);
    // 证据链属性按新边表重算（trace 本身不变，边集合可能变）
    this.trace = useTrace.getState().trace;
    this.recaptureTrace();

    for (let i = 0; i < n; i += 1) {
      const node = this.nodes[i]!;
      this.indexOfId.set(node.id, i);
      const to = renderY(node);
      this.targetY[i] = to;
      this.pos[i * 3] = node.x;
      this.pos[i * 3 + 2] = node.z;
      this.radius[i] = radiusForImportance(node.importance);

      const was = previous.get(node.id);
      if (was !== undefined && Math.abs(was - to) > 0.5) {
        // 跨层：从当前位置走 easeOutCubic，绝不瞬移（详设 §10.3 下沉动画）
        this.sinkFrom[i] = was;
        this.sinkStart[i] = now;
        this.pos[i * 3 + 1] = was;
      } else {
        this.sinkFrom[i] = to;
        this.pos[i * 3 + 1] = to;
      }

      const before = this.prevAccess.get(node.id);
      if (before !== undefined && node.access_count > before) this.pulseAt[i] = now;
    }
    this.prevAccess = new Map(this.nodes.map((x) => [x.id, x.access_count]));

    // 首次装载才自动取景：之后点「刷新」保留用户当前视角
    if (firstLoad) this.frameAll();

    // ── 节点：一个 InstancedMesh ──
    this.nodeGeometry = new THREE.SphereGeometry(1, 8, 6);
    this.nodeMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: true, toneMapped: false });
    // 首帧就是沉默态：去饱和 + 0.10–0.22 的不透明度（详设 §10.3.1 参数表第一行）
    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const node = this.nodes[i]!;
      const visual = nodeVisual('dormant', node.ftype, node.strength);
      alpha[i] = visual.opacity;
      this.stateScale[i] = visual.scale;
    }
    this.nodeAlphaAttr = new THREE.InstancedBufferAttribute(alpha, 1);
    this.nodeGeometry.setAttribute('aAlpha', this.nodeAlphaAttr);
    this.installNodeAlpha(this.nodeMaterial);

    this.nodesMesh = new THREE.InstancedMesh(this.nodeGeometry, this.nodeMaterial, Math.max(n, 1));
    this.nodesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodesMesh.count = n;
    for (let i = 0; i < n; i += 1) {
      const node = this.nodes[i]!;
      this.color.set(nodeVisual('dormant', node.ftype, node.strength).color);
      this.nodesMesh.setColorAt(i, this.color);
      this.writeNodeMatrix(i);
    }
    if (this.nodesMesh.instanceColor !== null) this.nodesMesh.instanceColor.needsUpdate = true;
    this.nodesMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.nodesMesh);

    this.buildEdges(data);
    this.buildHalos();
    this.buildEnvelopes();
    this.buildLabels();

    // 初次装载 / 刷新：若已有 trace，补播一次入场脉冲（同一 query 不重播）
    if (this.trace !== null && this.trace.query_id !== this.pulsedQueryId) {
      this.pulsedQueryId = this.trace.query_id;
      this.pulseTrace();
    }

    // 刷新后选中可能指向已不在本页的节点：以 store 为准重算一次下标
    this.focusIndex = -1;
    this.setFocus(useSelection.getState().focusId);

    // 活跃集也以 store 为准（刷新不该把正在亮的那一小块抹掉）；已过期的直接丢弃
    const active = useActivity.getState().snapshot;
    this.activity = active !== null && performance.now() - active.hitAt >= ACTIVITY_TTL_MS ? null : active;
    this.restyleAll();

    this.publish(performance.now(), true);
  }

  /**
   * 某个节点此刻的视觉状态：**只由活跃集决定**，选中不参与。
   *
   * 选中是用户意图（"我要看清这个"），活跃是系统事件（"它刚被调用"）；两者时间尺度不同：
   * 选中要一直看得见，活跃只有 4–6 秒。所以选中的表达走"尺寸 + 常显标签"这条常驻通道
   * （见 `nodeSize` / `updateLabels`），颜色亮度仍按活跃集走，才不会出现"点过的节点永远
   * 亮着，等于整张图没有沉默态"。
   */
  private stateOf(id: string): VisualState {
    // P2-25：证据链优先级与活跃集取较亮者。hop0 直击 = active（亮 + 光晕 + 标签），
    // hop>0 = secondary（看得见但不抢直击的视觉中心）；点选/命中仍按原规则叠加。
    const fromTrace = traceNodeState(this.traceNodeHops, id);
    const fromActivity = this.activity?.states.get(id) ?? 'dormant';
    return brighterState(fromActivity, fromTrace ?? 'dormant');
  }

  private stateOfEdge(source: string, target: string): VisualState {
    const snapshot = this.activity;
    if (snapshot === null) return 'dormant';
    if (snapshot.edges.has(edgeKey(source, target))) return 'active';
    const a = snapshot.states.get(source);
    const b = snapshot.states.get(target);
    if (a === undefined || b === undefined) return 'dormant';
    return 'secondary';
  }

  /** 写一个节点的颜色 / 不透明度 / 尺寸倍数 / 矩阵（三态共用这一条通道） */
  private styleNode(i: number, state: VisualState): void {
    const node = this.nodes[i];
    if (node === undefined) return;
    const decay = this.activity === null ? 1 : decayWeight(performance.now() - this.activity.hitAt);
    const visual = nodeVisual(state, node.ftype, node.strength, decay);
    this.stateScale[i] = visual.scale;
    if (this.nodeAlphaAttr !== null) {
      this.nodeAlphaAttr.array[i] = visual.opacity;
      this.nodeAlphaAttr.needsUpdate = true;
    }
    if (this.nodesMesh !== null) {
      this.color.set(visual.color);
      this.nodesMesh.setColorAt(i, this.color);
      if (this.nodesMesh.instanceColor !== null) this.nodesMesh.instanceColor.needsUpdate = true;
    }
    this.writeNodeMatrix(i);
  }

  /**
   * 按当前活跃集重算"谁亮、谁暗、光晕开不开"。
   *
   * 全量重算（2000 节点 + 6000 边）而不是增量：活跃边的判定依赖两端状态，增量要维护
   * 节点→邻边的反向索引；一次命中重算实测在 1–3ms，点一下不值得为此加一层索引。
   */
  private restyleAll(): void {
    const now = performance.now();
    const snapshot = this.activity;
    const active: number[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i]!;
      const state = this.stateOf(node.id);
      this.styleNode(i, state);
      if (snapshot !== null && state !== 'dormant') {
        // 跳跃：命中节点立刻脉冲，1-hop 隔 180ms 跟上（"从被点的那一点扩散出去"）。
        // `pulseScale(t < 0) = 1`，所以未来时刻的脉冲在到点前是无副作用的占位。
        const hop = node.id === snapshot.hitId ? 0 : 1;
        this.pulseAt[i] = now + waveOffsetMs(hop, WAVE_STEP_MS);
      }
      // 光晕 / 标签的实例池按"视觉上活跃"（active）填：证据链 hop0 直击节点与点选命中
      // 走同一条通道（直击态不能只靠颜色一个维度——详设 §10.3.2 的"直击态"要求）。
      if (state === 'active') active.push(i);
    }
    this.activeIndices = active;
    if (this.nodesMesh !== null) {
      this.nodesMesh.instanceMatrix.needsUpdate = true;
      if (this.nodesMesh.instanceColor !== null) this.nodesMesh.instanceColor.needsUpdate = true;
    }
    this.writeEdgeVis();
    this.writeTraceAttrs();
    this.writeEnvelopeAlpha();
    this.updateHaloInstances();
    if (this.haloMaterial !== null) this.haloMaterial.uniforms['uOpacity']!.value = this.haloOpacity();
    // 流速只由证据链的 aFlow 决定（hop 分档，D-116）；点选活跃集 / access_count 不再
    // 驱动边流动——它们只剩"节点背景热度"这一条通道（详设 §10.3.1 注脚）。
    if (this.edgeMaterial !== null) this.edgeMaterial.uniforms['uFlowScale']!.value = 1;
    this.labelTickAt = 0;
  }

  /**
   * 光晕强度：活跃集衰减，或证据链直击节点的常亮底。
   *
   * 沉默态（无活动、无 trace）必须返回 0 且 `halos.count = 0`（验收 ①）；有 trace 时
   * 直击节点靠常亮光晕 + 标签与 1/2 跳区分（直击态不能只靠颜色一个维度）。
   */
  private haloOpacity(): number {
    if (this.activity !== null) return HALO_OPACITY + 0.15 * decayWeight(performance.now() - this.activity.hitAt);
    return this.activeIndices.length > 0 ? HALO_OPACITY : 0;
  }

  /** 边透明度 `aVis`：活跃集决定基线，证据边再抬一道下限（见 `traceAttrs`） */
  private writeEdgeVis(): void {
    const vis = this.edgeVisAttr;
    if (vis === null) return;
    const decay = this.activity === null ? 0 : decayWeight(performance.now() - this.activity.hitAt);
    for (let e = 0; e < this.edges.length; e += 1) {
      const v = this.edgeVertex[e]!;
      if (v < 0) continue;
      const edge = this.edges[e]!;
      const visual = edgeVisual(this.stateOfEdge(edge.src, edge.dst), edge.confidence, decay);
      // 证据链的边在沉默底上也要看得见：0.16 底 + mass 抬升（上限交给 shader 的 clamp）。
      // 这不会让"无 trace"的图变亮——traceAttrs 全 null 时还是原来的 0.05。
      const traceAttr = this.traceAttrs[e] ?? null;
      const opacity = traceAttr === null ? visual.opacity : Math.max(visual.opacity, 0.16 + 0.45 * traceAttr.mass);
      vis.array[v] = opacity;
      vis.array[v + 1] = opacity;
    }
    vis.needsUpdate = true;
  }

  /**
   * 证据链逐边属性 → GPU buffer：`aFlow` / `aMass` / `aHop` / `aDir`。
   *
   * 只在换数据 / 换 trace 时写一次（不是每帧）：证据链不是动画，流动是 shader 里
   * `uTime * aFlow` 的事。没有新增几何体或材质——这四个都是已有 `LineSegments` 的
   * 顶点属性，`renderer.info.render.calls` 不变。
   */
  private writeTraceAttrs(): void {
    const flow = this.edgeFlowAttr;
    const mass = this.edgeMassAttr;
    const hop = this.edgeHopAttr;
    const dir = this.edgeDirAttr;
    if (flow === null || mass === null || hop === null || dir === null) return;
    for (let e = 0; e < this.edges.length; e += 1) {
      const v = this.edgeVertex[e]!;
      if (v < 0) continue;
      const attr = this.traceAttrs[e] ?? null;
      const f = attr === null ? 0 : attr.flow;
      const m = attr === null ? 0 : attr.mass;
      const h = attr === null ? 0 : attr.hop;
      const d = attr === null ? 0 : attr.dir;
      flow.array[v] = f;
      flow.array[v + 1] = f;
      mass.array[v] = m;
      mass.array[v + 1] = m;
      hop.array[v] = h;
      hop.array[v + 1] = h;
      dir.array[v] = d;
      dir.array[v + 1] = d;
    }
    flow.needsUpdate = true;
    mass.needsUpdate = true;
    hop.needsUpdate = true;
    dir.needsUpdate = true;
  }

  /** 用当前 `this.trace` 重算逐边/逐节点证据属性（换数据或换 trace 都走这里） */
  private recaptureTrace(): void {
    this.traceAttrs = traceEdgeAttrsFor(this.edges, this.trace);
    this.traceNodeHops = traceNodeHops(this.trace);
    this.traceSummary = traceSummary(this.trace);
    this.traceReadout = traceEdgeReadout(this.traceAttrs);
  }

  /** 换了一份 trace：重算逐边属性 / 节点跳数 / 读数，新 query 或回放时播一次入场脉冲 */
  private applyTrace(trace: TraceRecord | null): void {
    this.trace = trace;
    this.recaptureTrace();
    // P2-26：回放同一条 query 也要重播（用户点了回放就该看到流动重新走一遍）；
    // 实时轮询拿到同一个 query_id 时不重播（`refreshLatestTrace` 本身也会跳过同 id）。
    if (trace !== null && (trace.query_id !== this.pulsedQueryId || useTrace.getState().mode === 'replay')) {
      this.pulsedQueryId = trace.query_id;
      this.pulseTrace();
    }
    this.restyleAll();
    this.publish(performance.now(), true);
  }

  /**
   * 入场脉冲：直击节点立刻、1 跳隔 180ms、2 跳再隔 180ms（与活跃集同一节奏
   * `waveOffsetMs`）。这是 hop=0「直击」在颜色之外的另一条通道（尺寸 + 光晕 + 标签），
   * 方向也和 §10.3.2 的「从种子流出去」一致。
   */
  private pulseTrace(): void {
    const now = performance.now();
    for (const [id, hop] of this.traceNodeHops) {
      const i = this.indexOfId.get(id);
      if (i === undefined) continue;
      this.pulseAt[i] = now + waveOffsetMs(hopBand(hop), WAVE_STEP_MS);
    }
  }

  /** 包络：沉默 0.015；活跃节点所在社区 0.06（详设 §10.3.1 参数表） */
  private writeEnvelopeAlpha(): void {
    const attr = this.envelopeAlphaAttr;
    if (attr === null) return;
    const hot = new Set<number>();
    if (this.activity !== null) {
      for (const i of this.activeIndices) {
        const node = this.nodes[i];
        // 没有社区的节点本来就没有包络球（`communityBounds` 跳过 null）
        if (node !== undefined && node.community_id !== null) hot.add(node.community_id);
      }
    }
    for (const [communityId, index] of this.envelopeByCommunity) {
      attr.array[index] = hot.has(communityId) ? ENVELOPE_ACTIVE : ENVELOPE_DORMANT;
    }
    attr.needsUpdate = true;
  }

  /** 每实例不透明度：给 MeshBasicMaterial 打一个小补丁（`instanceColor` 只有 rgb） */
  private installNodeAlpha(material: THREE.MeshBasicMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vNodeAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNodeAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vNodeAlpha;')
        .replace(
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          'vec4 diffuseColor = vec4( diffuse, opacity * vNodeAlpha );',
        );
    };
    material.customProgramCacheKey = () => 'moshi-node-alpha';
  }

  private buildEdges(data: GraphPayload): void {
    // 边数组下标 → 顶点属性下标：`buildEdgeBuffers` 会丢掉端点缺失的边，属性数组按
    // "留下的边"紧凑排列，所以这里按同样的过滤规则先编一次号，活跃态写 aVis 才对得上。
    let vertex = 0;
    for (let e = 0; e < data.edges.length; e += 1) {
      const edge = data.edges[e]!;
      if (!this.indexOfId.has(edge.src) || !this.indexOfId.has(edge.dst)) continue;
      this.edgeVertex[e] = vertex;
      vertex += 2;
    }

    // 沉默态：aFlow 全 0（静止）、aVis 全 0.05（几乎不可见的一层网）。流动性完全由
    // 活跃集驱动，不再按 access_count 常态流动（P2-02 的历史偏离，D-88 收掉）。
    const buffers: EdgeBuffers = buildEdgeBuffers(this.nodes, data.edges, () => 0);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2));
    geometry.setAttribute('aType', new THREE.BufferAttribute(buffers.aType, 1));
    geometry.setAttribute('aConf', new THREE.BufferAttribute(buffers.aConf, 1));
    const edgeCount = buffers.edgeCount;
    this.edgeVisAttr = new THREE.BufferAttribute(new Float32Array(edgeCount * 2).fill(0.05), 1);
    this.edgeFlowAttr = new THREE.BufferAttribute(new Float32Array(edgeCount * 2), 1);
    // P2-25 证据链属性：默认全 0（= 无证据链、静止、mass 无、方向不翻转）。
    // 与 aFlow/aVis 同属一个 LineSegments，ShaderMaterial 多读 4 个 attribute，不增 draw call。
    this.edgeMassAttr = new THREE.BufferAttribute(new Float32Array(edgeCount * 2), 1);
    this.edgeHopAttr = new THREE.BufferAttribute(new Float32Array(edgeCount * 2), 1);
    this.edgeDirAttr = new THREE.BufferAttribute(new Float32Array(edgeCount * 2), 1);
    geometry.setAttribute('aVis', this.edgeVisAttr);
    geometry.setAttribute('aFlow', this.edgeFlowAttr);
    geometry.setAttribute('aMass', this.edgeMassAttr);
    geometry.setAttribute('aHop', this.edgeHopAttr);
    geometry.setAttribute('aDir', this.edgeDirAttr);

    this.edgeMaterial = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uDash: { value: 4 },
        // 1 = 流速完全由 aFlow（hop 分档）决定；活跃集衰减不再乘进来（D-116）
        uFlowScale: { value: 1 },
        uEtypeColors: { value: etypeUniforms() },
      },
    });

    this.edgesMesh = new THREE.LineSegments(geometry, this.edgeMaterial);
    this.edgesMesh.frustumCulled = false;
    this.scene.add(this.edgesMesh);
    this.edgeCount = buffers.edgeCount;
  }

  /**
   * 按数据包围球自动取景，并算出「1 像素 = 多少世界单位」。
   *
   * 布局坐标的量级由 d3-force 决定（实测 ±600 上下），若把 `radiusForImportance`
   * 返回的 3–12 直接当世界单位用，距相机 400 处的球会渲染成 50px 直径的圆盘、
   * 5000 个节点糊成一团。这里令默认取景下节点直径正好落在 6–24px（详设
   * §10.3 的 3+9×importance 就是像素意图）。
   */
  private frameAll(): void {
    const n = this.nodes.length;
    if (n === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const x = this.pos[i * 3]!;
      const y = this.pos[i * 3 + 1]!;
      const z = this.pos[i * 3 + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    let radius = 1;
    for (let i = 0; i < n; i += 1) {
      const dx = this.pos[i * 3]! - cx;
      const dy = this.pos[i * 3 + 1]! - cy;
      const dz = this.pos[i * 3 + 2]! - cz;
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    const height = Math.max(this.host.clientHeight, 1);
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const focal = height / (2 * Math.tan(halfFov));
    const dist = (radius * 1.35) / Math.tan(halfFov);
    this.controls.target.set(cx, cy, cz);
    this.camera.position.set(cx, cy + dist * 0.36, cz + dist * 0.93);
    this.camera.lookAt(this.controls.target);
    this.controls.maxDistance = Math.max(dist * 3, 600);
    this.controls.update();
    this.pxScale = dist / focal;
    this.fitRadius = radius;
  }

  /**
   * 光晕实例池：常驻 `ACTIVE_NODE_CAP` 个实例，沉默态 `count = 0`。
   *
   * 为什么不按节点数建：沉默态一个光晕都不该画（详设 §10.3.1 参数表），而活跃集最多
   * 64 个节点，池子按上限建就不必在命中时重建几何体——`count` 从 0 变 N 只改一个数字，
   * draw call 始终是 1。
   */
  private buildHalos(): void {
    this.glowTexture = radialGlowTexture();
    const material = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uMap: { value: this.glowTexture }, uOpacity: { value: 0 } },
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.halos = new THREE.InstancedMesh(geometry, material, ACTIVE_NODE_CAP);
    this.halos.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.halos.frustumCulled = false;
    this.halos.count = 0;
    this.haloMaterial = material;
    this.scene.add(this.halos);
  }

  /** 把活跃节点（最多 64 个）的 billboard 写进池子的前 N 个槽位 */
  private updateHaloInstances(): void {
    const halos = this.halos;
    if (halos === null) return;
    const n = Math.min(this.activeIndices.length, ACTIVE_NODE_CAP);
    for (let k = 0; k < n; k += 1) {
      const i = this.activeIndices[k]!;
      const size = this.radius[i]! * this.pxScale * HALO_SCALE;
      this.m4.makeScale(size, size, size);
      this.m4.setPosition(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      halos.setMatrixAt(k, this.m4);
    }
    halos.count = n;
    halos.instanceMatrix.needsUpdate = true;
  }
  private buildEnvelopes(): void {
    // 球心/半径按**渲染用的 Y**（renderY：四层 ±60 / −100）算，不是布局 Y（恒 0）：
    // 否则包络球落在 y=0 平面上，而簇分布在四层上，包络会偏离簇（P2-02 返工 H4）。
    // 用 renderY 而不是裸 layerY：漏传 invalidated 会把失效成员画在 −100、球心算在 −80，
    // 球罩不住自己的成员（复审 H-1，实测 30/30 在外）。
    const bounds = communityBounds(this.nodes, (node) => renderY(node));
    if (bounds.length === 0) return;
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const colors = new Float32Array(bounds.length * 3);
    // 每社区一个透明度：沉默 0.015，活跃节点所在社区 0.06（详设 §10.3.1 参数表）。
    // 用实例属性而不是 uniform：24 个球只亮其中 1–2 个，uniform 会让所有社区一起变亮。
    const alphas = new Float32Array(bounds.length).fill(ENVELOPE_DORMANT);
    const material = new THREE.ShaderMaterial({
      vertexShader: ENVELOPE_VERT,
      fragmentShader: ENVELOPE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
    });
    this.envelopeByCommunity.clear();
    const colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    this.envelopeAlphaAttr = new THREE.InstancedBufferAttribute(alphas, 1);
    geometry.setAttribute('aCommColor', colorAttr);
    geometry.setAttribute('aCommAlpha', this.envelopeAlphaAttr);
    const mesh = new THREE.InstancedMesh(geometry, material, bounds.length);
    for (let i = 0; i < bounds.length; i += 1) {
      const b = bounds[i]!;
      this.color.setHSL((b.communityId * 0.37) % 1, 0.55, 0.55);
      this.color.toArray(colors, i * 3);
      this.envelopeByCommunity.set(b.communityId, i);
      this.m4.makeScale(b.radius, b.radius, b.radius);
      this.m4.setPosition(b.center[0], b.center[1], b.center[2]);
      mesh.setMatrixAt(i, this.m4);
    }
    colorAttr.needsUpdate = true;
    this.envelopeAlphaAttr.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    this.envelopes = mesh;
    this.scene.add(mesh);
  }

  private buildLabels(): void {
    for (const label of this.labelPool) this.scene.remove(label.obj);
    this.labelPool.length = 0;
    for (let i = 0; i < MAX_LABELS; i += 1) {
      const div = document.createElement('div');
      div.style.cssText =
        'color:#e2e8f0;font:11px/1.2 ui-sans-serif,system-ui;text-shadow:0 0 4px #05070d,0 0 8px #05070d;white-space:nowrap;padding:1px 3px;border-radius:3px;';
      const obj = new CSS2DObject(div);
      obj.visible = false;
      this.labelPool.push({ obj, div });
      this.scene.add(obj);
    }
  }

  /** 单实例的世界尺寸：`radius(px) × pxScale × 脉冲 × 选中放大 × 状态倍数` */
  private nodeSize(i: number, pulse = 1): number {
    const focus = i === this.focusIndex ? FOCUS_SCALE : 1;
    const scale = this.stateScale[i] ?? 1;
    return this.radius[i]! * this.pxScale * pulse * focus * scale;
  }

  private writeNodeMatrix(i: number): void {
    const mesh = this.nodesMesh;
    if (mesh === null) return;
    const size = this.nodeSize(i);
    this.m4.makeScale(size, size, size);
    this.m4.setPosition(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
    mesh.setMatrixAt(i, this.m4);
  }

  private animateNodes(now: number): boolean {
    const n = this.nodes.length;
    let touched = false;
    for (let i = 0; i < n; i += 1) {
      const start = this.sinkStart[i]!;
      if (start >= 0) {
        const from = this.sinkFrom[i]!;
        const to = this.targetY[i]!;
        const y = sinkY(from, to, now - start, SINK_MS);
        this.pos[i * 3 + 1] = y;
        if (now - start >= SINK_MS) {
          this.sinkStart[i] = -1;
          this.pos[i * 3 + 1] = to;
        }
        touched = true;
      }
      const pulse = this.pulseAt[i]!;
      if (pulse >= 0) {
        const t = (now - pulse) / 1000;
        if (t > PULSE_DURATION_S) {
          this.pulseAt[i] = -1;
          this.writeNodeMatrix(i);
        } else {
          const size = this.nodeSize(i, pulseScale(t));
          this.m4.makeScale(size, size, size);
          this.m4.setPosition(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
          this.nodesMesh?.setMatrixAt(i, this.m4);
        }
        touched = true;
      } else if (start >= 0) {
        this.writeNodeMatrix(i);
      }
    }
    return touched;
  }

  private updateLabels(now: number): void {
    if (now - this.labelTickAt < 300) return;
    this.labelTickAt = now;
    const cam = this.camera.position;
    // 120 是「节点附近」的经验值，但布局坐标的量级随数据增长（5000 节点约 ±700），
    // 死守 120 会让默认视角永远一个标签都没有。按数据尺度放大下限，语义仍是「只标近处的」。
    const reach = Math.max(LABEL_MAX_DISTANCE, this.fitRadius);
    const candidates: { i: number; d2: number }[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      const y = this.pos[i * 3 + 1]!;
      // 标签只跟活跃节点走：沉默 / 次级一律 0 条（详设 §10.3.1 参数表）。旧实现按
      // 「活跃层 + 距离」挑，沉默态也会挂几十条标签，2k 节点下读起来就是满屏噪声。
      if (this.stateOf(this.nodes[i]!.id) !== 'active') continue;
      const dx = this.pos[i * 3]! - cam.x;
      const dy = y - cam.y;
      const dz = this.pos[i * 3 + 2]! - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > reach * reach) continue;
      candidates.push({ i, d2 });
    }
    // 选中节点的标签常显：不吃「活跃层 + 距离」两条过滤，否则点中一个远处/失效层
    // 的节点，切视图后看不出亮的是哪个（d2 = −1 保证排到池首）
    if (this.focusIndex >= 0 && !candidates.some((c) => c.i === this.focusIndex)) {
      candidates.push({ i: this.focusIndex, d2: -1 });
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    let used = 0;
    for (const c of candidates) {
      if (used >= this.labelPool.length) break;
      const label = this.labelPool[used]!;
      const node = this.nodes[c.i]!;
      label.div.textContent = node.label;
      label.obj.position.set(
        this.pos[c.i * 3]!,
        this.pos[c.i * 3 + 1]! + this.radius[c.i]! + 4,
        this.pos[c.i * 3 + 2]!,
      );
      label.obj.visible = true;
      used += 1;
    }
    for (let i = used; i < this.labelPool.length; i += 1) this.labelPool[i]!.obj.visible = false;
    this.labelCount = used;
  }

  private publish(now: number, force = false): void {
    this.frames += 1;
    const elapsed = now - this.fpsAt;
    if (elapsed >= 500) {
      this.fps = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.fpsAt = now;
    }
    if (!force && elapsed < 500) return;
    const stats: GraphStats = {
      fps: Math.round(this.fps * 10) / 10,
      renderCalls: this.renderer.info.render.calls,
      nodeCount: this.nodes.length,
      edgeCount: this.edgeCount,
      labelCount: this.labelCount,
      halos: this.halos?.count ?? 0,
      activeNodes: this.activity?.activeNodes ?? 0,
      activeEdges: this.activity?.activeEdges ?? 0,
      focusId: this.focusIndex >= 0 ? (this.nodes[this.focusIndex]?.id ?? null) : null,
    };
    // P2-25 验收钩子：`calls` 是 `renderCalls` 的别名（台账口述的是 calls）；
    // `trace` / `edges` 让脚本不用截图也能证明"三态同图"（aFlow 0.6 与 0.3 并存）。
    // P2-26：`mode` / `query_id` 区分「实时」与「历史回放」——回放成功后脚本可直接读
    // `mode === 'replay' && query_id === <选中的 id>`，不用猜图上是哪条 trace。
    const traceState = useTrace.getState();
    // P2-19A-18：选中集发布到既有验收对象的 `selected` 字段（只加字段，不新建全局）。
    // `Window.__moshiGraph` 的类型声明不含它，但因为不会改变既有字段，运行时按对象字面量
    // 扩展、类型上做一次收口即可（声明文件不归本卡改）。
    const published = {
      ...stats,
      calls: stats.renderCalls,
      mode: traceState.mode,
      query_id: traceState.mode === 'replay' ? traceState.queryId : (this.traceSummary?.query_id ?? null),
      trace: this.traceSummary,
      edges: this.traceReadout,
      selected: [...useSelection.getState().selectedIds],
    };
    window.__moshiGraph = published as unknown as Window['__moshiGraph'];
    this.onStats?.(stats);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = this.clock.getDelta();
    if (this.edgeMaterial !== null) this.edgeMaterial.uniforms['uTime']!.value += dt;

    // 双态衰减：光晕强度与边流动速度都从衰减权重连续取值，不硬切；到期整表回落一次
    // （回落是 O(N) 的全量重算，所以只做一次，不做逐帧）。
    const activity = this.activity;
    if (activity !== null && now - activity.hitAt >= ACTIVITY_TTL_MS) {
      this.activity = null;
      this.restyleAll();
    }
    if (this.haloMaterial !== null) {
      // 与 restyleAll 用同一个取值：活跃衰减 / 证据链直击节点的常亮底（`haloOpacity`）
      this.haloMaterial.uniforms['uOpacity']!.value = this.haloOpacity();
    }
    if (this.edgeMaterial !== null) this.edgeMaterial.uniforms['uFlowScale']!.value = 1;

    const touched = this.animateNodes(now);
    if (touched) {
      if (this.nodesMesh !== null) this.nodesMesh.instanceMatrix.needsUpdate = true;
      // 光晕只跟活跃节点走（≤64 个），沉默态池子里一个实例都不画
      this.updateHaloInstances();
    }
    this.updateLabels(now);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    this.publish(now);
  };

  private disposeData(): void {
    const kill = (obj: THREE.Object3D | null): void => {
      if (obj === null) return;
      this.scene.remove(obj);
      const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      anyObj.geometry?.dispose();
      const mat = anyObj.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose();
    };
    kill(this.nodesMesh);
    kill(this.edgesMesh);
    kill(this.halos);
    kill(this.envelopes);
    this.nodesMesh = null;
    this.edgesMesh = null;
    this.halos = null;
    this.envelopes = null;
    this.edgeMaterial = null;
    this.nodeGeometry = null;
    this.nodeMaterial = null;
    this.glowTexture?.dispose();
    this.glowTexture = null;
    this.edgeCount = 0;
    this.haloMaterial = null;
    this.nodeAlphaAttr = null;
    this.edgeVisAttr = null;
    this.edgeFlowAttr = null;
    this.edgeMassAttr = null;
    this.edgeHopAttr = null;
    this.edgeDirAttr = null;
    this.envelopeAlphaAttr = null;
    this.traceAttrs = [];
    this.traceNodeHops = new Map();
    this.traceSummary = null;
    this.traceReadout = { aFlow: [], aMass: [], aHop: [], count: 0 };
    this.edges = [];
    this.edgeVertex = new Int32Array(0);
    this.activeIndices = [];
    this.envelopeByCommunity.clear();
    this.stateScale = new Float32Array(0);
    this.activity = null;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubSelection();
    this.unsubActivity();
    this.unsubTrace();
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointer);
    this.disposeData();
    for (const grid of this.grids) {
      this.scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    }
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
    delete window.__moshiGraph;
  }
}

function etypeUniforms(): THREE.Vector3[] {
  const table = [
    '#8b5cf6', // depends_on
    '#06b6d4', // logic
    '#f59e0b', // mutually_exclusive
    '#6b7280', // co_occur
    '#ef4444', // supersedes
    '#475569', // derived_from
  ];
  return table.map((hex) => {
    const c = new THREE.Color(hex);
    return new THREE.Vector3(c.r, c.g, c.b);
  });
}

export interface Graph3DProps {
  data: GraphPayload;
  onStats?: (s: GraphStats) => void;
}

export function Graph3D({ data, onStats }: Graph3DProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GraphScene | null>(null);
  const statsRef = useRef(onStats);
  statsRef.current = onStats;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const scene = new GraphScene(host, (s) => {
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

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}
