#!/usr/bin/env node
/**
 * GAT 影子链路自检（P1②）：起 sidecar → /health /encode /score /reload → shadow 不改排序。
 *
 * 用法：
 *   tsx tools/gat-shadow-check.ts --config <配置文件> [--query "<问句>"] [--top-k 8]
 *
 * 行为：
 * 1. 用配置里的 pipe_name 起一个 sidecar（打分权重 = `<data_dir>/models/gat-v1.pt`）；
 * 2. 同一问句跑两遍 `searchWithPipeline`：`gatMode=off` 与 `gatMode=shadow`，
 *    比较返回的证据顺序（shadow 只记录 δ，不得改排序），并检查 query_log 里的 model_delta；
 * 3. 换一条新连接直接对管道发 `/score`、`/reload`、`/health`，打印真实响应
 *    （含 `model_version` / `scores` / `ms`）。换连接的原因：影子链路里 `/score`
 *    超时会销毁共享连接（transport 的超时语义），复用会把「超时」误报成「连接已断开」。
 *
 * **只读校验**：会写 query_log（正常查询埋点）。验证请用库副本的配置；
 * 不改 DB schema、不改 gat_mode 默认值。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dataPaths, loadConfig } from '../src/app/config.js';
import { searchWithPipeline, type ModelScoreFn } from '../src/core/read/search.js';
import { closeDb, openDb } from '../src/infra/sqlite/db.js';
import { defaultSidecarModuleDir, spawnSidecar } from '../src/infra/sidecar/spawn.js';
import { resolvePython } from '../src/infra/sidecar/python.js';
import { connectTransport, type SidecarTransport } from '../src/infra/sidecar/transport.js';

interface Json {
  [k: string]: unknown;
}

interface Args {
  config: string;
  query?: string;
  topK: number;
}

function parseArgs(argv: readonly string[]): Args {
  let config: string | undefined;
  let query: string | undefined;
  let topK = 8;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') config = argv[++i];
    else if (arg === '--query') query = argv[++i];
    else if (arg === '--top-k') topK = Number(argv[++i]);
    else throw new Error(`未知参数：${arg}`);
  }
  if (config === undefined) throw new Error('缺 --config：验证请指向库副本的配置文件');
  if (!Number.isInteger(topK) || topK <= 0) throw new Error('--top-k 必须是正整数');
  return { config, ...(query === undefined ? {} : { query }), topK };
}

/** 探针失败不影响整体结论：把错误留在结果里 */
async function safe<T>(fn: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function unwrap<T>(r: { value: T } | { error: string }): T | null {
  return 'value' in r ? r.value : null;
}

function mapError(code: unknown): string {
  if (code === 'E_MODEL_NOT_LOADED') return 'model_not_loaded';
  if (code === 'E_INPUT_SHAPE') return 'input_shape';
  if (code === 'E_OOM') return 'error';
  return 'error';
}

function latestQueryText(db: ReturnType<typeof openDb>['db']): string | null {
  const row = db
    .prepare(
      `SELECT query_text FROM query_log
        WHERE query_text IS NOT NULL AND query_text != ''
        ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { query_text: string } | undefined;
  return row?.query_text ?? null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig({ file: path.resolve(args.config) });
  const paths = dataPaths(cfg);
  if (!existsSync(paths.db)) throw new Error(`库不存在：${paths.db}`);

  const { db } = openDb({ file: paths.db });
  const moduleDir = defaultSidecarModuleDir();
  const python = resolvePython({ configured: cfg.sidecar.python_path, moduleDir });
  if (python === null) throw new Error('没有可用的 Python 解释器（sidecar 起不来）');

  const target = {
    pipeName: process.platform === 'win32' ? cfg.sidecar.pipe_name : null,
    socketPath: process.platform === 'win32' ? null : cfg.sidecar.pipe_name,
  };
  const spawned = spawnSidecar({
    pythonPath: python.path,
    moduleDir,
    readyPath: path.join(cfg.storage.data_dir, 'sidecar.ready'),
    pipeName: cfg.sidecar.pipe_name,
    model: cfg.model.embed_model,
    dim: cfg.model.embed_dim,
    logFile: path.join(cfg.storage.data_dir, 'logs', 'sidecar.log'),
    startupTimeoutMs: cfg.sidecar.startup_timeout_ms,
  });
  let transport: SidecarTransport | null = null;
  try {
    const ready = await spawned.waitReady();
    transport = await connectTransport(target);
    const request = (p: string, body: unknown, timeoutMs: number): Promise<Json> =>
      transport!.request(p, body, timeoutMs) as Promise<Json>;

    const health = await request('/health', {}, 5_000);

    const query = args.query ?? latestQueryText(db) ?? '端口冲突怎么查';
    let captured: Json | null = null;
    let capturedNodes = 0;
    const scoreStartedAt = { ms: null as number | null };

    const score: ModelScoreFn = async (payload) => {
      captured = payload as unknown as Json;
      capturedNodes = (payload.nodes ?? []).length;
      const started = Date.now();
      try {
        const res = await request('/score', payload, cfg.sidecar.score_timeout_ms);
        scoreStartedAt.ms = Date.now() - started;
        if (res['error'] !== undefined) {
          const code = (res['error'] as Json)['code'];
          return { scores: null, modelVersion: null, degraded: [mapError(code)] };
        }
        return {
          scores: (res['scores'] as { fact_id: string; delta: number; overturn_prob: number }[]) ?? null,
          modelVersion: (res['model_version'] as string | undefined) ?? null,
          degraded: [],
        };
      } catch (err) {
        scoreStartedAt.ms = Date.now() - started;
        const name = (err as Error).name;
        return {
          scores: null,
          modelVersion: null,
          degraded: [name === 'SidecarTimeoutError' ? 'timeout' : 'no_sidecar'],
        };
      }
    };

    const encode = async (text: string): Promise<Float32Array | null> => {
      const res = await request('/encode', { texts: [text] }, cfg.sidecar.encode_timeout_ms);
      const vectors = res['vectors'] as number[][] | undefined;
      return Array.isArray(vectors) && Array.isArray(vectors[0]) ? Float32Array.from(vectors[0]) : null;
    };

    const base = {
      db,
      encode,
      score,
      params: {
        subgraphMaxNodes: cfg.subgraph.max_nodes,
        subgraphMaxEdges: cfg.subgraph.max_edges,
      },
    };
    const offRun = await searchWithPipeline({ ...base, gatMode: 'off' as const }, { query, topK: args.topK });
    const offIds = offRun.pack.evidence.map((e) => e.fact_id);

    // 缓存无（未注入 cache），故 shadow 会真的重跑并打分
    const shadowRun = await searchWithPipeline({ ...base, gatMode: 'shadow' as const }, { query, topK: args.topK });
    const shadowIds = shadowRun.pack.evidence.map((e) => e.fact_id);

    // 原始探针：换一条新连接（影子链路的 /score 超时会销毁旧连接）
    transport.close();
    transport = await connectTransport(target);
    const scoreProbe = await safe(() => (captured === null ? Promise.resolve(null) : request('/score', captured, 10_000)));
    const reloadProbe = await safe(() => request('/reload', {}, 10_000));
    const healthAfterReloadProbe = await safe(() => request('/health', {}, 5_000));
    const scoreAfterReloadProbe = await safe(() =>
      captured === null ? Promise.resolve(null) : request('/score', captured, 10_000),
    );

    // δ 落库证据：shadow 这次 query_log 的 fused_json 里应有 model_delta/overturn_prob
    const row = db
      .prepare('SELECT fused_json, stage_ms_json, degraded_json FROM query_log WHERE id = ?')
      .get(shadowRun.pack.query_id) as
      | { fused_json: string | null; stage_ms_json: string | null; degraded_json: string | null }
      | undefined;
    const fused = row?.fused_json === null || row?.fused_json === undefined ? [] : (JSON.parse(row.fused_json) as Json[]);
    const withDelta = fused.filter((f) => f['model_delta'] !== undefined);
    const rawScore = unwrap(scoreProbe);

    const out = {
      pid: ready.pid,
      query,
      health,
      off: { ids: offIds, degraded: offRun.pack.degraded, stage_ms: offRun.stageMs },
      shadow: {
        ids: shadowIds,
        same_order: JSON.stringify(offIds) === JSON.stringify(shadowIds),
        degraded: shadowRun.pack.degraded,
        stage_ms: shadowRun.stageMs,
        model_delta_entries: withDelta.length,
        model_delta_sample: withDelta.slice(0, 3),
        query_log_degraded: row?.degraded_json ?? null,
      },
      score_probe: {
        nodes: capturedNodes,
        model_version: rawScore?.['model_version'] ?? null,
        ms: rawScore?.['ms'] ?? scoreStartedAt.ms,
        score_count: Array.isArray(rawScore?.['scores']) ? (rawScore!['scores'] as unknown[]).length : 0,
        scores_sample: Array.isArray(rawScore?.['scores']) ? (rawScore!['scores'] as unknown[]).slice(0, 3) : null,
        result: scoreProbe,
        product_timeout_ms: cfg.sidecar.score_timeout_ms,
      },
      reload: reloadProbe,
      health_after_reload: healthAfterReloadProbe,
      score_after_reload: scoreAfterReloadProbe,
    };
    console.log(JSON.stringify(out, null, 2));

    // shadow 结论的退出码：排序被改写 = 1
    return out.shadow.same_order ? 0 : 1;
  } finally {
    if (transport !== null) {
      try {
        await transport.request('/terminate', {}, 2_000);
      } catch {
        /* 尽力而为 */
      }
      transport.close();
    }
    spawned.kill();
    closeDb(db);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
