/**
 * 布局 job（P2-01 / 详设 §10.4 / 决议 D16）。
 *
 * 流程照详设 §10.4 六步走：
 *
 * ```
 * 1. 读输入：active/disputed 事实 + 活跃边 + 上次坐标
 * 2. 初始位置：老事实沿用、新事实 = 社区质心 + hash(fact_id) 抖动（在 domain/layout.ts）
 * 3. 力导向：d3-force-3d，固定种子（在 worker 线程里跑，算法在 domain/layout.ts）
 * 4. 归一化到 [-100,100]³（同上）
 * 5. 平均位移 > 阈值 → 全量重算；否则**只写新增**（老行原样不动，空间记忆不变）
 * 6. 写 layout 表，layout_version = max(现有)+1，同 job 同版本
 * ```
 *
 * 第 5 步的"只写新增"是刻意的：增量之所以叫增量，是因为老节点的位置**不再变**。
 * 如果每轮都把老节点重新写一遍，用户看到的图每次刷新都在抖，坐标落库也就没有意义。
 * 判据（平均位移）只用来发现"图结构真的变了"，变了才退回全量。
 *
 * 线程边界：本文件在主线程，负责所有 IO（读库、写库、起线程）；坐标只从 worker
 * 回来。为什么非要 worker——概设 §8.9 纪律 1：前端不做力导向，而后台算 5k 节点的
 * 300 tick 是同步 CPU 活，压在主线程会把 HTTP 请求和 MCP 调用一起卡住。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  type LayoutComputation,
  type LayoutInput,
  type LayoutParams,
} from '../../domain/layout.js';
import { nowIso } from '../../domain/time.js';
import type { Db } from '../../infra/sqlite/db.js';
import {
  listLayoutCoords,
  loadLayoutSnapshot,
  maxLayoutVersion,
  writeLayout,
} from '../../infra/sqlite/layoutRepo.js';
import type { Config } from '../config.js';
import type { LayoutWorkerMessage, LayoutWorkerRequest } from './layout.worker.js';

export type LayoutMode = 'full' | 'incremental';
export type LayoutSkipReason = 'no-facts' | 'up-to-date';

export interface LayoutJobStats {
  /** 参与布局的事实总数 */
  total: number;
  /** 本次没有旧坐标、需要新落位的事实数 */
  newFacts: number;
  mode: LayoutMode | 'skip';
  ticks: number;
  /** 本次写入的 layout_version；skip 时是当前库里的版本 */
  version: number;
  /** 实际写入的行数（增量只写新增） */
  wrote: number;
  avgDisplacement: number;
  maxDisplacement: number;
  /** 增量位移超阈值，退回全量重算 */
  fellBackToFull: boolean;
  /** 坐标实际所在的工作线程（主线程为 0） */
  workerThreadId: number;
  ms: number;
  skipReason?: LayoutSkipReason;
}

export interface LayoutJobOptions {
  db: Db;
  cfg: Config;
  /** 强制全量（CLI `--full`）；增量位移超阈值时也会自动转全量 */
  full?: boolean;
}

/** 配置段 → 纯函数参数。ticks 由调用方决定（全量/增量不同） */
export function layoutParams(cfg: Config, ticks: number): LayoutParams {
  const l = cfg.layout;
  return {
    linkStrength: l.link_strength,
    linkDistance: l.link_distance,
    chargeStrength: l.charge_strength,
    centerStrength: l.center_strength,
    communityStrength: l.community_strength,
    jitterRadius: l.jitter_radius,
    extent: l.extent,
    ticks,
  };
}

/**
 * worker 入口的位置与启动参数。
 *
 * 源码直跑（tsx / vitest）时 `import.meta.url` 指向 `.ts`，worker 线程需要带上
 * TS 加载器（`--import tsx`）；`dist` 里指向 `.js`，普通 ESM 就行。同一个
 * `import.meta.url` 换扩展名，两种运行方式共用一份代码，不额外加构建产物。
 */
function layoutWorkerEntry(): { url: URL; execArgv: string[] } {
  const ext = path.extname(fileURLToPath(import.meta.url));
  return {
    url: new URL(`./layout.worker${ext}`, import.meta.url),
    execArgv: ext === '.ts' ? ['--import', 'tsx'] : [],
  };
}

/** 在 worker 线程里算一遍坐标；返回结果与该线程的 threadId（主线程为 0） */
export function runLayoutInWorker(
  input: LayoutInput,
  params: LayoutParams,
): Promise<{ result: LayoutComputation; threadId: number }> {
  const { url, execArgv } = layoutWorkerEntry();
  return new Promise<{ result: LayoutComputation; threadId: number }>((resolve, reject) => {
    const worker = new Worker(url, { execArgv });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };
    worker.once('message', (msg: LayoutWorkerMessage) => {
      finish(() => {
        if (msg.ok) resolve({ result: msg.result, threadId: msg.threadId });
        else reject(new Error(`布局 worker 失败：${msg.error}`));
      });
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => {
      finish(() => reject(new Error(`布局 worker 提前退出（code=${String(code)}）`)));
    });
    worker.postMessage({ input, params } satisfies LayoutWorkerRequest);
  });
}

/**
 * 跑一次布局 job。
 *
 * 三种结局：`no-facts`（库里没有可见事实）、`up-to-date`（没有新事实，什么都不做）、
 * `full` / `incremental`（算完落库）。没有新事实时不做任何写入——daemon 每分钟
 * 调一次也不会让 layout 表发胖。
 */
export async function runLayoutJob(opts: LayoutJobOptions): Promise<LayoutJobStats> {
  const started = performance.now();
  const { db, cfg } = opts;

  const snapshot = loadLayoutSnapshot(db);
  const previous = listLayoutCoords(db);
  const currentVersion = maxLayoutVersion(db);
  const base: LayoutJobStats = {
    total: snapshot.facts.length,
    newFacts: 0,
    mode: 'skip',
    ticks: 0,
    version: currentVersion,
    wrote: 0,
    avgDisplacement: 0,
    maxDisplacement: 0,
    fellBackToFull: false,
    workerThreadId: 0,
    ms: 0,
  };

  if (snapshot.facts.length === 0) {
    return { ...base, skipReason: 'no-facts', ms: Math.round(performance.now() - started) };
  }

  const laidOut = new Set(previous.map((r) => r.id));
  const newFacts = snapshot.facts.reduce((n, f) => (laidOut.has(f.id) ? n : n + 1), 0);
  const forcedFull = opts.full === true || previous.length === 0;
  if (!forcedFull && newFacts === 0) {
    return {
      ...base,
      newFacts,
      skipReason: 'up-to-date',
      ms: Math.round(performance.now() - started),
    };
  }

  const nodes = snapshot.facts.map((f) => ({ id: f.id, communityId: f.communityId }));
  let mode: LayoutMode = forcedFull ? 'full' : 'incremental';
  let ticks = mode === 'full' ? cfg.layout.tick_full : cfg.layout.tick_incremental;
  const runOnce = (): Promise<Awaited<ReturnType<typeof runLayoutInWorker>>> => {
    const input: LayoutInput = {
      nodes,
      links: snapshot.edges,
      previous,
      // 全量 = 冷启动：所有节点从「质心 + hash 抖动」重新起步，别让结果取决于
      // "上一次算到哪"。增量 = 沿用旧坐标，老节点才不动。
      coldStart: mode === 'full',
    };
    return runLayoutInWorker(input, layoutParams(cfg, ticks));
  };

  let out = await runOnce();

  // 增量跑出来的图如果和旧坐标差得太远，说明结构变了（不再是"加几个点"），
  // 这时候保留旧坐标反而是错的——退回全量，让整张图重新收敛。
  let fellBackToFull = false;
  if (mode === 'incremental' && out.result.avgDisplacement > cfg.layout.displacement_threshold) {
    fellBackToFull = true;
    mode = 'full';
    ticks = cfg.layout.tick_full;
    out = await runOnce();
  }

  const version = currentVersion + 1;
  const rows = mode === 'full' ? out.result.coords : out.result.coords.filter((c) => !laidOut.has(c.id));
  writeLayout(db, rows, version, nowIso());

  return {
    total: snapshot.facts.length,
    newFacts,
    mode,
    ticks,
    version,
    wrote: rows.length,
    avgDisplacement: out.result.avgDisplacement,
    maxDisplacement: out.result.maxDisplacement,
    fellBackToFull,
    workerThreadId: out.threadId,
    ms: Math.round(performance.now() - started),
  };
}
