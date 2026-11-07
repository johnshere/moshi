/**
 * P3-08 验收后修复：门控路径抛错时查询必须照常返回。
 *
 * 用 `vi.mock` 把 `applyNeuralDeltas` 换成必抛版本——真实触发需要并发删事实，
 * 单测里直接把这个分支钉死更可靠。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boom = vi.hoisted(() => {
  return { enabled: false };
});

vi.mock('../../src/core/read/gate-delta.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/read/gate-delta.js')>();
  return {
    ...actual,
    applyNeuralDeltas: (...args: Parameters<typeof actual.applyNeuralDeltas>) => {
      if (boom.enabled) throw new Error('gate blew up');
      return actual.applyNeuralDeltas(...args);
    },
  };
});

import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { searchWithPipeline } from '../../src/core/read/search.js';
import { insertFact } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  boom.enabled = false;
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-gatfall-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

describe('on 模式门控异常回退（P3-08）', () => {
  it('applyNeuralDeltas 抛错 → 查询仍返回证据，degraded 带 no_model', async () => {
    const db = freshDb();
    insertFact(db, { content: 'alpha one' });
    insertFact(db, { content: 'alpha two' });
    syncMissingFts(db);
    boom.enabled = true;

    const out = await searchWithPipeline(
      {
        db,
        gatMode: 'on',
        score: async (payload) => ({
          scores: payload.nodes.map((n) => ({ fact_id: n.fact_id, delta: 0.1, overturn_prob: 0.1 })),
          modelVersion: 'gat-v1@test',
          degraded: [],
        }),
      },
      { query: 'alpha', scope: 'global', topK: 10 },
    );

    expect(out.pack.evidence.length).toBe(2);
    expect(out.pack.degraded).toContain('no_model');
    expect(out.stageMs['model_applied']).toBeUndefined();
    const changed = db.prepare("SELECT COUNT(*) AS n FROM fact WHERE confidence_source = 'gat_delta'").get() as {
      n: number;
    };
    expect(changed.n).toBe(0);
  });
});
