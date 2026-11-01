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
  cache?: EvidenceCache;
  /**
   * `memory_annotate` 入队成功后的通知点（P1-22）。由 daemon 注入 harvest runner 的
   * `wake`；CLI / 测试不注入时只是"入队了但没人消费"，与注入前的行为一致。
   */
  onEnqueued?: () => void;
}

export function buildEvidenceCache(db: Db, cfg: Config): EvidenceCache {
  return new EvidenceCache({
    ttlMs: cfg.read.cache_ttl_ms,
    simThreshold: cfg.read.cache_similarity,
    schemaRev: () => schemaRev(db),
  });
}

/** 把 sidecar 的批量 encode 收窄成编排层要的单条形态 */
export function encodeViaSidecar(sidecar: SidecarClient): EncodeFn {
  return async (text) => {
    const vectors = await sidecar.encode([text]);
    if (vectors === null || vectors.length === 0) return null;
    return Float32Array.from(vectors[0]!);
  };
}
