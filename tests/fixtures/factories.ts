/**
 * 测试夹具：直接写库的最小合法行。
 *
 * 这些工厂**绕过仓储层**，故意如此——触发器与约束是数据库层的最后防线，
 * 用仓储层测等于"用被测对象证明被测对象"。
 */
import { canonicalKey, valueHash } from '../../src/domain/hash.js';
import { newId } from '../../src/domain/ids.js';
import { nowIso } from '../../src/domain/time.js';
import type { Db } from '../../src/infra/sqlite/db.js';

export interface FactSeed {
  id?: string;
  content?: string;
  ftype?: string;
  confidence?: number;
  confidenceSource?: string;
  strength?: number;
  importance?: number;
  pool?: string;
  epistemicStatus?: string;
  subject?: { entity_id: string; name: string };
  predicate?: string;
  value?: unknown;
  ext?: Record<string, unknown>;
  scope?: string;
  canonicalKey?: string;
  valueHash?: string;
  validAt?: string;
  validTo?: string | null;
  supersededBy?: string | null;
}

export function makeEntity(db: Db, name: string, etype = 'pkg'): string {
  const id = newId('entity');
  db.prepare(
    `INSERT INTO entity (id, canonical_name, etype, scope, alias_count, first_seen_at)
     VALUES (?, ?, ?, 'global', 0, ?)`,
  ).run(id, name, etype, nowIso());
  return id;
}

export function insertFact(db: Db, seed: FactSeed = {}): string {
  const id = seed.id ?? newId('fact');
  const ts = nowIso();
  const subject = seed.subject ?? { entity_id: makeEntity(db, `pkg-${id}`), name: 'node' };
  const predicate = seed.predicate ?? 'version';
  const value = seed.value ?? '22.0.0';
  const scope = seed.scope ?? 'global';
  const attrs = JSON.stringify({ frozen: { subject, predicate, value }, ext: seed.ext ?? {} });

  db.prepare(
    `INSERT INTO fact (
       id, content, ftype, confidence, confidence_source, strength, importance, pool,
       epistemic_status, attrs, canonical_key, value_hash, scope, superseded_by,
       valid_at, valid_to, recorded_at, community_id, degree, access_count,
       last_access_at, last_decay_at, source_episode, span_start, span_end,
       created_at, updated_at
     ) VALUES (
       @id, @content, @ftype, @confidence, @confidence_source, @strength, @importance, @pool,
       @epistemic_status, @attrs, @canonical_key, @value_hash, @scope, @superseded_by,
       @valid_at, @valid_to, @recorded_at, NULL, 0, 0,
       NULL, @last_decay_at, NULL, NULL, NULL,
       @created_at, @updated_at
     )`,
  ).run({
    id,
    content: seed.content ?? `${subject.name} ${predicate} = ${String(value)}`,
    ftype: seed.ftype ?? 'semantic',
    confidence: seed.confidence ?? 0.9,
    confidence_source: seed.confidenceSource ?? 'tool_obs',
    strength: seed.strength ?? 0.5,
    importance: seed.importance ?? 0.5,
    pool: seed.pool ?? 'utility',
    epistemic_status: seed.epistemicStatus ?? 'active',
    attrs,
    canonical_key: seed.canonicalKey ?? canonicalKey(scope, subject.entity_id, predicate),
    value_hash: seed.valueHash ?? valueHash(value),
    scope,
    superseded_by: seed.supersededBy ?? null,
    valid_at: seed.validAt ?? ts,
    valid_to: seed.validTo ?? null,
    recorded_at: ts,
    last_decay_at: ts,
    created_at: ts,
    updated_at: ts,
  });
  return id;
}

export function insertEdge(
  db: Db,
  src: string,
  dst: string,
  etype = 'depends_on',
  validTo: string | null = null,
): string {
  const id = newId('edge');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
     VALUES (?, ?, ?, ?, 1.0, 0.9, ?, ?, ?)`,
  ).run(id, src, dst, etype, ts, validTo, ts);
  return id;
}

export function degreeOf(db: Db, factId: string): number {
  const row = db.prepare('SELECT degree FROM fact WHERE id = ?').get(factId) as
    | { degree: number }
    | undefined;
  return row?.degree ?? -1;
}

export function schemaRev(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_rev'").get() as {
    value: string;
  };
  return Number(row.value);
}
