/**
 * 向量索引（详设 §6.4.1 / §2.2）。P1-02。
 *
 * `fact_vec` 是 sqlite-vec 的 vec0 虚拟表（384 维、已 L2 归一化）。
 * 本模块只做四件事：
 *   1. 写入同步（upsertVec / deleteVec）——vec0 不支持 `INSERT OR REPLACE`
 *      （实测 UNIQUE 冲突），必须先 DELETE 再 INSERT；
 *   2. KNN 查询（knn）——`WHERE embedding MATCH ? ORDER BY distance LIMIT k`，
 *      归一化向量的 L2 ∈ [0,2]，转相似度 `sim = 1 - distance / 2`（详设 §6.4.1）；
 *   3. 降级判定（vectorDisabled）——`meta.vector_disabled = "1"` 时整路关闭，
 *      查询侧不再调用 knn（详设 §6.4.1 降级段）；
 *   4. 缺失同步（syncFactVectors）——扫描 `fact` 里没有对应向量的行，
 *      用注入的 `encode`（sidecar）补写。encode 返回 null（sidecar 不可用）
 *      记 missing 不抛错；单条失败记 failed 继续，毒数据不堵同步。
 *
 * 一致性窗口说明：向量同步在**写事务之外**异步进行（encode 是外部 IPC，
 * 塞进 better-sqlite3 的同步事务会阻塞写路径并让一次 sidecar 失败炸掉整批）。
 * 窗口内 KNN 查不到最新事实，P1-06 融合时由符号信号兜底；doctor 用
 * I9（fact_vec 行数 == fact 行数）校验收敛。
 */
import type { Db } from '../sqlite/db.js';
import { EMBED_DIM } from '../../domain/embedding.js';

export const VEC_DIM = EMBED_DIM;

export interface KnnHit {
  fact_id: string;
  distance: number;
  /** sim = 1 - distance/2（归一化向量的 L2 ∈ [0,2]） */
  similarity: number;
}

const DISABLED_KEY = 'vector_disabled';

function disabledRow(db: Db): { value: string } | undefined {
  return db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(DISABLED_KEY) as { value: string } | undefined;
}

/** 向量路是否被标记为禁用（meta.vector_disabled） */
export function vectorDisabled(db: Db): boolean {
  return disabledRow(db) !== undefined;
}

/** 迁移/测试用：写/清降级标记 */
export function setVectorDisabled(db: Db, disabled: boolean): void {
  if (disabled) {
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(DISABLED_KEY, '1');
  } else {
    db.prepare('DELETE FROM meta WHERE key = ?').run(DISABLED_KEY);
  }
}

/** 写入/更新一条事实的向量（vec0 不支持 OR REPLACE，先删后插） */
export function upsertVec(db: Db, factId: string, embedding: Float32Array): void {
  db.prepare('DELETE FROM fact_vec WHERE fact_id = ?').run(factId);
  db.prepare('INSERT INTO fact_vec(fact_id, embedding) VALUES (?, ?)').run(factId, embedding);
}

export function deleteVec(db: Db, factId: string): void {
  db.prepare('DELETE FROM fact_vec WHERE fact_id = ?').run(factId);
}

/** 读回向量（sqlite-vec 返回 Buffer：384×4 字节），无则 null。
 * 降级容错：fact_vec 未建（vector_disabled 场景）时返回 null，不让调用方炸。 */
export function getVec(db: Db, factId: string): Float32Array | null {
  try {
    const row = db.prepare('SELECT embedding FROM fact_vec WHERE fact_id = ?').get(factId) as
      | { embedding: Buffer }
      | undefined;
    if (row === undefined) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  } catch {
    return null;
  }
}

export function countVec(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM fact_vec').get() as { n: number };
  return row.n;
}

export function countFact(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number };
  return row.n;
}

/** KNN 查询（详设 §6.4.1）。queryVec 必须是已 L2 归一化的 384 维向量 */
export function knn(db: Db, queryVec: Float32Array, k = 20): KnnHit[] {
  if (vectorDisabled(db)) {
    // 降级时整路关闭：调用方应在进门前查 vectorDisabled，这里兜底不抛
    return [];
  }
  const rows = db
    .prepare('SELECT fact_id, distance FROM fact_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(queryVec, k) as { fact_id: string; distance: number }[];
  return rows.map((r) => ({
    fact_id: r.fact_id,
    distance: r.distance,
    similarity: 1 - r.distance / 2,
  }));
}

export interface SyncOptions {
  /** 内容 → 384 维 L2 归一化向量；返回 null 表示编码服务不可用（跳过） */
  encode: (content: string) => Promise<Float32Array | null>;
  batchSize?: number;
  concurrency?: number;
  onProgress?: (synced: number, missing: number, failed: number) => void;
}

export interface SyncResult {
  synced: number;
  missing: number;
  failed: number;
}

/**
 * 补齐缺失向量：`fact` LEFT JOIN `fact_vec` 扫出无向量的行，并发 encode 后落库。
 * 只补缺失、不重算已有（内容相同的事实 refresh 不重复编码）。
 */
export async function syncFactVectors(db: Db, opts: SyncOptions): Promise<SyncResult> {
  if (vectorDisabled(db)) return { synced: 0, missing: 0, failed: 0 };
  const batchSize = opts.batchSize ?? 200;
  const concurrency = opts.concurrency ?? 4;
  const result: SyncResult = { synced: 0, missing: 0, failed: 0 };
  // encode 返回 null（sidecar 不可用）的行**本轮排除**，避免每轮重复编码同一批；
  // 下轮/下次 sync 再试。每行最多在本轮试一次。
  const blocked: string[] = [];
  for (;;) {
    const ph = blocked.length === 0 ? '' : ` AND f.id NOT IN (${blocked.map(() => '?').join(',')})`;
    const rows = db
      .prepare(
        `SELECT f.id, f.content
           FROM fact f LEFT JOIN fact_vec v ON v.fact_id = f.id
          WHERE v.fact_id IS NULL${ph}
          LIMIT ?`,
      )
      .all(...blocked, batchSize) as { id: string; content: string }[];
    if (rows.length === 0) break;
    for (let i = 0; i < rows.length; i += concurrency) {
      const chunk = rows.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (row) => {
          try {
            const vec = await opts.encode(row.content);
            if (vec === null) {
              blocked.push(row.id);
              result.missing += 1;
              return;
            }
            upsertVec(db, row.id, vec);
            result.synced += 1;
          } catch {
            result.failed += 1;
          }
        }),
      );
    }
    opts.onProgress?.(result.synced, result.missing, result.failed);
    if (rows.length < batchSize) break;
  }
  return result;
}
