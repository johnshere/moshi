/**
 * P1-24 schema infer 接线单测（台账 P1-24；DoD 第 6 条：模块必须被真实进程调用）。
 *
 * 这里测三件事：
 * 1. `schema_rev` 没变就不重算（全表统计不能每轮跑）；
 * 2. runner 跑过之后 ontology 里真的出现 single-valued，且互斥裁决从此可达
 *    —— 这正是审计指出的"ontology 恒空 → ② 永不执行"的端到端反例；
 * 3. `stop()` 之后定时器不再触发。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact, listByIds } from '../../src/infra/sqlite/factRepo.js';
import { findMutexWin } from '../../src/infra/sqlite/adjudicationRepo.js';
import { getPredicateCardinality } from '../../src/infra/sqlite/ontologyRepo.js';
import { startSchemaInferRunner } from '../../src/app/schemaInferRunner.js';
import { adjudicate } from '../../src/core/read/adjudicate.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-sir-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addFact(
  db: Db,
  id: string,
  opts: { pred: string; subject: string; value: string; confidence?: number; status?: 'active' | 'disputed' },
): void {
  insertFact(db, {
    id,
    content: `${opts.pred} ${opts.subject} = ${opts.value}`,
    ftype: 'semantic',
    confidence: opts.confidence ?? 0.8,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: opts.status ?? 'active',
    attrs: {
      frozen: { subject: { entity_id: `en_${opts.subject}`, name: opts.subject }, predicate: opts.pred, value: opts.value },
      ext: {},
    },
    canonicalKey: `ck_${opts.pred}_${opts.subject}`,
    valueHash: `vh_${opts.value}`,
    scope: 'global',
    supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: null,
    span: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

describe('schemaInferRunner（P1-24 接线）', () => {
  it('首次运行即算一次；schema_rev 未变时跳过，变了才重算', () => {
    const db = freshDb();
    const runner = startSchemaInferRunner({ db, intervalMs: 0 });

    // 新库 lastRev 为空 → 先算一次（daemon 启动路径就靠这一次把历史库补上）
    expect(runner.runOnce()).not.toBeNull();
    expect(runner.state().runs).toBe(1);
    expect(runner.state().lastRev).not.toBeNull();

    // 库没动过：第二次必须直接跳过（全表统计不能每轮跑）
    expect(runner.runOnce()).toBeNull();
    expect(runner.state().runs).toBe(1);

    addFact(db, 'f_1', { pred: 'port_state', subject: 'pkg_1', value: 'open' });
    expect(runner.runOnce()).not.toBeNull();
    expect(runner.state().runs).toBe(2);
  });

  it('runner 跑完后 ontology 出现 single-valued，互斥裁决端到端可达', () => {
    const db = freshDb();
    // 20 个不同键、同谓词、每个键只有一个取值 → single_ratio = 1
    for (let i = 0; i < 20; i += 1) {
      addFact(db, `f_port_${String(i)}`, { pred: 'port_state', subject: `pkg_${String(i)}`, value: 'open' });
    }

    const runner = startSchemaInferRunner({ db, intervalMs: 0 });
    const res = runner.runOnce();
    expect(res).not.toBeNull();
    expect(getPredicateCardinality(db, 'port_state')).toBe('single-valued');

    // 同一个 canonical_key 出现两条事实 → ② 才有东西可判
    addFact(db, 'f_dup_hi', { pred: 'port_state', subject: 'pkg_x', value: 'open', confidence: 0.95 });
    addFact(db, 'f_dup_lo', { pred: 'port_state', subject: 'pkg_x', value: 'closed', confidence: 0.6 });

    const facts = listByIds(db, ['f_dup_hi', 'f_dup_lo']);
    expect(facts).toHaveLength(2);
    const adj = adjudicate(db, facts, [], { now: '2026-11-01T00:00:00.000Z' });

    // 败者仍留在 kept 里（只是打了 disputed 标记供证据包标注），但必须被标记
    expect(adj.stats.disputed).toBe(1);
    const byId = new Map(adj.kept.map((k) => [k.fact.id, k]));
    expect(byId.get('f_dup_lo')!.flags).toContain('disputed');
    expect(byId.get('f_dup_hi')!.flags).not.toContain('disputed');
    // 裁决结果落库（不是只改内存里的 flag）
    expect(findMutexWin(db, ['f_dup_hi', 'f_dup_lo'])).not.toBeNull();
  });

  it('stop() 之后定时器不再跑', async () => {
    const db = freshDb();
    const runner = startSchemaInferRunner({ db, intervalMs: 10 });

    addFact(db, 'f_tick', { pred: 'city', subject: 'home', value: 'hefei' });
    await new Promise((r) => setTimeout(r, 40));
    const runs = runner.state().runs;
    expect(runs).toBeGreaterThan(0);

    runner.stop();
    addFact(db, 'f_tick2', { pred: 'city', subject: 'home2', value: 'hefei' });
    await new Promise((r) => setTimeout(r, 40));
    expect(runner.state().runs).toBe(runs);
  });
});
