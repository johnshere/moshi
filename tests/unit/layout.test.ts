/**
 * 布局纯函数（P2-01 / 详设 §10.4）。验收两条硬指标都在这层断言：
 *
 * - A. **同一份数据两次计算坐标逐位相同**（不是"差不多"）
 * - B. 初始抖动只由 `hash(fact_id)` 决定，布局链路里不许出现 `Math.random()`
 * - C. **三维都真正展开**（守 d3 的 `numDimensions`：写成 1 会让 y/z 永不积分）
 *
 * 力导向是浮点运算，逐位一致不是自动成立的：d3 内部的 jiggle 随机源、输入顺序、
 * 定时器步进三处都能让它变成"每次略有不同"，所以这三处各自有一条用例守着。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  factSeed,
  hashJitter,
  mulberry32,
  type LayoutCoord,
  type LayoutInput,
  type LayoutParams,
} from '../../src/domain/layout.js';

const REPO_ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '../..');

const params = (over: Partial<LayoutParams> = {}): LayoutParams => ({
  linkStrength: 0.3,
  linkDistance: 30,
  chargeStrength: -30,
  centerStrength: 0.02,
  communityStrength: 0.15,
  jitterRadius: 5,
  extent: 100,
  ticks: 300,
  ...over,
});

/** 一条链 + 跨步长边，形状接近真实图（不是全连通的星型） */
function graph(n: number, extra = 0): LayoutInput {
  const id = (i: number): string => `f${String(i).padStart(3, '0')}`;
  const nodes = Array.from({ length: n }, (_, i) => ({ id: id(i), communityId: null }));
  const links: { source: string; target: string }[] = [];
  for (let i = 0; i + 1 < n; i += 1) links.push({ source: id(i), target: id(i + 1) });
  for (let i = 0; i + 7 < n; i += 3) links.push({ source: id(i), target: id(i + 7) });
  for (let i = 0; i < extra; i += 1) links.push({ source: id(i), target: id(n - 1 - i) });
  return { nodes, links, previous: [] };
}

const maxAbs = (coords: readonly LayoutCoord[]): number =>
  coords.reduce((m, c) => Math.max(m, Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)), 0);

describe('computeLayout 决定论', () => {
  it('同一份数据两次计算，坐标逐位相同', () => {
    const input = graph(60);
    const a = computeLayout(input, params());
    const b = computeLayout(input, params());
    expect(b.coords).toEqual(a.coords);
    // 逐位：JSON 序列化后必须一字不差（toEqual 对 NaN 宽松，这里不留缝隙）
    expect(JSON.stringify(b.coords)).toBe(JSON.stringify(a.coords));
  });

  it('输入顺序不影响结果（节点/边倒序后坐标不变）', () => {
    const input = graph(40);
    const shuffled: LayoutInput = {
      nodes: [...input.nodes].reverse(),
      links: [...input.links].reverse(),
      previous: [],
    };
    const a = computeLayout(input, params({ ticks: 120 }));
    const b = computeLayout(shuffled, params({ ticks: 120 }));
    expect(b.coords).toEqual(a.coords);
  });

  it('归一化到 [-extent, extent]³，且最大跨度正好拉满', () => {
    const out = computeLayout(graph(80), params());
    expect(maxAbs(out.coords)).toBeCloseTo(100, 10);
    for (const c of out.coords) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(100.0000001);
      expect(Math.abs(c.y)).toBeLessThanOrEqual(100.0000001);
      expect(Math.abs(c.z)).toBeLessThanOrEqual(100.0000001);
    }
  });

  it('三维都真正展开：y/z 极差与 x 同量级（不是被压成一条线）', () => {
    // 这条守的是 d3-force-3d 的 numDimensions（forceSimulation 第二参）：
    // 写成 1 时 simulation.js 里 `if (nDim > 1) node.y += node.vy` 不成立，
    // y/z 永不积分，实测极差只剩 1e-2 量级（浮点噪声）——所以阈值必须是
    // "与 x 同量级"而不是 "> 0"，否则这个 bug 还能绿。
    const out = computeLayout(graph(200), params());
    const spread = (axis: 'x' | 'y' | 'z'): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of out.coords) {
        lo = Math.min(lo, c[axis]);
        hi = Math.max(hi, c[axis]);
      }
      return hi - lo;
    };
    const xr = spread('x');
    expect(xr).toBeGreaterThan(1);
    expect(spread('y')).toBeGreaterThan(0.5 * xr);
    expect(spread('z')).toBeGreaterThan(0.5 * xr);
  });

  it('不均匀图（密集社区 + 孤立远点）三轴都落在边界内且不塌成一条线', () => {
    const dense = graph(60);
    const out = computeLayout(
      {
        nodes: [...dense.nodes, { id: 'far', communityId: null }],
        links: [...dense.links],
        previous: [{ id: 'far', x: 5000, y: 0.5, z: -0.3 }],
      },
      params(),
    );
    expect(out.coords).toHaveLength(61);
    expect(maxAbs(out.coords)).toBeCloseTo(100, 6);
    const spread = (axis: 'x' | 'y' | 'z'): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of out.coords) {
        lo = Math.min(lo, c[axis]);
        hi = Math.max(hi, c[axis]);
      }
      return hi - lo;
    };
    for (const c of out.coords) {
      for (const v of [c.x, c.y, c.z]) expect(Math.abs(v)).toBeLessThanOrEqual(100.0000001);
    }
    // 远点把 x 跨度拉到 5000 时，y/z 若被同倍缩放压平就会只剩噪声
    const xr = spread('x');
    expect(spread('y')).toBeGreaterThan(0.5 * xr);
    expect(spread('z')).toBeGreaterThan(0.5 * xr);
  });

  it('单节点/空图不炸（跨度为 0 时坐标归原点）', () => {
    expect(computeLayout({ nodes: [], links: [], previous: [] }, params()).coords).toEqual([]);
    const one = computeLayout(
      { nodes: [{ id: 'only', communityId: null }], links: [], previous: [] },
      params({ ticks: 10 }),
    );
    expect(one.coords).toEqual([{ id: 'only', x: 0, y: 0, z: 0 }]);
  });
});

describe('初始抖动 = hash(fact_id)', () => {
  it('mulberry32 同种子同序列，值域 [0,1)', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seq = Array.from({ length: 64 }, () => a());
    expect(seq).toEqual(Array.from({ length: 64 }, () => b()));
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('factSeed 只看 fact_id（同 id 同种子，不同 id 不同种子）', () => {
    expect(factSeed('fact_abc')).toBe(factSeed('fact_abc'));
    expect(factSeed('fact_abc')).not.toBe(factSeed('fact_abd'));
    const seeds = new Set(Array.from({ length: 200 }, (_, i) => factSeed(`fact_${String(i)}`)));
    expect(seeds.size).toBeGreaterThan(190);
  });

  it('hashJitter 落在半径内且可复现', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = `fact_${String(i)}`;
      const a = hashJitter(id, 5);
      const b = hashJitter(id, 5);
      expect(b).toEqual(a);
      expect(Math.hypot(a.x, a.y, a.z)).toBeLessThanOrEqual(5 + 1e-12);
    }
    expect(hashJitter('fact_1', 5)).not.toEqual(hashJitter('fact_2', 5));
  });
});

describe('初始位置锚点', () => {
  // 关掉全部力，只留归一化 → 可以直接断言"新节点落位 = 锚点 + 抖动"
  const quiet = params({
    ticks: 1,
    linkStrength: 0,
    chargeStrength: 0,
    centerStrength: 0,
    communityStrength: 0,
  });
  const at = (id: string, x: number, y: number, z: number): LayoutCoord => ({ id, x, y, z });

  it('community_id 为 NULL → 全局质心 + 抖动（半径内）', () => {
    const out = computeLayout(
      {
        nodes: [
          { id: 'a', communityId: null },
          { id: 'b', communityId: null },
          { id: 'c', communityId: null },
        ],
        links: [],
        previous: [at('a', -50, 0, 0), at('b', 50, 0, 0)],
      },
      quiet,
    );
    const c = out.coords.find((r) => r.id === 'c');
    expect(c).toBeDefined();
    // 质心 = (0,0,0)，归一化把 X 跨度 100 拉到 200（倍数 2）→ 偏移 ≤ 2 × 半径
    expect(Math.hypot(c!.x, c!.y, c!.z)).toBeLessThanOrEqual(2 * 5 + 1e-9);
    expect(out.placed).toBe(1);
  });

  it('community_id 有值 → 落在本社区质心附近，而不是全局质心', () => {
    const out = computeLayout(
      {
        nodes: [
          { id: 'c1', communityId: 1 },
          { id: 'c2', communityId: 2 },
          { id: 'new', communityId: 1 },
        ],
        links: [],
        previous: [at('c1', 50, 0, 0), at('c2', -50, 0, 0)],
      },
      quiet,
    );
    const get = (id: string): LayoutCoord => out.coords.find((r) => r.id === id)!;
    const dist = (p: LayoutCoord, q: LayoutCoord): number => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    expect(dist(get('new'), get('c1'))).toBeLessThan(dist(get('new'), get('c2')));
    expect(dist(get('new'), get('c1'))).toBeLessThanOrEqual(2 * 5 + 1e-9);
  });

  it('已有坐标的事实沿用旧位置（不重新抖动）', () => {
    const out = computeLayout(
      { nodes: [{ id: 'a', communityId: null }], links: [], previous: [at('a', 3, -4, 5)] },
      quiet,
    );
    // 单节点归一化到原点，但 placed 必须是 0（说明走的是"沿用旧坐标"分支）
    expect(out.placed).toBe(0);
    expect(out.avgDisplacement).toBeGreaterThan(0); // 归一化会平移，位移不是 0
  });
});

describe('源码守卫：抖动只能用 hash', () => {
  // 扫描范围 = 本次新增的布局相关实现文件（含 CLI 命令）。
  // 全仓另有存量 `Math.random`（`src/core/read/cache.ts:95`，P1-25 的读缓存，不在本任务范围），
  // 所以这里断言的是"布局这条链路上零命中"，不是"全仓零命中"。
  const files = [
    'src/domain/layout.ts',
    'src/app/jobs/layout.job.ts',
    'src/app/jobs/layout.worker.ts',
    'src/infra/sqlite/layoutRepo.ts',
    'src/app/layoutRunner.ts',
    'src/app/cli/commands/layout.ts',
  ];

  it('布局链路的代码里不出现 Math.random()', () => {
    // 注释里会提到这条铁律本身（"不许出现 Math.random()"），所以先剥掉注释再看代码
    const strip = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of files) {
      const code = strip(readFileSync(path.join(REPO_ROOT, f), 'utf8'));
      expect(code.includes('Math.random'), `${f} 的代码里出现 Math.random`).toBe(false);
    }
  });
});
