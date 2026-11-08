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
  /** V-05 分层字段；不传走 DDL 默认值（source_kind=observation / recheck_kind=none） */
  retentionClass?: string | null;
  volatility?: string | null;
  admissionReason?: string | null;
  ttlSeconds?: number | null;
  sourceKind?: string;
  recheckKind?: string;
  expiredAt?: string | null;
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
  /** 惰性衰减的起点；不传即「刚刚」（dt ≈ 0，强度不动）。P2-08 的强度用例靠它造历史 */
  lastDecayAt?: string;
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
       id, content, ftype, retention_class, volatility, admission_reason, ttl_seconds,
       source_kind, recheck_kind, expired_at,
       confidence, confidence_source, strength, importance, pool,
       epistemic_status, attrs, canonical_key, value_hash, scope, superseded_by,
       valid_at, valid_to, recorded_at, community_id, degree, access_count,
       last_access_at, last_decay_at, source_episode, span_start, span_end,
       created_at, updated_at
     ) VALUES (
       @id, @content, @ftype, @retention_class, @volatility, @admission_reason, @ttl_seconds,
       COALESCE(@source_kind, 'observation'), COALESCE(@recheck_kind, 'none'), @expired_at,
       @confidence, @confidence_source, @strength, @importance, @pool,
       @epistemic_status, @attrs, @canonical_key, @value_hash, @scope, @superseded_by,
       @valid_at, @valid_to, @recorded_at, NULL, 0, 0,
       NULL, @last_decay_at, NULL, NULL, NULL,
       @created_at, @updated_at
     )`,
  ).run({
    id,
    content: seed.content ?? `${subject.name} ${predicate} = ${String(value)}`,
    ftype: seed.ftype ?? 'semantic',
    retention_class: seed.retentionClass ?? null,
    volatility: seed.volatility ?? null,
    admission_reason: seed.admissionReason ?? null,
    ttl_seconds: seed.ttlSeconds ?? null,
    source_kind: seed.sourceKind ?? null,
    recheck_kind: seed.recheckKind ?? null,
    expired_at: seed.expiredAt ?? null,
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
    last_decay_at: seed.lastDecayAt ?? ts,
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

export interface DerivedPointSeed {
  id?: string;
  fingerprint?: string;
  validTo?: string | null;
  epistemicStatus?: string;
  supersededBy?: string | null;
}

/**
 * 造一条「已提炼要点」：semantic + `confidence_source='derived'` + 到源的
 * `derived_from` 边。只给测试用；真实产出走 `core/lifecycle/consolidate.ts`。
 */
export function insertDerivedPoint(
  db: Db,
  sourceIds: readonly string[],
  seed: DerivedPointSeed = {},
): string {
  const firstId = sourceIds[0];
  if (firstId === undefined) throw new Error('insertDerivedPoint: sourceIds 不能为空');
  const src = db
    .prepare('SELECT canonical_key, scope FROM fact WHERE id = ?')
    .get(firstId) as { canonical_key: string; scope: string };
  const id = seed.id ?? newId('fact');
  const fingerprint = seed.fingerprint ?? `fp_${id}`;
  insertFact(db, {
    id,
    ftype: 'semantic',
    confidenceSource: 'derived',
    canonicalKey: src.canonical_key,
    scope: src.scope,
    valueHash: valueHash(`derived:${id}`),
    ext: { derived_from: fingerprint },
    validTo: seed.validTo ?? null,
    epistemicStatus: seed.epistemicStatus ?? 'active',
    supersededBy: seed.supersededBy ?? null,
  });
  for (const sourceId of sourceIds) insertEdge(db, id, sourceId, 'derived_from');
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
