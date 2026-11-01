/**
 * 向量索引集成（P1-02 验收）：
 *
 * A. 1000 条合成向量 → KNN top-20 顺序合理（VecStore 层，不依赖 python）
 * B. sidecar 真进程全链路：30 条事实 → syncFactVectors(encode) → fact_vec == fact；
 *    KNN 查询命中近邻（依赖 python，缺了 skipIf 整组跳过）
 * C. 降级：meta.vector_disabled → knn 返回空、sync 跳过（doctor I9 口径）
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { closeDb, openDb } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { SidecarClient } from '../../src/infra/sidecar/client.js';
import {
  countFact,
  countVec,
  knn,
  setVectorDisabled,
  syncFactVectors,
  upsertVec,
  vectorDisabled,
  VEC_DIM,
} from '../../src/infra/vec/index.js';

const USER_PYTHON = 'C:\\Users\\john\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
const CANDIDATES = [
  USER_PYTHON,
  process.env.PYTHON ?? '',
  'python',
].filter((s) => s !== '');

let pythonOk = false;
let pythonPath: string = USER_PYTHON;
for (const cand of CANDIDATES) {
  try {
    execSync(`"${cand}" -c "import win32pipe, win32file"`, { stdio: 'ignore' });
    pythonPath = cand;
    pythonOk = true;
    break;
  } catch {
    // 下一个候选
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-vec-'));
  dirs.push(d);
  return d;
}

/** 造 L2 归一化 384 维向量：前两维指向角 θ（其余为 0） */
function unitVec(angleRad: number): Float32Array {
  const v = new Float32Array(VEC_DIM);
  v[0] = Math.cos(angleRad);
  v[1] = Math.sin(angleRad);
  return v;
}

const ATTRS = JSON.stringify({
  frozen: { subject: { entity_id: 'e1', name: '合成主体' }, predicate: 'is', value: 'x' },
  ext: {},
});

function insertFact(db: ReturnType<typeof openDb>['db'], id: string, content: string): void {
  db.prepare(
    `INSERT INTO fact(id, content, ftype, attrs, canonical_key, value_hash,
       valid_at, recorded_at, last_decay_at, created_at, updated_at)
     VALUES (?, ?, 'episodic', ?, ?, ?,
       '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
       '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  ).run(id, content, ATTRS, 'ck-' + id, 'vh-' + id);
}

describe('向量索引集成（P1-02）', () => {
  beforeAll(() => {
    // 清孤儿 sidecar（管道名固定，避免旧进程抢先 Accept）
    try {
      const lines = execSync('tasklist /V /FO CSV /FI "IMAGENAME eq python.exe"', {
        encoding: 'utf8',
      }).split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes('moshi_sidecar')) continue;
        const pid = line.match(/"(\d+)"\s*$/)?.[1];
        if (pid) {
          try {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          } catch {
            // 已退出
          }
        }
      }
    } catch {
      // 干净环境无需清理
    }
  });

  it('1000 条向量 → KNN 返回 top-20 且顺序合理', () => {
    const dir = tempDir();
    const { db, vectorEnabled } = openDb({ file: path.join(dir, 'moshi.db') });
    try {
      expect(vectorEnabled).toBe(true); // 本机已装 sqlite-vec
      migrate(db, { backupsDir: path.join(dir, 'backups'), vectorEnabled });
      // 1000 条：角度均匀铺满 [0, π/2)，i=0 最接近查询向量 [1,0]
      const N = 1000;
      for (let i = 0; i < N; i++) {
        insertFact(db, `f${String(i).padStart(4, '0')}`, `合成事实 ${i}`);
        upsertVec(db, `f${String(i).padStart(4, '0')}`, unitVec((i / N) * (Math.PI / 2)));
      }
      expect(countFact(db)).toBe(N);
      expect(countVec(db)).toBe(N);

      const hits = knn(db, unitVec(0), 20);
      expect(hits).toHaveLength(20);
      // 顺序合理：最近的是 f0000（同向），然后角度递增
      expect(hits[0]!.fact_id).toBe('f0000');
      expect(hits[0]!.similarity).toBeGreaterThan(0.999);
      const orderOk = hits.every((h, idx) =>
        idx === 0 || hits[idx - 1]!.distance <= h.distance,
      );
      expect(orderOk).toBe(true);
      // 角度最远的（>90° 附近）不该出现在 top-20
      expect(hits.some((h) => h.fact_id === 'f0999')).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it.skipIf(!pythonOk)('sidecar encode 全链路：30 条事实 → 同步 → fact_vec == fact → KNN 命中', async () => {
    const dir = tempDir();
    const { db, vectorEnabled } = openDb({ file: path.join(dir, 'moshi.db') });
    const cfg = loadConfig({ home: dir });
    cfg.sidecar.python_path = pythonPath;
    const sidecar = new SidecarClient({ cfg, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    try {
      migrate(db, { backupsDir: path.join(dir, 'backups'), vectorEnabled });
      for (let i = 0; i < 30; i++) {
        insertFact(db, `f${String(i).padStart(3, '0')}`, `node 版本 22 第 ${i} 次构建通过`);
      }
      // 先等 sidecar 就绪再批量同步：sync 若撞上懒启动窗口（2-5s），
      // 首轮 encode 会全部返回 null（state 还在 starting）
      await sidecar.ensureStarted();
      expect(sidecar.status().state).toBe('ready');
      const res = await syncFactVectors(db, {
        encode: async (content) => {
          const vecs = await sidecar.encode([content]);
          return vecs === null ? null : Float32Array.from(vecs[0]!);
        },
        concurrency: 4,
      });
      expect(res.synced).toBe(30);
      expect(countVec(db)).toBe(30);

      // 查询向量走同一 encode：与 f0 内容完全一致 → 最近命中 f0
      const q = await sidecar.encode(['node 版本 22 第 0 次构建通过']);
      expect(q).not.toBeNull();
      const qv = q![0];
      expect(qv).toBeDefined();
      const hits = knn(db, Float32Array.from(qv!), 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.fact_id).toBe('f000');
      // 近邻 similarity 显著高于远处
      expect(hits[0]!.similarity).toBeGreaterThan(hits[hits.length - 1]!.similarity);
    } finally {
      await sidecar.shutdown();
      closeDb(db);
    }
  });

  it('降级：vector_disabled 标记 → knn 空、sync 跳过、状态可读', async () => {
    const dir = tempDir();
    const { db, vectorEnabled } = openDb({ file: path.join(dir, 'moshi.db') });
    try {
      migrate(db, { backupsDir: path.join(dir, 'backups'), vectorEnabled });
      insertFact(db, 'f1', 'alpha');
      upsertVec(db, 'f1', unitVec(0));

      setVectorDisabled(db, true);
      expect(vectorDisabled(db)).toBe(true);
      expect(knn(db, unitVec(0), 20)).toEqual([]);
      const sync = await syncFactVectors(db, { encode: async () => unitVec(0) });
      expect(sync).toEqual({ synced: 0, missing: 0, failed: 0 });

      setVectorDisabled(db, false);
      expect(vectorDisabled(db)).toBe(false);
      expect(knn(db, unitVec(0), 20).length).toBe(1);
    } finally {
      closeDb(db);
    }
  });
});
