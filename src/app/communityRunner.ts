/**
 * 社区划分的 daemon 侧接线（P2-11；详设 §8.4）。
 *
 * 与 `schemaInferRunner` 同构：定时器 + 脏检查。社区划分是重计算（全图 Louvain），
 * 不能每轮 harvest 都跑，用两个信号判脏：
 *   - `schema_rev`：新事实写入会推高它（DDL 触发器）；
 *   - 活跃边数：边 INSERT / 收口不推 `schema_rev`，但会改变社区结构，
 *     必须纳入脏检查，否则新边永远不触发重算。
 * 自己写回 `community_id` 是 UPDATE（无触发器、不推 schema_rev），且 `community_rev`
 * 在写回事务内推进——投影刷新不会反过来触发自身重算，无死循环。
 *
 * P2-12 起同轮还要生成社区摘要：`community_summary` 的 INSERT/UPDATE 会推高
 * `schema_rev`（002_schema_rev.sql），所以脏检查必须记录**跑完之后**的 rev，
 * 否则下一轮会把自己刚写的摘要当成"库变过"，每 5 分钟空转重写全部摘要。
 *
 * 周级调度语义由 P2-17 调度器统一接管后，本 runner 的定时器会被替换
 * （同 D-69/D-73 的处理方式），`runOnce` 保持可复用。
 */
import { recomputeCommunities, type CommunityResult } from '../core/lifecycle/community.js';
import { buildCommunitySummaries } from '../core/lifecycle/community-summary.js';
import { nowIso } from '../domain/time.js';
import type { Db } from '../infra/sqlite/db.js';
import { countEdges } from '../infra/sqlite/edgeRepo.js';
import {
  applyCommunityAssignment,
  communityRev,
  countCommunityChanges,
  loadCommunityGraph,
  loadSummaryFacts,
  writeCommunitySummaries,
} from '../infra/sqlite/communityRepo.js';
import { schemaRev } from '../infra/sqlite/metaRepo.js';

/** 兜底轮询间隔：5 分钟足够（脏检查后没变化不重算） */
export const COMMUNITY_INTERVAL_MS = 300_000;

export interface CommunityRunnerLog {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CommunityRunnerOptions {
  db: Db;
  log?: CommunityRunnerLog;
  /** 0 = 不装定时器（测试与一次性调用用） */
  intervalMs?: number;
}

export interface CommunityRunResult {
  /** 参与划分的节点数（active/disputed 事实） */
  nodes: number;
  /** 参与划分的活跃边数 */
  edges: number;
  /** 划分出的社区数 */
  communities: number;
  /** 继承旧 id 的社区数 */
  inherited: number;
  /** 实际写入的 fact 行数（dryRun 时为"将写入"） */
  wrote: number;
  /** 生成/写入的社区摘要条数（P2-12；dryRun 时为"将写入"） */
  summaries: number;
  /** Louvain 模块度 */
  modularity: number;
  /** Louvain 聚合轮数 */
  iterations: number;
  /** 写回后的 community_rev（dryRun 时为当前值） */
  rev: number;
  ms: number;
}

export interface CommunityRunnerState {
  /** 真正跑过划分的轮数（脏检查跳过的不算） */
  runs: number;
  lastRev: number | null;
  lastEdgeCount: number | null;
}

export interface CommunityRunner {
  /** 图变过才算；返回 null 表示"本轮跳过" */
  runOnce(): CommunityRunResult | null;
  /** 下一轮事件循环里跑一次（入队/写入后调用） */
  kick(): void;
  stop(): void;
  state(): CommunityRunnerState;
}

/** 执行一次社区划分（daemon 与 CLI 共用；dryRun 不写库） */
export function runCommunityOnce(
  db: Db,
  opts: { dryRun?: boolean } = {},
): CommunityRunResult {
  const startedAt = performance.now();
  const dryRun = opts.dryRun ?? false;

  const input = loadCommunityGraph(db);
  const result: CommunityResult = recomputeCommunities(input);

  // dryRun 时也要给出"将写入"行数：与库内当前值比较
  let wrote = 0;
  if (dryRun) {
    wrote = countCommunityChanges(db, result.assignment);
  } else {
    wrote = applyCommunityAssignment(db, result.assignment);
  }

  // 社区摘要（详设 §8.3.3）：与划分同轮生成，供全局路径的 topic 清单消费。
  // dryRun 不落库，但仍要算出"将写入"条数；已归属事实以库内为准，
  // 未归属（首次划分 dryRun）用本轮 assignment 覆盖。
  const summaryFacts = loadSummaryFacts(db).map((fact) => {
    const cid = result.assignment.get(fact.id);
    return cid === undefined ? fact : { ...fact, communityId: cid };
  });
  const drafts = buildCommunitySummaries(summaryFacts);
  const summaries = dryRun ? drafts.length : writeCommunitySummaries(db, drafts, nowIso());

  const sizes = [...result.sizes.values()];
  const ms = Math.round(performance.now() - startedAt);
  return {
    nodes: input.nodes.length,
    edges: input.edges.length,
    communities: sizes.length,
    inherited: result.inherited.size,
    wrote,
    summaries,
    modularity: result.modularity,
    iterations: result.iterations,
    rev: communityRev(db),
    ms,
  };
}

export function startCommunityRunner(opts: CommunityRunnerOptions): CommunityRunner {
  const { db, log } = opts;
  const intervalMs = opts.intervalMs ?? COMMUNITY_INTERVAL_MS;
  const state: CommunityRunnerState = { runs: 0, lastRev: null, lastEdgeCount: null };
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const runOnce = (): CommunityRunResult | null => {
    if (stopped) return null;
    const rev = schemaRev(db);
    const edgeCount = countEdges(db, true);
    if (state.lastRev === rev && state.lastEdgeCount === edgeCount) return null;

    const result = runCommunityOnce(db);
    // 记录写入后的 rev：摘要写库会推高 schema_rev（002 触发器），记旧值会让
    // 下一轮把自己刚写的摘要判成脏数据，形成每轮空转重写的自触发循环。
    state.lastRev = schemaRev(db);
    state.lastEdgeCount = edgeCount;
    state.runs += 1;

    log?.info(
      {
        event: 'community.run',
        nodes: result.nodes,
        edges: result.edges,
        communities: result.communities,
        inherited: result.inherited,
        wrote: result.wrote,
        summaries: result.summaries,
        modularity: result.modularity,
        rev: result.rev,
        ms: result.ms,
      },
      result.wrote > 0 || result.summaries > 0
        ? '社区划分与摘要已更新'
        : '社区划分已运行（无归属变化）',
    );
    return result;
  };

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    timer.unref();
  }

  return {
    runOnce,
    kick: () => {
      setImmediate(() => {
        void runOnce();
      });
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
    state: () => ({ ...state }),
  };
}
