/**
 * P2-14 schema 校验 / 待晋升 / 快照 diff 单测（详设 §2.6 / §8.5；台账 P2-14）。
 *
 * 验收映射：
 * - 已登记键类型不符 → `E_SCHEMA`（写通路一条 SQL 都不发）；
 * - 未登记键放行，并在 ontology 落 promoted=0 的待晋升行（不建新表）；
 * - 合法的已登记写入行为不变；
 * - 快照 diff 分类正确且渲染确定。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MoshiError } from '../../src/domain/errors.js';
import type { FactAttrs } from '../../src/domain/types.js';
import {
  assertAttrsValid,
  buildSchemaSnapshot,
  diffSchemaSnapshots,
  parseSchemaSnapshot,
  renderSchemaMigration,
  validateAttrs,
  type RegisteredKeyDef,
} from '../../src/core/lifecycle/schema-validate.js';
import { upsertFact, type FactDraft } from '../../src/core/write/harvest.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { listOntologyKeys, loadRegisteredKeys } from '../../src/infra/sqlite/ontologyRepo.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-schema-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function attrs(predicate: string, value: unknown, ext: Record<string, unknown> = {}): FactAttrs {
  return {
    frozen: { subject: { entity_id: 'en_1', name: 'VS Code' }, predicate, value },
    ext,
  };
}

function draft(overrides: Partial<FactDraft> = {}): FactDraft {
  return {
    subject: 'VS Code',
    etype: 'concept',
    predicate: 'installed_version',
    value: '1.2.3',
    content: 'VS Code 已安装版本 1.2.3',
    confidence: 0.7,
    confidenceSource: 'tool_obs',
    ...overrides,
  };
}

function register(
  db: Db,
  kind: 'predicate' | 'attr_key',
  name: string,
  valueType: string | null,
  cardinality: string | null = null,
): void {
  db.prepare(
    `INSERT INTO ontology (kind, name, value_type, cardinality, sample_count, distinct_values, single_ratio, registered_at, promoted)
     VALUES (?, ?, ?, ?, 0, 0, NULL, '2026-01-01T00:00:00.000Z', 1)`,
  ).run(kind, name, valueType, cardinality);
}

function countRows(db: Db, table: 'fact' | 'entity'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('validateAttrs：已登记键约束（P2-14）', () => {
  it('已登记 predicate 类型不符 → error + E_SCHEMA', () => {
    const defs: RegisteredKeyDef[] = [
      { kind: 'predicate', name: 'installed_version', valueType: 'string', cardinality: 'single-valued' },
    ];
    const result = validateAttrs(attrs('installed_version', 42), defs);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { key: 'predicate:installed_version', expected: 'string', actual: 'number' },
    ]);

    let caught: unknown;
    try {
      assertAttrsValid(attrs('installed_version', 42), defs);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MoshiError);
    expect((caught as MoshiError).code).toBe('E_SCHEMA');
    expect((caught as MoshiError).detail?.['errors']).toEqual(result.errors);
  });

  it('已登记 attr_key 类型不符 → error', () => {
    const defs: RegisteredKeyDef[] = [
      { kind: 'attr_key', name: 'channel', valueType: 'string', cardinality: null },
    ];
    const result = validateAttrs(attrs('installed_version', '1.2.3', { channel: 7 }), defs);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ key: 'attr_key:channel', expected: 'string', actual: 'number' }]);
  });

  it('frozen 多出结构键 → falsy 结构错误（不静默放行）', () => {
    const bad = {
      frozen: {
        subject: { entity_id: 'en_1', name: 'VS Code' },
        predicate: 'installed_version',
        value: '1.2.3',
        extra: 'x',
      },
      ext: {},
    } as unknown as FactAttrs;
    const result = validateAttrs(bad, []);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.key).toBe('frozen');
  });

  it('草稿显式基数性与登记值冲突 → E_SCHEMA（写库前拦下，不留实体）', () => {
    const db = freshDb();
    register(db, 'predicate', 'installed_version', 'string', 'single-valued');
    const defs = loadRegisteredKeys(db);

    let caught: unknown;
    try {
      upsertFact(db, draft({ value: '2.0.0', cardinality: 'series' }), { schema: defs });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MoshiError);
    expect((caught as MoshiError).code).toBe('E_SCHEMA');
    expect(countRows(db, 'fact')).toBe(0);
    expect(countRows(db, 'entity')).toBe(0);
  });

  it('合法已登记写入行为不变（类型/基数性都对 → created）', () => {
    const db = freshDb();
    register(db, 'predicate', 'installed_version', 'string', 'single-valued');
    const result = upsertFact(db, draft(), { schema: loadRegisteredKeys(db) });
    expect(result.outcome).toBe('created');
    expect(countRows(db, 'fact')).toBe(1);
    // 已登记键不产生待晋升行
    expect(listOntologyKeys(db).filter((row) => !row.promoted)).toEqual([]);
  });
});

describe('未登记键放行并计入待晋升（P2-14）', () => {
  it('未登记 predicate / attr_key 放行，ontology 落 promoted=0 行', () => {
    const db = freshDb();
    const result = upsertFact(
      db,
      draft({ predicate: 'editor_theme', value: 'dark', ext: { workspace: 'moshi' } }),
      { schema: loadRegisteredKeys(db) },
    );
    expect(result.outcome).toBe('created');
    expect(countRows(db, 'fact')).toBe(1);

    expect(listOntologyKeys(db)).toEqual([
      {
        kind: 'attr_key',
        name: 'workspace',
        valueType: 'string',
        cardinality: null,
        sampleCount: 1,
        promoted: false,
      },
      {
        kind: 'predicate',
        name: 'editor_theme',
        valueType: 'string',
        cardinality: null,
        sampleCount: 1,
        promoted: false,
      },
    ]);
    // 待晋升不算已登记：下一次写入仍不受约束
    expect(loadRegisteredKeys(db)).toEqual([]);
  });

  it('重复观测同一未登记键 → sample_count 累加', () => {
    const db = freshDb();
    const defs = loadRegisteredKeys(db);
    upsertFact(db, draft({ predicate: 'editor_theme', value: 'dark' }), { schema: defs });
    upsertFact(db, draft({ predicate: 'editor_theme', value: 'dark' }), { schema: defs });
    const row = listOntologyKeys(db).find((r) => r.kind === 'predicate');
    expect(row?.sampleCount).toBe(2);
    expect(row?.promoted).toBe(false);
  });

  it('unregisteredKeys 给出排序后的键名，pendingEntries 推断类型', () => {
    const result = validateAttrs(attrs('editor_theme', 'dark', { workspace: 'moshi', zoom: 1.5 }), []);
    expect(result.ok).toBe(true);
    expect(result.unregisteredKeys).toEqual([
      'attr_key:workspace',
      'attr_key:zoom',
      'predicate:editor_theme',
    ]);
  });
});

describe('schema 快照与 diff（P2-14）', () => {
  it('added / removed / changed 分类正确且渲染脚本确定', () => {
    const before = buildSchemaSnapshot(
      [
        { kind: 'predicate', name: 'b', valueType: 'number', cardinality: 'series' },
        { kind: 'predicate', name: 'a', valueType: 'string', cardinality: null },
      ],
      '2026-01-01T00:00:00.000Z',
    );
    const after = buildSchemaSnapshot(
      [
        { kind: 'predicate', name: 'a', valueType: 'number', cardinality: null },
        { kind: 'predicate', name: 'c', valueType: 'bool', cardinality: 'set' },
      ],
      '2026-01-02T00:00:00.000Z',
    );

    const diff = diffSchemaSnapshots(before, after);
    expect(diff.added.map((e) => e.name)).toEqual(['c']);
    expect(diff.removed.map((e) => e.name)).toEqual(['b']);
    expect(diff.changed).toEqual([
      {
        kind: 'predicate',
        name: 'a',
        field: 'value_type',
        before: 'string',
        after: 'number',
      },
    ]);
    expect(diff.unchanged).toBe(0);

    const listed = renderSchemaMigration(diff, '2026-01-03T00:00:00.000Z');
    expect(listed).toBe(renderSchemaMigration(diff, '2026-01-03T00:00:00.000Z'));
    expect(listed).toContain('INSERT INTO ontology');
    expect(listed).toContain("UPDATE ontology SET value_type = 'number'");
    expect(listed).toContain('DELETE FROM ontology');
    expect(listed).not.toContain('PRAGMA');
  });

  it('快照可往返解析，坏格式抛 E_INPUT', () => {
    const snapshot = buildSchemaSnapshot(
      [{ kind: 'attr_key', name: 'channel', valueType: 'string', cardinality: null }],
      '2026-01-01T00:00:00.000Z',
    );
    expect(parseSchemaSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);

    expect(() => parseSchemaSnapshot('{bad json')).toThrow(MoshiError);
    expect(() => parseSchemaSnapshot('{"schema":"other/1","entries":[]}')).toThrow(MoshiError);
    expect(() =>
      parseSchemaSnapshot('{"schema":"moshi-schema/1","entries":[{"kind":"x","name":"y"}]}'),
    ).toThrow(MoshiError);
  });

  it('当前库已登记 schema 快照只含 promoted=1 行', () => {
    const db = freshDb();
    register(db, 'predicate', 'installed_version', 'string', 'single-valued');
    upsertFact(db, draft({ predicate: 'editor_theme', value: 'dark' }), {
      schema: loadRegisteredKeys(db),
    });
    const snapshot = buildSchemaSnapshot(
      loadRegisteredKeys(db).map((key) => ({
        kind: key.kind,
        name: key.name,
        valueType: key.valueType,
        cardinality: key.cardinality,
      })),
      '2026-01-01T00:00:00.000Z',
    );
    expect(snapshot.entries.map((e) => e.name)).toEqual(['installed_version']);
  });
});
