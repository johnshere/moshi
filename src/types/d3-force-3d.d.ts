/**
 * `d3-force-3d@3.0.6` 没有自带类型，`@types/d3-force-3d` 在 npm 上也不存在（实测 404），
 * 所以这里手写一份**最小**声明：只覆盖我们用到的表面（3D 节点、link / manyBody /
 * center / 单轴四条力、`randomSource`），不照抄整套 API——影子类型抄得越多，
 * 升级时越容易与真实实现对不上。
 *
 * 注意这是**全局**声明文件（没有顶层 import/export），`declare module` 才会被当成
 * 新模块的声明；一旦加上 `export {}` 就变成"对已有模块的增强"，而该模块没有类型，
 * 增强会直接报错。
 */
declare module 'd3-force-3d' {
  export interface LayoutSimNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
  }

  export interface LayoutSimLink<N> {
    source: string | N;
    target: string | N;
    index?: number;
  }

  export interface D3Force<N> {
    (alpha: number): void;
    initialize?(nodes: N[]): void;
  }

  export interface D3LinkForce<N> extends D3Force<N> {
    id(fn: (node: N) => string): D3LinkForce<N>;
    strength(v: number): D3LinkForce<N>;
    distance(v: number): D3LinkForce<N>;
    links(): LayoutSimLink<N>[];
  }

  export interface D3ManyBodyForce<N> extends D3Force<N> {
    strength(v: number): D3ManyBodyForce<N>;
  }

  export interface D3CenterForce<N> extends D3Force<N> {
    strength(v: number): D3CenterForce<N>;
  }

  export interface D3AxisForce<N> extends D3Force<N> {
    strength(v: number): D3AxisForce<N>;
  }

  export interface D3Simulation<N extends LayoutSimNode> {
    stop(): D3Simulation<N>;
    /** 同步跑 n 个 tick（不让 d3 自己的定时器驱动，见 domain/layout.ts 顶部注释） */
    tick(iterations?: number): D3Simulation<N>;
    alpha(v: number): D3Simulation<N>;
    /** 替换 d3 内部的随机源（`simulation.js:157`）；传入固定种子的 mulberry32 */
    randomSource(fn: () => number): D3Simulation<N>;
    force(name: string, force: D3Force<N> | null): D3Simulation<N>;
  }

  export function forceSimulation<N extends LayoutSimNode>(nodes?: N[], alpha?: number): D3Simulation<N>;
  export function forceLink<N extends LayoutSimNode>(links?: LayoutSimLink<N>[]): D3LinkForce<N>;
  export function forceManyBody<N extends LayoutSimNode>(): D3ManyBodyForce<N>;
  export function forceCenter<N extends LayoutSimNode>(
    x?: number,
    y?: number,
    z?: number,
  ): D3CenterForce<N>;
  export function forceX<N extends LayoutSimNode>(
    x?: number | ((node: N, i: number, nodes: N[]) => number),
  ): D3AxisForce<N>;
  export function forceY<N extends LayoutSimNode>(
    y?: number | ((node: N, i: number, nodes: N[]) => number),
  ): D3AxisForce<N>;
  export function forceZ<N extends LayoutSimNode>(
    z?: number | ((node: N, i: number, nodes: N[]) => number),
  ): D3AxisForce<N>;
}
