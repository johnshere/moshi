/**
 * 评估触发路由（P2-19A-13b / 概设 §8.1 L937「跑 golden set」）。
 *
 * `POST /api/eval/run`：同步跑一次 golden set，跑完写 `meta.last_eval`，
 * 供 `/api/diag.last_eval` 与设置页展示「最近一次评估」。
 *
 * 口径：
 * - **不 shell 出去调 CLI**，直接复用 `core/ops/eval.ts`（查询走 app 层注入）；
 * - **不在临时副本上跑**：HTTP 触发要的是"当前这个库"的结论，且这里只写
 *   `meta.last_eval`，不写 query_log（评测查询本身仍会写 query_log，与 CLI
 *   的区别在数据面：CLI 默认副本、HTTP 直接当前库。验收会说明）。
 * - golden set 不存在/为空 → 200 `{ok:false, reason:'no_golden_set'}`（不 409：
 *   "没配置"不是并发冲突，前端据此提示去配置）；
 * - 同一进程内并发触发 → 409 `E_CONFLICT` reason=`eval_running`。
 */
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { dataPaths } from '../../config.js';
import type { Config } from '../../config.js';
import {
  loadGolden,
  resolveGoldenFile,
  runGoldenSet,
  type EvalQueryFn,
} from '../../../core/ops/eval.js';
import { nowIso } from '../../../domain/time.js';
import type { Db } from '../../../infra/sqlite/db.js';
import { setMeta } from '../../../infra/sqlite/metaRepo.js';
import { runMemoryQuery } from '../../mcp/query.js';

export interface EvalRoutesOpts {
  db: Db;
  cfg: Config;
}

/**
 * golden 版本令牌（`v1`）要靠 home 展开；HTTP deps 没有 home，
 * 用默认数据目录 `<home>/.moshi` 反推（自定义 data_dir 时请直接写路径）。
 */
function homeFromConfig(cfg: Config): string {
  return path.dirname(dataPaths(cfg).root);
}

export function evalRoutes(app: FastifyInstance, opts: EvalRoutesOpts): void {
  const { db, cfg } = opts;
  // 同一 app 实例内的并发闸门；不同实例互不影响（与 batch op 的隔离口径一致）。
  let running = false;

  app.post('/run', async (_req, reply) => {
    if (running) {
      return reply.code(409).send({
        error: 'E_CONFLICT',
        message: 'golden set 评估正在运行，稍后再试',
        detail: { reason: 'eval_running' },
      });
    }
    running = true;
    const startedAt = Date.now();
    try {
      const goldenFile = resolveGoldenFile(
        cfg.eval.golden_set,
        homeFromConfig(cfg),
        cfg.eval.golden_set,
      );
      let loaded: { items: ReturnType<typeof loadGolden>['items']; skipped: number };
      try {
        loaded = loadGolden(goldenFile);
      } catch {
        return reply.send({
          ok: false,
          reason: 'no_golden_set',
          at: nowIso(),
          passed: 0,
          total: 0,
          blocking_failures: 0,
          elapsed_ms: Date.now() - startedAt,
        });
      }
      if (loaded.items.length === 0) {
        return reply.send({
          ok: false,
          reason: 'no_golden_set',
          at: nowIso(),
          passed: 0,
          total: 0,
          blocking_failures: 0,
          elapsed_ms: Date.now() - startedAt,
        });
      }

      const query: EvalQueryFn = (q, topK) =>
        runMemoryQuery(
          { db, cfg },
          {
            query: q,
            top_k: topK,
            scope: 'global',
            include_history: false,
            format: 'json',
          },
        );
      const result = await runGoldenSet(loaded.items, query, loaded.skipped);
      const at = nowIso();
      setMeta(
        db,
        'last_eval',
        JSON.stringify({
          at,
          passed: result.passed,
          total: result.total,
          blocking_failures: result.blocking_failures,
        }),
      );
      return reply.send({
        ok: !result.gate_failed,
        at,
        passed: result.passed,
        total: result.total,
        blocking_failures: result.blocking_failures,
        elapsed_ms: Date.now() - startedAt,
      });
    } catch (err) {
      reqLog(app, err);
      return reply.code(500).send({
        error: 'E_INTERNAL',
        message: `评估失败：${(err as Error).message}`,
        detail: { reason: 'eval_failed' },
      });
    } finally {
      running = false;
    }
  });
}

function reqLog(app: FastifyInstance, err: unknown): void {
  app.log.warn({ event: 'eval.run_failed', err: (err as Error).message });
}
