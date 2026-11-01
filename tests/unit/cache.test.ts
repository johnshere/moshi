/**
 * P1-18 会话内证据缓存单测（详设 §6.11；台账 P1-18）。
 *
 * 验收：同会话连查两次 → 第二次 cached:true 且 query_id 不同；
 * 写入后立即失效（schema_rev 变化 → 全清）；TTL 过期不命中；
 * 向量相似 ≥0.95 命中、<0.95 不命中。
 */
import { describe, expect, it } from 'vitest';
import { cacheKeyOf, cosine, EvidenceCache, CACHE_TTL_MS, CACHE_SIM_THRESHOLD } from '../../src/core/read/cache.js';
import type { EvidencePackage } from '../../src/core/read/evidence.js';

const emptyPack: EvidencePackage = {
  schema: 'moshi-evidence/1',
  query_id: 'q',
  status: 'ok',
  route: 'local',
  degraded: [],
  truncated: false,
  coverage: 'full',
  identity: 'resolved',
  confidence_summary: 'none',
  advice: '',
  evidence: [],
  conflicts: [],
  dependency_summary: [],
  topic_hint: { community_id: 1, label: '', fact_count: 0, derived_at: null, uri: null },
  numbered_list: [],
  stats: { candidates: 0, packed: 0, tokens: 0, latency_ms: 0 },
};

function makeCache(schemaRev = () => 0, ids = ['q1', 'q2', 'q3']): EvidenceCache {
  let i = 0;
  return new EvidenceCache({ schemaRev, newQueryId: () => ids[i++] ?? `q${i}` });
}

describe('会话内证据缓存（P1-18）', () => {
  it('cosine：正交 0、相同 1、阈值边界', () => {
    expect(cosine([], [1])).toBe(0);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 2], [1, 2])).toBeCloseTo(1);
    expect(cosine([1, 0, 0], [0.95, 0.312, 0])).toBeGreaterThanOrEqual(CACHE_SIM_THRESHOLD);
  });

  it('同 key 命中：cached:true 且 query_id 新生成', () => {
    const cache = makeCache();
    const key = cacheKeyOf({ normalizedQuery: '8080', scope: 'global', flags: {}, tokenize: (s) => s });
    expect(cache.get(key, [1, 0])).toBeNull();
    cache.put(key, [1, 0], emptyPack);
    const h1 = cache.get(key, [1, 0]);
    const h2 = cache.get(key, [1, 0]);
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h1!.queryId).not.toBe(h2!.queryId); // 每次命中 query_id 都新生成
  });

  it('向量相似 ≥0.95 命中、低于阈值不命中', () => {
    const cache = makeCache();
    const k1 = 'k1';
    const k2 = 'k2';
    cache.put(k1, [1, 0, 0], emptyPack);
    expect(cache.get(k2, [0.98, 0.2, 0])).not.toBeNull(); // 余弦≈0.98 ≥ 0.95
    expect(cache.get(k2, [0, 1, 0])).toBeNull(); // 正交
  });

  it('schema_rev 变化 → 全清；显式 invalidate 同样生效', () => {
    let rev = 0;
    const cache = makeCache(() => rev);
    const key = 'k';
    cache.put(key, [1], emptyPack);
    expect(cache.get(key, [1])).not.toBeNull();
    rev += 1; // 写入推高 schema_rev
    expect(cache.get(key, [1])).toBeNull();
    cache.put(key, [1], emptyPack);
    expect(cache.get(key, [1])).not.toBeNull();
    cache.invalidate();
    expect(cache.get(key, [1])).toBeNull();
  });

  it('TTL 过期不命中', () => {
    const cache = makeCache(() => 0);
    const key = 'k';
    cache.put(key, [1], emptyPack);
    const hit = cache.get(key, [1]);
    expect(hit).not.toBeNull();
    // 用短 TTL 的新实例验证过期路径（同一 key 向量一样）
    const tiny = new EvidenceCache({ schemaRev: () => 0, ttlMs: -1 });
    tiny.put(key, [1], emptyPack);
    expect(tiny.get(key, [1])).toBeNull();
  });

  it('TTL 与阈值常量符合规格', () => {
    expect(CACHE_TTL_MS).toBe(300_000);
    expect(CACHE_SIM_THRESHOLD).toBe(0.95);
  });
});
