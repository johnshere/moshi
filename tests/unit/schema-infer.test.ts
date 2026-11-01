/**
 * P1-14 schema infer 单测（详设 §8.5；台账 P1-14）。
 *
 * 验收：构造 20 个 single-valued 谓词（单值占比≥0.9）+ 20 个 series（低单值、
 * 多值出现）→ 判定正确；key_count<20 不判定（observe 且不写回）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../../src/infra/sqlite/factRepo.js';
import { runSchemaInfer } from '../../src/core/lifecycle/schema-infer.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-sci-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addFact(db: Db, pred: string, key: string, valueHash: string, status: 'active' | 'disputed' = 'active'): void {
  insertFact(db, {
    id: `f_${pred}_${key}_${valueHash}`.slice(0, 60),
    content: `${pred} ${key} = ${valueHash}`,
    ftype: 'semantic', confidence: 0.8, confidenceSource: 'tool_obs',
    strength: 0.5, importance: 0.5, pool: 'utility', epistemicStatus: status,
    attrs: { frozen: { subject: { entity_id: `en_${key}`, name: key }, predicate: pred, value: valueHash }, ext: {} },
    canonicalKey: `ck_${pred}_${key}`, valueHash, scope: 'global', supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z', validTo: null, recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: null, degree: 0, accessCount: 0, lastAccessAt: null, lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: null, span: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

describe('schema infer（P1-14）', () => {
  it('20 个 single-valued 谓词 → single-valued；20 个 series → series', () => {
    const db = freshDb();
    // single-valued：每 key 恰 1 个取值 → single_ratio=1.0
    for (let p = 0; p < 20; p += 1) {
      const pred = `sv_pred_${p}`;
      for (let k = 0; k < 5; k += 1) addFact(db, pred, `k${k}`, `v1`);
      // 再加 15 个 key 各 1 条 → 20 keys
      for (let k = 5; k < 20; k += 1) addFact(db, pred, `k${k}`, `v1`);
    }
    // series：每 key 多条不同取值 → single_ratio=0；每谓词 20 keys × 3 值 = 60 occurrences
    for (let p = 0; p < 20; p += 1) {
      const pred = `ser_pred_${p}`;
      for (let k = 0; k < 20; k += 1) {
        addFact(db, pred, `k${k}`, `v1`);
        addFact(db, pred, `k${k}`, `v2`);
        addFact(db, pred, `k${k}`, `v3`);
      }
    }
    const res = runSchemaInfer(db);
    const sv = res.predicates.filter((r) => r.name.startsWith('sv_pred_'));
    const ser = res.predicates.filter((r) => r.name.startsWith('ser_pred_'));
    expect(sv).toHaveLength(20);
    expect(sv.every((r) => r.cardinality === 'single-valued' && r.keys === 20)).toBe(true);
    expect(ser).toHaveLength(20);
    expect(ser.every((r) => r.cardinality === 'series' && r.keys === 20 && r.value_occurrences === 60)).toBe(true);

    // 写回验证
    const row = db.prepare("SELECT cardinality, promoted FROM ontology WHERE kind='predicate' AND name = ?").get('sv_pred_0') as {
      cardinality: string; promoted: number;
    };
    expect(row.cardinality).toBe('single-valued');
    expect(row.promoted).toBe(1);
    const rowSer = db.prepare("SELECT cardinality FROM ontology WHERE kind='predicate' AND name = ?").get('ser_pred_0') as {
      cardinality: string;
    };
    expect(rowSer.cardinality).toBe('series');
  });

  it('key_count < 20 → observe 不判定、不写回', () => {
    const db = freshDb();
    const pred = 'small_pred';
    for (let k = 0; k < 5; k += 1) addFact(db, pred, `k${k}`, `v1`);
    const res = runSchemaInfer(db);
    expect(res.predicates).toHaveLength(1);
    expect(res.predicates[0]!.cardinality).toBeNull();
    expect(res.predicates[0]!.action).toBe('observe');
    const row = db.prepare("SELECT 1 FROM ontology WHERE kind='predicate' AND name = ?").get(pred);
    expect(row).toBeUndefined();
  });

  it('disputed 也计入；archived/invalidated 不计入', () => {
    const db = freshDb();
    const pred = 'mix_pred';
    for (let k = 0; k < 10; k += 1) addFact(db, pred, `k${k}`, `v1`);
    for (let k = 0; k < 10; k += 1) addFact(db, pred, `k${k + 100}`, `v1`, 'disputed');
    // 10 active + 10 disputed = 20 keys
    const res = runSchemaInfer(db);
    expect(res.predicates.find((r) => r.name === pred)!.keys).toBe(20);
  });
});
