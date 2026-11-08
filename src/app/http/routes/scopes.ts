/**
 * 作用域清单路由（V-02）。
 *
 * `GET /api/scopes`：当前可见事实按 scope 分组，给顶部项目切换器提供选项。
 * 只读；`global` 排最前，其余按字典序。响应是新契约 `moshi-scopes/1`，
 * 不改任何既有 `/api/*` 契约。
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../../infra/sqlite/db.js';
import * as factRepo from '../../../infra/sqlite/factRepo.js';

export const SCOPES_SCHEMA = 'moshi-scopes/1';

export interface ScopeRoutesOpts {
  db: Db;
}

export async function scopeRoutes(app: FastifyInstance, opts: ScopeRoutesOpts): Promise<void> {
  app.get('/', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      schema: SCOPES_SCHEMA,
      items: factRepo.listScopes(opts.db).map((s) => ({
        scope: s.scope,
        fact_count: s.factCount,
      })),
    };
  });
}
