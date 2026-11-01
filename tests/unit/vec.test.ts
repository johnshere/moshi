/**
 * VecStore 单测（P1-02）：vec0 虚拟表的行为（upsert/delete/get/knn/降级标记）
 * 用内存库 + sqlite-vec 扩展。核心行为与探针一致：vec0 不支持 `INSERT OR REPLACE`，
 * upsert 必须先 DELETE 再 INSERT；KNN 按距离升序，sim = 1 - d/2。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import {
  countFact,
  countVec,
  deleteVec,
  getVec,
  knn,
  setVectorDisabled,
  syncFactVectors,
  upsertVec,
  vectorDisabled,
  VEC_DIM,
} from '../../src/infra/vec/index.js';

const require = createRequire(import.meta.url);

function openMem() {
  const db = new Database(':memory:');
  // 与 src/infra/sqlite/db.ts 的 tryLoadVector 相同的加载方式
  const mod = require('sqlite-vec') as { load: (d: Database.Database) => void };
  mod.load(db);
  db.exec(`
    CREATE TABLE fact(
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      valid_at TEXT NOT NULL,
      valid_to TEXT,
      strength REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      ftype TEXT NOT NULL DEFAULT 'obs',
      scope TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE fact_vec USING vec0(
      fact_id TEXT PRIMARY KEY,
      embedding float[${VEC_DIM}]
    );
  `);
  db.prepare(
    "INSERT INTO fact(id, content, valid_at) VALUES ('f1','alpha one','2026-11-01'), ('f2','beta two','2026-11-01'), ('f3','gamma three','2026-11-01')",
  ).run();
  return db;
}

/** 造 384 维 L2 归一化向量：只在前 2 维有值，其余为 0 */
function vec(a: number, b: number): Float32Array {
  const v = new Float32Array(VEC_DIM);
  v[0] = a;
  v[1] = b;
  const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  v[0] /= norm;
  v[1] /= norm;
  return v;
}

let db: Database.Database;
beforeEach(() => {
  db = openMem();
});

describe('VecStore（P1-02）', () => {
  it('upsert 幂等：重复写入同一 fact_id 只留一行（vec0 无 OR REPLACE，须先删后插）', () => {
    upsertVec(db, 'f1', vec(1, 0));
    upsertVec(db, 'f1', vec(0, 1));
    expect(countVec(db)).toBe(1);
    const got = getVec(db, 'f1');
    expect(got).not.toBeNull();
    // 第二次写入生效（前 2 维 ≈ [0,1]）
    expect(got![1]).toBeCloseTo(1, 5);
    expect(got![0]).toBeCloseTo(0, 5);
  });

  it('getVec 无该事实时返回 null；delete 后 count 减少', () => {
    expect(getVec(db, 'nope')).toBeNull();
    upsertVec(db, 'f1', vec(1, 0));
    upsertVec(db, 'f2', vec(0, 1));
    expect(countVec(db)).toBe(2);
    deleteVec(db, 'f1');
    expect(countVec(db)).toBe(1);
    expect(getVec(db, 'f1')).toBeNull();
  });

  it('knn 按距离升序返回 top-k，sim = 1 - d/2', () => {
    upsertVec(db, 'f1', vec(1, 0)); // 查询点
    upsertVec(db, 'f2', vec(0.95, 0.31)); // 近
    upsertVec(db, 'f3', vec(0, 1)); // 远
    const hits = knn(db, vec(0.98, 0.2), 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.fact_id).toBe('f2');
    expect(hits[1]!.fact_id).toBe('f1');
    for (const h of hits) {
      expect(h.similarity).toBeCloseTo(1 - h.distance / 2, 10);
    }
    // 远点不出现在 top-2 里
    expect(hits.some((h) => h.fact_id === 'f3')).toBe(false);
  });

  it('knn 降级：meta.vector_disabled 时返回空数组', () => {
    upsertVec(db, 'f1', vec(1, 0));
    setVectorDisabled(db, true);
    expect(vectorDisabled(db)).toBe(true);
    expect(knn(db, vec(1, 0), 20)).toEqual([]);
    setVectorDisabled(db, false);
    expect(vectorDisabled(db)).toBe(false);
    expect(knn(db, vec(1, 0), 20).length).toBe(1);
  });

  it('syncFactVectors 补齐缺失：encode 注入可空/失败不炸', async () => {
    db.prepare("INSERT INTO fact(id, content, valid_at) VALUES ('f4','delta four','2026-11-01')").run();
    const seen: string[] = [];
    const res = await syncFactVectors(db, {
      encode: async (content) => {
        seen.push(content);
        if (content === 'gamma three') return null; // 模拟 sidecar 不可用/跳过
        return vec(1, 0);
      },
      batchSize: 2,
      concurrency: 2,
    });
    expect(res.synced).toBe(3); // f1 f2 f4
    expect(res.missing).toBe(1); // f3
    expect(res.failed).toBe(0);
    expect(countVec(db)).toBe(3);
    expect(seen).toContain('alpha one');
    expect(seen).toContain('delta four');
  });

  it('syncFactVectors 幂等：再跑只补新的；vectorDisabled 时直接跳过', async () => {
    const first = await syncFactVectors(db, { encode: async () => vec(1, 0), concurrency: 2 });
    expect(first.synced).toBe(3);
    const second = await syncFactVectors(db, { encode: async () => vec(0, 1), concurrency: 2 });
    expect(second.synced).toBe(0);
    // 内容相同的向量不被重算（upsert 不触发，count 不变）
    expect(countVec(db)).toBe(3);

    setVectorDisabled(db, true);
    const third = await syncFactVectors(db, { encode: async () => vec(0, 1), concurrency: 2 });
    expect(third).toEqual({ synced: 0, missing: 0, failed: 0 });
  });

  it('countFact / countVec 口径（I9 用）', () => {
    expect(countFact(db)).toBe(3);
    upsertVec(db, 'f1', vec(1, 0));
    upsertVec(db, 'f2', vec(0, 1));
    expect(countVec(db)).toBe(2);
  });
});
