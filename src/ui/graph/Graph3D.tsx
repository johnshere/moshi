/**
 * 3D 记忆图谱（详设 §10.3 逐行落成代码，P2-02）。
 *
 * 三个不变量，改动前先读：
 * 1. **坐标只从 `/api/graph` 拿**，前端绝不跑力导向（概设 §8.9 纪律 1）。这里出现的
 *    只有"把数据摆到画面上"，任何看起来像布局的计算都属于 `src/app/jobs/layout.ts`。
 * 2. **`renderer.info.render.calls ≤ 12`**：节点 1（InstancedMesh）+ 边 1（LineSegments）
 *    + 光晕 1（instanced billboard）+ 社区包络 1（instanced icosahedron）+ 参考平面 4 = 8。
 *    所以"每社区一个 mesh""每节点一个 Sprite"这类写法一律不许出现——它们会把 draw call
 *    打成 C / N。
 * 3. **不用 postprocessing bloom**（概设 §8.5.4）：光晕是贴图 + 加色混合，不是后处理。
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { GraphPayload } from '../api.js';
import {
  LAYER_INVALID,
  LAYER_LOW,
  LAYER_MID,
  LAYER_TOP,
  PULSE_DURATION_S,
  SINK_DURATION_MS,
  alphaForStrength,
  ftypeColor,
  isActiveLayer,
  normalizeActivity,
  pulseScale,
  radiusForImportance,
  renderY,
  sinkY,
} from './pure/encoding.js';
import { buildEdgeBuffers, communityBounds, type EdgeBuffers } from './pure/geometry.js';

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

/** 边：顶点属性 `aType` 选色 + `uv.x` 流动；`aConf` 调亮度 */
const EDGE_VERT = /* glsl */ `
  attribute float aType;
  attribute float aConf;
  attribute float aFlow;
  uniform float uTime;
  uniform vec3 uEtypeColors[6];
  varying vec3 vColor;
  varying float vAlpha;
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
    vUv = uv;
    // 流动点：uv.x 沿边参数 + 时间偏移，没有额外几何体
    vPhase = uTime * aFlow;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EDGE_FRAG = /* glsl */ `
  uniform float uDash;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vUv;
  varying float vPhase;

  void main() {
    float x = fract(vUv.x * uDash - vPhase);
    float dot = smoothstep(0.72, 1.0, x);
    float flowing = step(0.0001, vPhase);
    float intensity = 0.5 + 0.5 * vAlpha + 1.6 * dot * flowing;
    float alpha = mix(0.25, 0.8, vAlpha) + 0.45 * dot * flowing;
    gl_FragColor = vec4(vColor * intensity, clamp(alpha, 0.0, 1.0));
  }
`;

/** 社区包络：菲涅尔边缘亮、中间几乎透明（透明度 0.06 起步） */
const ENVELOPE_VERT = /* glsl */ `
  attribute vec3 aCommColor;
  varying vec3 vColor;
  varying vec3 vNormalV;
  varying vec3 vViewDir;

  void main() {
    vColor = aCommColor;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const ENVELOPE_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying vec3 vNormalV;
  varying vec3 vViewDir;

  void main() {
    // 多个社区的包络球经常同心嵌套（布局未按社区分离时），加法混合会迅速叠到纯白，
    // 所以整体再乘一个系数把每一层的贡献压小。
    float d = 1.0 - abs(dot(vNormalV, vViewDir));
    gl_FragColor = vec4(vColor, uOpacity * (0.6 + 1.4 * d * d));
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
    // 命中即脉冲（详设「查询命中→脉冲」的交互版）
    this.pulse(hit.instanceId);
  };

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
    const n = this.nodes.length;
    this.pos = new Float32Array(n * 3);
    this.targetY = new Float32Array(n);
    this.sinkFrom = new Float32Array(n);
    this.sinkStart = new Float32Array(n).fill(-1);
    this.radius = new Float32Array(n);
    this.pulseAt = new Float32Array(n).fill(-1);

    let maxAccess = 0;
    for (const node of this.nodes) maxAccess = Math.max(maxAccess, node.access_count);

    for (let i = 0; i < n; i += 1) {
      const node = this.nodes[i]!;
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
    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i += 1) alpha[i] = alphaForStrength(this.nodes[i]!.strength);
    this.nodeGeometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alpha, 1));
    this.installNodeAlpha(this.nodeMaterial);

    this.nodesMesh = new THREE.InstancedMesh(this.nodeGeometry, this.nodeMaterial, Math.max(n, 1));
    this.nodesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodesMesh.count = n;
    for (let i = 0; i < n; i += 1) {
      const [r, g, b] = ftypeColor(this.nodes[i]!.ftype);
      this.color.setRGB(r, g, b);
      this.nodesMesh.setColorAt(i, this.color);
      this.writeNodeMatrix(i);
    }
    if (this.nodesMesh.instanceColor !== null) this.nodesMesh.instanceColor.needsUpdate = true;
    this.nodesMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.nodesMesh);

    this.buildEdges(data);
    this.buildHalos(alpha);
    this.buildEnvelopes();
    this.buildLabels();

    this.publish(performance.now(), true);
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
    const maxAccess = this.maxAccess();
    const accessById = new Map<string, number>();
    for (const node of this.nodes) accessById.set(node.id, node.access_count);
    const flowOf = (id: string): number => normalizeActivity(accessById.get(id) ?? 0, maxAccess);
    const buffers: EdgeBuffers = buildEdgeBuffers(this.nodes, data.edges, flowOf);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2));
    geometry.setAttribute('aType', new THREE.BufferAttribute(buffers.aType, 1));
    geometry.setAttribute('aConf', new THREE.BufferAttribute(buffers.aConf, 1));
    geometry.setAttribute('aFlow', new THREE.BufferAttribute(buffers.aFlow, 1));

    this.edgeMaterial = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uDash: { value: 4 },
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

  private maxAccess(): number {
    let m = 0;
    for (const node of this.nodes) m = Math.max(m, node.access_count);
    return m;
  }

  private buildHalos(alpha: Float32Array): void {
    const n = this.nodes.length;
    if (n === 0) return;
    this.glowTexture = radialGlowTexture();
    const material = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uMap: { value: this.glowTexture }, uOpacity: { value: HALO_OPACITY } },
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.halos = new THREE.InstancedMesh(geometry, material, n);
    this.halos.count = n;
    for (let i = 0; i < n; i += 1) {
      const size = this.radius[i]! * this.pxScale * HALO_SCALE * (0.6 + 0.8 * alpha[i]!);
      this.m4.makeScale(size, size, size);
      this.m4.setPosition(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.halos.setMatrixAt(i, this.m4);
    }
    this.halos.instanceMatrix.needsUpdate = true;
    this.scene.add(this.halos);
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
    const material = new THREE.ShaderMaterial({
      vertexShader: ENVELOPE_VERT,
      fragmentShader: ENVELOPE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      // 详设 §10.3：社区包络透明度 0.06。加法混合下多个同心球会叠亮，片元里已对
      // 每层再乘一个随视线角变化的系数（见 ENVELOPE_FRAG），基础值按规格取 0.06。
      uniforms: { uOpacity: { value: 0.06 } },
    });
    geometry.setAttribute('aCommColor', new THREE.InstancedBufferAttribute(colors, 3));
    const mesh = new THREE.InstancedMesh(geometry, material, bounds.length);
    for (let i = 0; i < bounds.length; i += 1) {
      const b = bounds[i]!;
      this.color.setHSL((b.communityId * 0.37) % 1, 0.55, 0.55);
      this.color.toArray(colors, i * 3);
      this.m4.makeScale(b.radius, b.radius, b.radius);
      this.m4.setPosition(b.center[0], b.center[1], b.center[2]);
      mesh.setMatrixAt(i, this.m4);
    }
    geometry.setAttribute('aCommColor', new THREE.InstancedBufferAttribute(colors, 3));
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

  private writeNodeMatrix(i: number): void {
    const mesh = this.nodesMesh;
    if (mesh === null) return;
    const size = this.radius[i]! * this.pxScale;
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
          const size = this.radius[i]! * this.pxScale * pulseScale(t);
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
      if (!isActiveLayer(y)) continue;
      const dx = this.pos[i * 3]! - cam.x;
      const dy = y - cam.y;
      const dz = this.pos[i * 3 + 2]! - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > reach * reach) continue;
      candidates.push({ i, d2 });
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
    };
    window.__moshiGraph = { ...stats };
    this.onStats?.(stats);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = this.clock.getDelta();
    if (this.edgeMaterial !== null) this.edgeMaterial.uniforms['uTime']!.value += dt;
    const touched = this.animateNodes(now);
    if (touched) {
      if (this.nodesMesh !== null) this.nodesMesh.instanceMatrix.needsUpdate = true;
      if (this.halos !== null) {
        // 光晕跟着节点走（只在下沉/脉冲期间动）
        for (let i = 0; i < this.nodes.length; i += 1) {
          const size = this.radius[i]! * this.pxScale * HALO_SCALE;
          this.m4.makeScale(size, size, size);
          this.m4.setPosition(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
          this.halos.setMatrixAt(i, this.m4);
        }
        this.halos.instanceMatrix.needsUpdate = true;
      }
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
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
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
