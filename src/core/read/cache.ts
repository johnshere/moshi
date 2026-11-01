/**
 * 会话内证据缓存（详设 §6.11 / 概设 §4.6.4；台账 P1-18）。
 *
 * - key：`sha256(tokenizeForFts(normalizedQuery) + scope + JSON.stringify(flags))`
 * - 命中：key 相同 **或** 与缓存条目查询向量余弦 ≥ 0.95
 * - TTL：5 分钟
 * - 失效：schema_rev 变化（任何 fact 写入/失效）→ 全清
 * - 返回：原证据包 + `cached:true`，`query_id` **新生成**（复用缓存必须重新生成，
 *   否则 feedback 会串到旧记录——`[M#]` 编号可能不同，用旧 query_id 回填会写错
 *   evidence_log）。
 */
import { sha256Hex } from '../../domain/hash.js';
import type { EvidencePackage } from './evidence.js';

export const CACHE_TTL_MS = 5 * 60_000;
export const CACHE_SIM_THRESHOLD = 0.95;

export interface CachedHit {
  pack: EvidencePackage;
  queryId: string;
}

interface CacheEntry {
  vector: readonly number[];
  pack: EvidencePackage;
  at: number;
}

/** 余弦相似度；空向量返回 0 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface CacheKeyInput {
  normalizedQuery: string;
  scope: string;
  flags: Record<string, unknown>;
  tokenize: (s: string) => string;
}

export function cacheKeyOf(input: CacheKeyInput): string {
  const tokens = input.tokenize(input.normalizedQuery);
  return sha256Hex(`${tokens}|${input.scope}|${JSON.stringify(input.flags)}`);
}

export interface EvidenceCacheOptions {
  ttlMs?: number;
  simThreshold?: number;
  /** 返回当前 schema_rev（每次 get 时检查；变化 → 全清） */
  schemaRev: () => number;
  newQueryId?: () => string;
}

export class EvidenceCache {
  private readonly ttlMs: number;
  private readonly simThreshold: number;
  private readonly schemaRev: () => number;
  private readonly newQueryId: () => string;
  private entries = new Map<string, CacheEntry>();
  private lastRev: number | null = null;

  constructor(opts: EvidenceCacheOptions) {
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.simThreshold = opts.simThreshold ?? CACHE_SIM_THRESHOLD;
    this.schemaRev = opts.schemaRev;
    this.newQueryId = opts.newQueryId ?? (() => `query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  }

  /** 命中判定：key 相同 或 向量余弦 ≥ 阈值；TTL/schema_rev 过期则视为未命中 */
  get(key: string, vector: readonly number[]): CachedHit | null {
    const rev = this.schemaRev();
    if (this.lastRev !== null && rev !== this.lastRev) {
      this.entries.clear(); // 写入/失效 → 全清
    }
    this.lastRev = rev;

    const now = Date.now();
    const exact = this.entries.get(key);
    if (exact !== undefined && now - exact.at <= this.ttlMs) {
      return { pack: exact.pack, queryId: this.newQueryId() }; // query_id 必须新生成
    }
    for (const entry of this.entries.values()) {
      if (now - entry.at > this.ttlMs) continue;
      if (cosine(entry.vector, vector) >= this.simThreshold) {
        return { pack: entry.pack, queryId: this.newQueryId() };
      }
    }
    return null;
  }

  put(key: string, vector: readonly number[], pack: EvidencePackage): void {
    this.entries.set(key, { vector, pack, at: Date.now() });
  }

  /** 显式失效（写入路径可直接调用，等价于 schema_rev 变化） */
  invalidate(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
