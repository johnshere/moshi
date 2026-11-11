/**
 * V-05：Fact 语义分层（迁移 006 + 字段读写 + 删除 fs.ls）。
 *
 * 迁移不只在空库上验：先用 `target: 5` 造一个 v5 带数据的库，再升到 6，
 * 断言旧行不丢、新列取默认值、触发器/视图/索引都重建。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { parseTurn } from '../../src/core/parse/registry.js';
import { insertFact } from '../fixtures/factories.js';
import type { Ftype } from '../../src/domain/enums.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-semantics-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  opened.push(db);
  return { db, dir };
}

function masterNames(db: Db, type: string): string[] {
  return db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .pluck()
    .all(type) as string[];
}

const V5_FACT_SQL =
  "INSERT INTO fact (id, content, ftype, confidence, confidence_source, strength, importance, pool, epistemic_status, attrs, canonical_key, value_hash, scope, valid_at, recorded_at, last_decay_at, created_at, updated_at) " +
  `VALUES ('f_old','v5 旧行','episodic',0.9,'tool_obs',0.5,0.5,'utility','active','{"frozen":{"subject":{"entity_id":"en_old","name":"old"},"predicate":"state","value":"x"},"ext":{}}','ck_old','vh_old','global','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`;

describe('迁移 006：ftype 扩值 + 七个正交字段', () => {
  it('v5 带数据的库升到 v6：旧行保留，新列取默认值', () => {
    const { db, dir } = tempDb();
    const backups = path.join(dir, 'backups');
    const v5 = migrate(db, { backupsDir: backups, target: 5 });
    expect(v5.to).toBe(5);
    db.exec(V5_FACT_SQL);

    const v6 = migrate(db, { backupsDir: backups, target: 6 });
    expect(v6.from).toBe(5);
    expect(v6.applied).toEqual(['006_fact_semantics.sql']);
    expect(db.pragma('user_version', { simple: true })).toBe(6);

    const old = factRepo.getFact(db, 'f_old');
    expect(old).not.toBeNull();
    expect(old!.content).toBe('v5 旧行');
    expect(old!.retentionClass).toBeNull();
    expect(old!.volatility).toBeNull();
    expect(old!.admissionReason).toBeNull();
    expect(old!.ttlSeconds).toBeNull();
    expect(old!.sourceKind).toBe('observation');
    expect(old!.recheckKind).toBe('none');
    expect(old!.expiredAt).toBeNull();
  });

  it('重建后索引、触发器、视图都在（外键子表的 trg_degree_* 未被误删）', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups') });

    const indexes = masterNames(db, 'index');
    expect(indexes).toContain('idx_fact_retention');
    expect(indexes).toContain('idx_fact_expires');
    expect(indexes).toContain('idx_fact_identity');

    const triggers = masterNames(db, 'trigger');
    for (const t of [
      'trg_fact_content_immutable',
      'trg_fact_frozen_immutable',
      'trg_rev_fact_ins',
      'trg_rev_fact_upd',
      'trg_rev_fact_del',
      'trg_degree_ins',
    ]) {
      expect(triggers).toContain(t);
    }

    const views = masterNames(db, 'view');
    for (const v of ['v_fact_degree', 'v_active_fact', 'v_orphan_ratio']) {
      expect(views).toContain(v);
    }
  });

  it('ftype 四值与七个字段可写可读', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups') });

    const cases: Array<{ ftype: Ftype; retentionClass: string; volatility: string; admissionReason: string }> = [
      { ftype: 'semantic', retentionClass: 'durable', volatility: 'static', admissionReason: 'non_rederivable' },
      { ftype: 'episodic', retentionClass: 'event', volatility: 'historical', admissionReason: 'expensive' },
      { ftype: 'procedural', retentionClass: 'session', volatility: 'slow', admissionReason: 'context_needed' },
      { ftype: 'conditional', retentionClass: 'cache', volatility: 'volatile', admissionReason: 'human_intent' },
    ];
    for (const c of cases) {
      const id = insertFact(db, {
        ftype: c.ftype,
        retentionClass: c.retentionClass,
        volatility: c.volatility,
        admissionReason: c.admissionReason,
        ttlSeconds: 3600,
        sourceKind: 'decision',
        recheckKind: 'manual',
        expiredAt: '2026-10-01T00:00:00.000Z',
      });
      const f = factRepo.getFact(db, id);
      expect(f).not.toBeNull();
      expect(f!.ftype).toBe(c.ftype);
      expect(f!.retentionClass).toBe(c.retentionClass);
      expect(f!.volatility).toBe(c.volatility);
      expect(f!.admissionReason).toBe(c.admissionReason);
      expect(f!.ttlSeconds).toBe(3600);
      expect(f!.sourceKind).toBe('decision');
      expect(f!.recheckKind).toBe('manual');
      expect(f!.expiredAt).toBe('2026-10-01T00:00:00.000Z');
    }
  });

  it('CHECK 拒绝未知 ftype 与未知 retention_class', () => {
    const { db, dir } = tempDb();
    migrate(db, { backupsDir: path.join(dir, 'backups') });

    expect(() => insertFact(db, { ftype: 'wisdom' })).toThrow();
    expect(() => insertFact(db, { retentionClass: 'forever' })).toThrow();
  });
});

describe('fs.ls 删除（V-05）', () => {
  it('ls -l 不再产出任何事实', () => {
    const r = parseTurn({
      tool: 'Bash',
      cmd: 'ls -l',
      output: '-rw-r--r--  1 john staff  1234 Oct  1 10:00 package.json\n',
      exitCode: 0,
    });
    expect(r.facts).toEqual([]);
    expect(r.produced).not.toContain('fs.ls');
    expect(r.unparsed).toBe(true);
  });
});
