/**
 * 实体合并（P2-19A-09）核心契约测试。
 *
 * 钉住四件事：
 * ① 合并不能碰 `attrs.frozen`（I2 不可变），事实改判只重算 `canonical_key`；
 * ② 完全重复的事实按生命周期收口（valid_to + superseded_by），不物理删除；
 * ③ 冲突（同谓词不同 value_hash）只列出不裁决；
 * ④ 合并可幂等重放、不可撤销、会 bump community_rev。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalKey } from '../../src/domain/hash.js';
import { MoshiError } from '../../src/domain/errors.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { auditByRow } from '../../src/infra/sqlite/auditRepo.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import { getMeta } from '../../src/infra/sqlite/metaRepo.js';
import { makeEntity, insertFact } from '../fixtures/factories.js';
import { mergeEntities, previewEntityMerge } from '../../src/core/write/entity-merge.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-entity-merge-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

interface Fixture {
  db: Db;
  fromId: string;
  toId: string;
  fromFacts: { version: string; port: string; arch: string };
  toFacts: { version: string; port: string; runtime: string };
}

function seed(): Fixture {
  const db = freshDb();
  const fromId = makeEntity(db, 'node', 'pkg');
  const toId = makeEntity(db, 'nodejs', 'pkg');
  const fromFacts = {
    version: insertFact(db, {
      subject: { entity_id: fromId, name: 'node' },
      predicate: 'version',
      value: '22.0.0',
      content: 'node version = 22.0.0',
    }),
    port: insertFact(db, {
      subject: { entity_id: fromId, name: 'node' },
      predicate: 'port',
      value: 8080,
      content: 'node port = 8080',
    }),
    arch: insertFact(db, {
      subject: { entity_id: fromId, name: 'node' },
      predicate: 'arch',
      value: 'x64',
      content: 'node arch = x64',
    }),
  };
  const toFacts = {
    version: insertFact(db, {
      subject: { entity_id: toId, name: 'nodejs' },
      predicate: 'version',
      value: '22.0.0',
      content: 'nodejs version = 22.0.0',
    }),
    port: insertFact(db, {
      subject: { entity_id: toId, name: 'nodejs' },
      predicate: 'port',
      value: 9090,
      content: 'nodejs port = 9090',
    }),
    runtime: insertFact(db, {
      subject: { entity_id: toId, name: 'nodejs' },
      predicate: 'runtime',
      value: 'v8',
      content: 'nodejs runtime = v8',
    }),
  };
  entityRepo.addAlias(db, { alias: 'node-bin', entityId: fromId, source: 'rule' });
  entityRepo.addAlias(db, { alias: 'nodejs', entityId: toId, source: 'rule' });
  return { db, fromId, toId, fromFacts, toFacts };
}

function expectMoshi(fn: () => unknown, code: string, reason: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MoshiError);
    const e = err as MoshiError;
    expect(e.code).toBe(code);
    expect((e.detail as { reason?: string } | undefined)?.reason).toBe(reason);
    return;
  }
  throw new Error(`expected MoshiError ${code}/${reason}, but no error was thrown`);
}

describe('previewEntityMerge', () => {
  it('列出冲突、将移动计数，并给出可合并结论', () => {
    const { db, fromId, toId } = seed();
    const preview = previewEntityMerge(db, { fromId, toId });
    expect(preview.can_merge).toBe(true);
    expect(preview.blocking_reason).toBeUndefined();
    expect(preview.from.fact_count).toBe(3);
    expect(preview.to.fact_count).toBe(3);
    expect(preview.will_move).toEqual({ facts: 3, edges: 0, aliases: 1 });
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0]?.predicate).toBe('port');
    expect(preview.conflicts[0]?.from.value).toBe(8080);
    expect(preview.conflicts[0]?.to.value).toBe(9090);
  });

  it('同 id、etype 不同、实体不存在分别给出 400/400/404', () => {
    const { db, fromId, toId } = seed();
    expectMoshi(() => previewEntityMerge(db, { fromId, toId: fromId }), 'E_INPUT', 'same_entity');

    const otherType = makeEntity(db, 'python', 'service');
    expectMoshi(
      () => previewEntityMerge(db, { fromId, toId: otherType }),
      'E_INPUT',
      'etype_mismatch',
    );
    expectMoshi(
      () => previewEntityMerge(db, { fromId, toId: 'entity-does-not-exist' }),
      'E_NOT_FOUND',
      'entity_not_found',
    );
    expect(toId).toBeTruthy();
  });
});

describe('mergeEntities', () => {
  it('重算 canonical_key、别名改指、dedupe 完全重复，且不碰 frozen', () => {
    const { db, fromId, toId, fromFacts, toFacts } = seed();
    const beforeFrozen = db
      .prepare('SELECT attrs FROM fact WHERE id = ?')
      .get(fromFacts.version) as { attrs: string };

    const result = mergeEntities(db, { fromId, toId });

    expect(result.ok).toBe(true);
    expect(result.moved_facts).toBe(2);
    expect(result.deduped_facts).toBe(1);
    expect(result.moved_edges).toBe(0);
    expect(result.merged_aliases).toBe(1);
    expect(result.conflicts_resolved).toBe(0);
    expect(result.undoable).toBe(false);

    // loser 行保留，只写 merged_into
    const loser = entityRepo.getEntity(db, fromId);
    expect(loser).not.toBeNull();
    expect(loser?.mergedInto).toBe(toId);

    // frozen 未动（I2）
    const afterFrozen = db
      .prepare('SELECT attrs FROM fact WHERE id = ?')
      .get(fromFacts.version) as { attrs: string };
    expect(afterFrozen.attrs).toBe(beforeFrozen.attrs);

    // 非重复事实的 canonical_key 按 winner 重算
    const movedPort = db
      .prepare('SELECT canonical_key FROM fact WHERE id = ?')
      .get(fromFacts.port) as { canonical_key: string };
    expect(movedPort.canonical_key).toBe(canonicalKey('global', toId, 'port'));
    const movedArch = db
      .prepare('SELECT canonical_key FROM fact WHERE id = ?')
      .get(fromFacts.arch) as { canonical_key: string };
    expect(movedArch.canonical_key).toBe(canonicalKey('global', toId, 'arch'));

    // 完全重复：loser 行收口，winner 行保留
    const dup = db
      .prepare('SELECT valid_to, superseded_by FROM fact WHERE id = ?')
      .get(fromFacts.version) as { valid_to: string | null; superseded_by: string | null };
    expect(dup.valid_to).not.toBeNull();
    expect(dup.superseded_by).toBe(toFacts.version);
    const winner = db
      .prepare('SELECT valid_to FROM fact WHERE id = ?')
      .get(toFacts.version) as { valid_to: string | null };
    expect(winner.valid_to).toBeNull();

    // 唯一索引不冲突：winner 侧同 key+value 只有一条活跃行
    const activeDup = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fact
          WHERE canonical_key = ? AND value_hash = ? AND valid_to IS NULL`,
      )
      .get(canonicalKey('global', toId, 'version'), (
        db.prepare('SELECT value_hash FROM fact WHERE id = ?').get(toFacts.version) as {
          value_hash: string;
        }
      ).value_hash) as { n: number };
    expect(activeDup.n).toBe(1);

    // 别名改指
    expect(entityRepo.aliasesOf(db, fromId)).toHaveLength(0);
    expect(entityRepo.aliasesOf(db, toId).map((a) => a.alias).sort()).toEqual([
      'node-bin',
      'nodejs',
    ]);

    // audit：field=merge / reason=entity.merge
    const audits = auditByRow(db, 'entity', fromId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.field).toBe('merge');
    expect(audits[0]?.reason).toBe('entity.merge');
    const after = JSON.parse(audits[0]?.afterJson ?? '{}') as Record<string, unknown>;
    expect(after['to']).toBe(toId);
    expect(after['deduped_facts']).toBe(1);

    // 社区需重算
    expect(Number(getMeta(db, 'community_rev'))).toBe(1);
  });

  it('列表按归并根汇总事实数，loser 不再作为独立实体出现', () => {
    const { db, fromId, toId } = seed();
    mergeEntities(db, { fromId, toId });
    const rows = entityRepo.listEntitiesAggregated(db, 'node');
    const winner = rows.find((r) => r.entity_id === toId);
    expect(winner).toBeDefined();
    expect(winner?.fact_count).toBe(5);
    expect(rows.some((r) => r.entity_id === fromId)).toBe(false);
  });

  it('重复合并幂等：第二次 moved 全为 0，不重复审计', () => {
    const { db, fromId, toId } = seed();
    mergeEntities(db, { fromId, toId });
    const again = mergeEntities(db, { fromId, toId });
    expect(again.moved_facts).toBe(0);
    expect(again.deduped_facts).toBe(0);
    expect(again.merged_aliases).toBe(0);
    expect(auditByRow(db, 'entity', fromId)).toHaveLength(1);

    const preview = previewEntityMerge(db, { fromId, toId });
    expect(preview.can_merge).toBe(false);
    expect(preview.blocking_reason).toBe('already_merged');
  });

  it('已合并到别处时拒绝重放到不同目标', () => {
    const { db, fromId, toId } = seed();
    const third = makeEntity(db, 'node-other', 'pkg');
    mergeEntities(db, { fromId, toId });
    expectMoshi(
      () => mergeEntities(db, { fromId, toId: third }),
      'E_CONFLICT_IDENTITY',
      'already_merged',
    );
    expectMoshi(
      () => mergeEntities(db, { fromId: third, toId: fromId }),
      'E_CONFLICT_IDENTITY',
      'already_merged',
    );
  });
});
