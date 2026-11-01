/**
 * schema infer 的 daemon 侧接线（P1-24；详设 §8.5）。
 *
 * `adjudicate` 的第②步（互斥）只在谓词 cardinality='single-valued' 时才判，
 * 而 cardinality 由 `runSchemaInfer` 写进 `ontology`。此前这个函数全仓只有单测在调，
 * 于是 ontology 恒空、互斥裁决永远不触发——"写好了但没人调"等于没做（DoD 第 6 条）。
 *
 * 为什么不能每轮跑：`runSchemaInfer` 是全表扫描 + 分组统计。这里用 `schema_rev`
 * （每次事实写入递增的库版本号）做脏检查，库没变过就直接返回 null。
 */
import type { Db } from '../infra/sqlite/db.js';
import { schemaRev } from '../infra/sqlite/metaRepo.js';
import { runSchemaInfer, type SchemaInferResult } from '../core/lifecycle/schema-infer.js';

/** 兜底轮询间隔：只比 schema_rev，没变就什么都不做 */
export const SCHEMA_INFER_INTERVAL_MS = 60_000;

export interface SchemaInferRunnerLog {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface SchemaInferRunnerOptions {
  db: Db;
  log?: SchemaInferRunnerLog;
  /** 0 = 不装定时器（测试与一次性调用用） */
  intervalMs?: number;
}

export interface SchemaInferRunnerState {
  /** 真正跑过 base 统计的轮数（脏检查跳过的不算） */
  runs: number;
  lastRev: number | null;
  lastPredicates: number;
}

export interface SchemaInferRunner {
  /** 库变过才算；返回 null 表示"本轮跳过" */
  runOnce(): SchemaInferResult | null;
  /** 下一轮事件循环里跑一次（入队/写入后调用） */
  kick(): void;
  stop(): void;
  state(): SchemaInferRunnerState;
}

export function startSchemaInferRunner(opts: SchemaInferRunnerOptions): SchemaInferRunner {
  const { db, log } = opts;
  const intervalMs = opts.intervalMs ?? SCHEMA_INFER_INTERVAL_MS;
  const state: SchemaInferRunnerState = { runs: 0, lastRev: null, lastPredicates: 0 };
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const runOnce = (): SchemaInferResult | null => {
    if (stopped) return null;
    const rev = schemaRev(db);
    if (state.lastRev === rev) return null;

    const result = runSchemaInfer(db);
    state.lastRev = rev;
    state.runs += 1;
    state.lastPredicates = result.predicates.length;

    const promoted = result.predicates.filter((p) => p.action !== 'observe');
    if (promoted.length > 0) {
      log?.info(
        {
          event: 'schema.infer',
          predicates: result.predicates.length,
          promoted: promoted.length,
          single_valued: promoted.filter((p) => p.cardinality === 'single-valued').length,
        },
        'schema infer 已更新谓词基数性',
      );
    }
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
