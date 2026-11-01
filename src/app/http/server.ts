/**
 * Fastify REST 骨架（P0-18）。
 *
 * 两条硬性约束：
 * 1. **所有 `/api/*` 都校验 `X-Moshi-Token`**——GET 也校验，否则任意网页能读全库。
 * 2. **`/ui` 首屏下发 token**——一次性 base64url，写进内联 script，前端后续请求带在 header 里。
 *
 * `/mcp` 也挂在同一个 Fastify 实例上：用 `app.post('/mcp', ...)` 把原生 req/res
 * 交给 `createMcpHttpHandler`——这样 REST 与 MCP 共享端口，boot() 只需要一个 server。
 *
 * 为什么返回 `http.createServer(app)` 而不是 `app.server`：
 * Fastify 的 `app.server` 在 `app.ready()` 后虽然存在，但直接对它调用 `.listen()`
 * 会绕过 Fastify 内部的请求泵（request pump），导致请求进来后没有任何路由匹配。
 * 裸 `http.createServer(app)` 让 Node.js 标准事件循环驱动 Fastify，这是官方推荐做法。
 */
import http from 'node:http';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../infra/sqlite/db.js';
import type { SidecarClient } from '../../infra/sidecar/client.js';
import { countFact, countVec, vectorDisabled, VEC_DIM } from '../../infra/vec/index.js';
import { countFts } from '../../infra/sqlite/ftsRepo.js';
import type { Config } from '../config.js';
import { createMcpHttpHandler } from '../mcp/server.js';
import { buildEvidenceCache, encodeViaSidecar, type McpDeps } from '../mcp/deps.js';
import { factRoutes } from './routes/facts.js';

export interface HttpDeps {
  db: Db;
  cfg: Config;
  token: string;
  sidecar?: SidecarClient;
  /** `memory_annotate` 入队后唤醒 harvest（P1-22）；CLI 测试不传即无消费者 */
  onEnqueued?: () => void;
}

export async function buildHttpApp(deps: HttpDeps) {
  const app = Fastify({ logger: false });

  // ── 鉴权：/api/* 全部要 token ──
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const given = req.headers['x-moshi-token'];
    if (given !== deps.token) {
      return reply.code(401).send({ error: 'E_UNAUTHORIZED', message: 'Missing or invalid token' });
    }
  });

  // ── /ui 首屏：下发 token，返回完整前端 ──
  app.get('/ui', async (_req, reply) => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const template = readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
    const html = template.replace('window.__MOSHI_TOKEN__ || \'\'', `'${deps.token}'`);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ── API 路由 ──
  await app.register(factRoutes, { prefix: '/api/facts', db: deps.db });

  // ── 状态条：daemon + sidecar + vector（概设 §10.1 三灯的最小版）──
  app.get('/api/status', async (_req, reply) => {
    const status: Record<string, unknown> = { daemon: 'ok' };
    if (deps.sidecar !== undefined) {
      status.sidecar = deps.sidecar.status();
    }
    // 向量路（P1-02）：meta.vector_disabled 为关；否则显示已索引/总数
    const disabled = vectorDisabled(deps.db);
    const total = countFact(deps.db);
    const indexed = countVec(deps.db);
    status.vector = {
      state: disabled ? 'off' : 'on',
      dim: VEC_DIM,
      indexed,
      total,
    };
    // 全文检索路（P1-03）：fact_fts 可用则显示索引行数
    status.fts = {
      state: countFts(deps.db) > 0 ? 'on' : 'off',
      indexed: countFts(deps.db),
      total,
    };
    return reply.send(status);
  });

  // ── MCP 路由：把原生 req/res 交给 MCP handler ──
  // 读取通路的两个注入位（P1-20）：向量编码走 sidecar（懒启动，不应答即降级），
  // 证据缓存整个进程一份（写库 → schema_rev 变 → 全清）。
  const mcpDeps: McpDeps = {
    db: deps.db,
    cfg: deps.cfg,
    ...(deps.sidecar === undefined ? {} : { encode: encodeViaSidecar(deps.sidecar) }),
    ...(deps.onEnqueued === undefined ? {} : { onEnqueued: deps.onEnqueued }),
    cache: buildEvidenceCache(deps.db, deps.cfg),
  };
  const mcpHandler = createMcpHttpHandler(mcpDeps);
  app.post('/mcp', async (req, reply) => {
    await new Promise<void>((resolve) => {
      mcpHandler(req.raw, reply.raw);
      reply.raw.on('finish', resolve);
      reply.raw.on('close', resolve);
    });
    return reply;
  });
  app.get('/mcp', async (_req, reply) => {
    return reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'method not allowed: stateless MCP accepts POST only' },
      id: null,
    });
  });

  await app.ready();
  // Fastify 5 实例不能直接当 Node RequestListener 用：`http.createServer(app)` 会让请求
  // 挂起不响应（实测 53000/53003 均如此）。必须显式转发到 `app.routing(req, res)`。
  return {
    app,
    server: http.createServer((req, res) => {
      void app.routing(req, res);
    }),
  };
}
