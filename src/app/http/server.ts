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
import { buildEvidenceCache, encodeViaSidecar, scoreViaSidecar, scoreWithBreaker, type McpDeps } from '../mcp/deps.js';
import type { Breaker } from '../../core/read/breaker.js';
import { factRoutes } from './routes/facts.js';
import { scopeRoutes } from './routes/scopes.js';
import { graphRoutes } from './routes/graph.js';
import { batchRoutes } from './routes/batch.js';
import { queueRoutes } from './routes/queues.js';
import { diagRoutes } from './routes/diag.js';
import { archiveRoutes } from './routes/archive.js';
import { searchRoutes } from './routes/search.js';
import { entitiesRoutes } from './routes/entities.js';
import { privacyRoutes, exportRoutes } from './routes/privacy.js';
import { evalRoutes } from './routes/eval.js';
import { configRoutes } from './routes/config.js';
import { updateRoutes } from './routes/update.js';
import { TraceStore } from '../../core/read/trace.js';
import { traceRoutes } from './routes/trace.js';
import { buildStatusExtras } from '../../core/ops/status.js';
import { defaultUiDistDir, staticRoutes } from './static.js';
import { HookTraceStore } from '../../core/hook/trace.js';
import { hookRoutes, createHookConnection, type HookConnection } from './routes/hook.js';
import { onboardRoutes } from '../onboard/routes.js';
import type { HookDeps } from '../hook/service.js';
import { dataPaths, defaultConfigPath } from '../config.js';

export interface HttpDeps {
  db: Db;
  cfg: Config;
  token: string;
  sidecar?: SidecarClient;
  /** `memory_annotate` 入队后唤醒 harvest（P1-22）；CLI 测试不传即无消费者 */
  onEnqueued?: () => void;
  /** `/ui/graph` 的前端产物目录；不传则用 `src/app/ui/dist`（测试注入临时目录） */
  uiDistDir?: string;
  /** 批量撤销窗口（P2-07）：默认 30s，测试传短 TTL 造过期 */
  batchOpTtlMs?: number;
  /** 证据链 ring buffer（P2-24）：不传则本实例自建一份（daemon 里 MCP 采集与 HTTP 只读共用它） */
  traceStore?: TraceStore;
  /** 模型熔断（P3-10）：daemon 注入进程内单例；不传则按配置档位、不熔断 */
  breaker?: Breaker;
  /**
   * 远程优雅停止（V-03）：安装器/卸载器先让 daemon 释放 `.node` 与数据库再替换文件。
   * 不传（CLI/测试实例）时 `/api/control/stop` 返回 501，不假装支持。
   */
  onStop?: () => void;
  /** 自动更新的测试注入点（V-03B）：不联网、不真的起安装器 */
  update?: {
    fetchImpl?: typeof fetch;
    runInstaller?: (installer: string) => void;
    currentVersion?: string;
    now?: () => Date;
  };
  /** 钩子注入台账（Z-01C）：与证据链 traceStore 分开，测试可注入 */
  hookTrace?: HookTraceStore;
  /** F8 连接态（内存）；测试可注入以复现"断开后打开界面" */
  hookConnection?: HookConnection;
  /** 配置文件路径（`/hook/api/config` 写这里）；默认按 `defaultConfigPath()` */
  configFile?: string;
  /**
   * 自建 `.moshi/project.yaml` 的额外可写白名单（数据目录之外）。
   *
   * 生产上由 `moshi hook` 的启动方按需传入；测试要往临时目录落标志也用它。
   * 不传 = 只允许数据目录内，写不进去时身份会如实降级，而不是 500。
   */
  markerRoots?: string[];
  /** 钩子脚本路径（界面展示给用户） */
  hookEntry?: string;
  /** 入驻探测的 home 与 env（测试注入临时目录；不传走 `os.homedir()` 与 `process.env`） */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 钩子召回用的编码器（测试注入假实现；不传 = 只有 BM25/PPR 通道） */
  encode?: (text: string) => Promise<Float32Array | null>;
  /** 钩子召回的模型打分（同上） */
  score?: McpDeps['score'];
}

export async function buildHttpApp(deps: HttpDeps) {
  const app = Fastify({ logger: false });

  // ── 鉴权：/api/* 全部要 token ──
  // `/hook/api/*` 与 `/ui/hook` 同口径校验：hook.js 手里必须有 token，否则任意网页
  // 都能把任意对话文本灌进台账、把记忆读出来。
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    const guarded = url.startsWith('/api/') || url.startsWith('/hook/api/') || url.startsWith('/ui/hook');
    if (!guarded) return;
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

  // ── /ui/graph 首屏：新 3D 图谱 SPA（P2-02）。老 /ui 保持原样，两套并存 ──
  await app.register(staticRoutes, {
    dir: deps.uiDistDir ?? defaultUiDistDir(),
    token: deps.token,
  });

  // ── API 路由 ──
  await app.register(factRoutes, { prefix: '/api/facts', db: deps.db });
  await app.register(scopeRoutes, { prefix: '/api/scopes', db: deps.db });
  await app.register(searchRoutes, { prefix: '/api/search', db: deps.db });
  // 批量动作与 factRoutes 同前缀、不同路由（Fastify 允许多插件共享前缀）
  await app.register(batchRoutes, {
    prefix: '/api/facts',
    db: deps.db,
    ...(deps.batchOpTtlMs === undefined ? {} : { ttlMs: deps.batchOpTtlMs }),
  });
  await app.register(queueRoutes, { prefix: '/api/queues', db: deps.db });
  // 实体合并（P2-19-A）：list / merge/preview / merge
  await app.register(entitiesRoutes, { prefix: '/api/entities', db: deps.db });
  await app.register(diagRoutes, { prefix: '/api/diag', db: deps.db, cfg: deps.cfg });
  // 隐私：总览 / purge（唯一物理删除入口，先审计后删）；全库导出（P2-19-A）
  await app.register(privacyRoutes, { prefix: '/api/privacy', db: deps.db, cfg: deps.cfg });
  await app.register(exportRoutes, { prefix: '/api/export', db: deps.db });
  // golden set 评测触发（P2-19-A）：跑完写 meta.last_eval
  await app.register(evalRoutes, { prefix: '/api/eval', db: deps.db, cfg: deps.cfg });
  // 设置页：配置白名单读写 + 维护重建（P2-19-A）
  await app.register(configRoutes, {
    prefix: '/api',
    db: deps.db,
    cfg: deps.cfg,
    ...(deps.sidecar === undefined ? {} : { sidecar: deps.sidecar }),
  });
  // 归档台账与 .proposed 三选一（P2-15）
  await app.register(archiveRoutes, { prefix: '/api/archive', db: deps.db, cfg: deps.cfg });
  // 自动更新（V-03B）：检查 / 下载 / 安装；路由内部自带 60s 缓存
  await app.register(updateRoutes, {
    cfg: deps.cfg,
    ...(deps.onStop === undefined ? {} : { onStop: deps.onStop }),
    ...(deps.update ?? {}),
  });
  await app.register(graphRoutes, { prefix: '/api/graph', db: deps.db });
  // 证据链回放（P2-24）：进程内 ring buffer 一份，MCP 采集 / HTTP 只读（D-118：无 SSE）
  const traceStore = deps.traceStore ?? new TraceStore();
  await app.register(traceRoutes, { prefix: '/api/trace', store: traceStore });

  // ── 钩子服务面（Z-01C）：`/hook/api/*` 与 `/ui/hook` ──
  // 钩子台账是**另一个** ring buffer（只记计数与枚举，不记文本），与证据链那份分开。
  const hookTrace = deps.hookTrace ?? new HookTraceStore();
  const connection = deps.hookConnection ?? createHookConnection(deps.cfg.hook.magpie_enabled);
  const hookDeps: HookDeps = {
    db: deps.db,
    cfg: deps.cfg,
    hookDir: dataPaths(deps.cfg).hook,
    dataRoot: dataPaths(deps.cfg).root,
    // 自建标志要落在被测工程自己的目录里（那是数据目录之外的路径，必须显式放行）
    ...(deps.markerRoots === undefined ? {} : { markerRoots: deps.markerRoots }),
    ...(deps.encode === undefined ? {} : { encode: deps.encode }),
    ...(deps.score === undefined ? {} : { score: deps.score }),
    ...(deps.breaker === undefined ? {} : { breaker: deps.breaker }),
  };
  await app.register(hookRoutes, {
    prefix: '/hook/api',
    deps: hookDeps,
    trace: hookTrace,
    configFile: deps.configFile ?? defaultConfigPath(),
    token: deps.token,
    connection,
  });
  // `?from=magpie` 是"连接"的唯一自动入口；断开态下**不自动连回去**（F8）。
  // 页面已迁成 React（§16.5.5），但连接语义留在服务端：前端没加载完就不算连上
  // 会让 F8 遮罩闪一下，且 Magpie 侧 `moshi.cmd` 拉起时前端可能还在下载。
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/ui/hook')) return;
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    if (query.get('from') !== 'magpie') return;
    connection.markConnected();
    deps.cfg.hook.magpie_enabled = true;
  });

  // ── 客户端入驻（Z-01C-h / i，设计 §16.3~§16.6）：探测 / 状态 / 安装计划 / 安装 ──
  await app.register(onboardRoutes, {
    prefix: '/hook/api',
    dataDir: dataPaths(deps.cfg).root,
    ...(deps.home === undefined ? {} : { home: deps.home }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
  });

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
    // P2-19A-08：模型/任务/MCP 时间戳等扩展字段（只增字段）
    return reply.send({ ...status, ...buildStatusExtras(deps.db, deps) });
  });

  // ── 远程停止（V-03）：先回包再停，避免调用方把「连接被断」误判成失败 ──
  app.post('/api/control/stop', async (_req, reply) => {
    if (deps.onStop === undefined) {
      return reply
        .code(501)
        .send({ error: 'E_NO_STOP', message: '当前实例不支持远程停止（非 daemon 进程）' });
    }
    const stop = deps.onStop;
    reply.send({ ok: true });
    setImmediate(stop);
    return reply;
  });

  // ── MCP 路由：把原生 req/res 交给 MCP handler ──
  // 读取通路的两个注入位（P1-20）：向量编码走 sidecar（懒启动，不应答即降级），
  // 证据缓存整个进程一份（写库 → schema_rev 变 → 全清）。
  const sidecar = deps.sidecar;
  const breaker = deps.breaker;
  const rawScore = sidecar === undefined ? undefined : scoreViaSidecar(sidecar);
  // P3-10：打分外面套熔断观测；sidecar 自己判失败（重启额度用尽）时补崩溃信号
  const score =
    rawScore === undefined || breaker === undefined
      ? rawScore
      : scoreWithBreaker(rawScore, breaker, () => sidecar?.status().state === 'failed');
  const mcpDeps: McpDeps = {
    db: deps.db,
    cfg: deps.cfg,
    ...(sidecar === undefined ? {} : { encode: encodeViaSidecar(sidecar) }),
    ...(score === undefined ? {} : { score }),
    ...(breaker === undefined ? {} : { breaker }),
    ...(deps.onEnqueued === undefined ? {} : { onEnqueued: deps.onEnqueued }),
    // P2-24：MCP 查询把证据链写进同一份 ring buffer，HTTP 只读接口从它取
    traceStore,
    cache: buildEvidenceCache(deps.db, deps.cfg),
  };
  const mcpHandler = createMcpHttpHandler(mcpDeps);
  app.post('/mcp', async (req, reply) => {
    await new Promise<void>((resolve) => {
      mcpHandler(req.raw, reply.raw, req.body);
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
