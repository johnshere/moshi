/**
 * 自检页数据路由（P2-18 / 详设 §11.4、§4.3）。
 *
 *   GET /api/diag          自检页全量数据（§11.4 契约）
 *   GET /api/diag/quality  六项图质量（§4.3 端点表）
 *
 * 只读：不写库、不触发重建。健康信号靠 `core/diag` 的纯计算给出，
 * 这里只做配置 → 报告的映射与缓存头设置。
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../../infra/sqlite/db.js';
import type { Config } from '../../config.js';
import { collectDiagReport } from '../../../core/diag/collect.js';
import type { DiagModelSource } from '../../../core/diag/collect.js';

export interface DiagRoutesOpts {
  db: Db;
  cfg: Config;
}

function modelSource(cfg: Config): DiagModelSource {
  return {
    embed: cfg.model.embed_model,
    gat: cfg.model.gat_mode,
    weights_path: cfg.model.gat_weights,
  };
}

export async function diagRoutes(app: FastifyInstance, opts: DiagRoutesOpts): Promise<void> {
  const db = opts.db;
  const model = modelSource(opts.cfg);

  app.get('/', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return collectDiagReport(db, model);
  });

  app.get('/quality', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const report = collectDiagReport(db, model);
    return report.quality;
  });
}
