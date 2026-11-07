/**
 * MCP 工具的公共依赖。单独一个文件，避免 `tools.ts`（注册表）与四个实现文件互相 import。
 *
 * Phase 1 起多了两个可选注入位：
 * - `encode`：查询向量化（sidecar）。缺省 = 没有编码服务 → 向量路标 `no_sidecar`，
 *   BM25 + PPR 照常出证据（详设 §6.4.1 降级段）。CLI / bench 也走这一条，
 *   所以它们测的是"没有模型时还能不能查"，而不是假装向量化在跑。
 * - `cache`：会话内证据缓存（详设 §6.11）。**每个进程一份**，`schema_rev` 变化即全清。
 */
import { EvidenceCache } from '../../core/read/cache.js';
import type { ModelScoreFn } from '../../core/read/search.js';
import type { TraceStore } from '../../core/read/trace.js';
import { schemaRev } from '../../infra/sqlite/metaRepo.js';
import type { SidecarClient } from '../../infra/sidecar/client.js';
import type { Config } from '../config.js';
import type { Db } from '../../infra/sqlite/db.js';

/** 文本 → 384 维 L2 归一化向量；返回 null = 编码服务不可用（不抛错） */
export type EncodeFn = (text: string) => Promise<Float32Array | null>;

export interface McpDeps {
  db: Db;
  cfg: Config;
  encode?: EncodeFn;
  /**
   * GAT 打分（P3-07）。daemon 注入 `SidecarClient.score` 的收窄形态；
   * CLI / 测试不注入时 `gat_mode` 即使非 off 也不打分（只记 flags）。
   */
  score?: ModelScoreFn;
  cache?: EvidenceCache;
  /**
   * `memory_annotate` 入队成功后的通知点（P1-22）。由 daemon 注入 harvest runner 的
   * `wake`；CLI / 测试不注入时只是"入队了但没人消费"，与注入前的行为一致。
   */
  onEnqueued?: () => void;
  /**
   * 证据链回放存储（P2-24，详设 §4.7）。daemon 注入进程内单例后，每次
   * `memory_query` 都往 ring buffer 留一条 trace，`GET /api/trace/:query_id` 读它；
   * CLI / 测试不注入时完全不采集（行为与 P2-24 之前一致）。
   */
  traceStore?: TraceStore;
}

export function buildEvidenceCache(db: Db, cfg: Config): EvidenceCache {
  return new EvidenceCache({
    ttlMs: cfg.read.cache_ttl_ms,
    simThreshold: cfg.read.cache_similarity,
    schemaRev: () => schemaRev(db),
  });
}

/** 把 sidecar 的 `/score` 收窄成编排层要的形态（只是透传，不做形状转换） */
export function scoreViaSidecar(sidecar: SidecarClient): ModelScoreFn {
  return async (payload) => {
    const outcome = await sidecar.score(payload);
    return { scores: outcome.scores, modelVersion: outcome.modelVersion, degraded: outcome.degraded };
  };
}

/** 把 sidecar 的批量 encode 收窄成编排层要的单条形态 */
export function encodeViaSidecar(sidecar: SidecarClient): EncodeFn {
  return async (text) => {
    const vectors = await sidecar.encode([text]);
    if (vectors === null || vectors.length === 0) return null;
    return Float32Array.from(vectors[0]!);
  };
}
