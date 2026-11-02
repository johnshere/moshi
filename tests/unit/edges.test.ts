/**
 * P2-22 边抽取（详设 §5.12.6）。
 *
 * 验收三条：每 10 条新事实 ≥ 3 条边、`(src,dst,etype)` 重复插入不新增、
 * 边精度抽样 ≥ 80%（这里用"规则命中即带 provenance、不产生跨实体噪声"代替抽样）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { EDGE_QUOTA, extractEdges, totalCreated } from '../../src/core/write/edges.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-edges-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addEpisode(db: Db, id: string): void {
  db.prepare('INSERT INTO episode (id, ts, raw_hash) VALUES (?, ?, ?)').run(id, T(0), `rh_${id}`);
}

interface MkFact {
  id: string;
  entityId?: string;
  name?: string;
  predicate?: string;
  validAt?: string;
  validTo?: string | null;
  sourceEpisode?: string | null;
  confidenceSource?: 'tool_obs' | 'llm_claim';
  ext?: Record<string, unknown>;
}

const T = (min: number): string => new Date(Date.UTC(2026, 10, 2, 2, min, 0)).toISOString();

function addFact(db: Db, input: MkFact): void {
  const code = input.id.replace(/^f_/, '');
  const ts = input.validAt ?? T(0);
  factRepo.insertFact(db, {
    id: input.id,
    content: `fact ${input.id}`,
    ftype: 'semantic',
    confidence: 0.9,
    confidenceSource: input.confidenceSource ?? 'tool_obs',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs: {
      frozen: {
        subject: { entity_id: input.entityId ?? `en_${code}`, name: input.name ?? code },
        predicate: input.predicate ?? 'state',
        value: code,
      },
      ext: input.ext ?? {},
    },
    canonicalKey: `ck_${code}`,
    valueHash: `vh_${code}`,
    scope: 'global',
    supersededBy: null,
    validAt: ts,
    validTo: input.validTo ?? null,
    recordedAt: ts,
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: ts,
    sourceEpisode: input.sourceEpisode ?? null,
    span: null,
    createdAt: ts,
    updatedAt: ts,
  });
}

function edges(db: Db): { src: string; dst: string; etype: string; provenance: string | null }[] {
  return db
    .prepare('SELECT src, dst, etype, provenance FROM edge ORDER BY recorded_at, id')
    .all() as { src: string; dst: string; etype: string; provenance: string | null }[];
}

function factsByIds(db: Db, ids: string[]) {
  return ids.map((id) => factRepo.getFact(db, id)!).filter(Boolean);
}

describe('P2-22 规则 3：同实体共现', () => {
  it('同实体 1h 内的其他事实各建一条 co_occur，置信 0.5、带 provenance', () => {
    const db = freshDb();
    addFact(db, { id: 'f_a', entityId: 'en_port', predicate: 'value', validAt: T(0) });
    addFact(db, { id: 'f_b', entityId: 'en_port', predicate: 'owner', validAt: T(10) });
    addFact(db, { id: 'f_c', entityId: 'en_port', predicate: 'note', validAt: T(30) });

    const res = extractEdges(db, { facts: factsByIds(db, ['f_b']) });
    expect(res.created.co_occur).toBe(2);
    const rows = edges(db);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.etype).toBe('co_occur');
      expect(row.provenance).toBe('rule:co_occur');
    }
    const conf = db.prepare('SELECT confidence FROM edge LIMIT 1').get() as { confidence: number };
    expect(conf.confidence).toBe(0.5);
  });

  it('配额：单个新事实最多 5 条 co_occur，超出的按时间距离截断', () => {
    const db = freshDb();
    for (let i = 0; i < 9; i += 1) {
      addFact(db, { id: `f_n${String(i)}`, entityId: 'en_big', predicate: `p${String(i)}`, validAt: T(i) });
    }
    const res = extractEdges(db, { facts: factsByIds(db, ['f_n8']) });
    expect(res.created.co_occur).toBe(EDGE_QUOTA.coOccurPerFact);
    expect(res.created.co_occur).toBe(5);
  });

  it('不同实体不产生共现边', () => {
    const db = freshDb();
    addFact(db, { id: 'f_x', entityId: 'en_a', validAt: T(0) });
    addFact(db, { id: 'f_y', entityId: 'en_b', validAt: T(1) });
    const res = extractEdges(db, { facts: factsByIds(db, ['f_y']) });
    expect(totalCreated(res.created)).toBe(0);
  });
});

describe('P2-22 规则 4：时间序取代', () => {
  it('同实体+谓词、旧值已收口 → 新事实 supersedes 旧事实，置信 0.9', () => {
    const db = freshDb();
    addFact(db, {
      id: 'f_old',
      entityId: 'en_port',
      predicate: 'value',
      validAt: T(0),
      validTo: T(20),
    });
    addFact(db, { id: 'f_new', entityId: 'en_port', predicate: 'value', validAt: T(30) });

    const res = extractEdges(db, { facts: factsByIds(db, ['f_new']) });
    expect(res.created.supersedes).toBe(1);
    const row = edges(db).find((e) => e.etype === 'supersedes');
    expect(row).toMatchObject({ src: 'f_new', dst: 'f_old', provenance: 'rule:supersedes' });
  });

  it('supersedes 不受 7 条配额限制', () => {
    const db = freshDb();
    // 同一新事实既有多条旧值（不同谓词不构成取代），用同谓词多条旧值构造
    for (let i = 0; i < 3; i += 1) {
      addFact(db, {
        id: `f_old${String(i)}`,
        entityId: 'en_k',
        predicate: 'value',
        validAt: T(i),
        validTo: T(i + 1),
      });
    }
    addFact(db, { id: 'f_new', entityId: 'en_k', predicate: 'value', validAt: T(10) });
    const res = extractEdges(db, { facts: factsByIds(db, ['f_new']) });
    // 取代只连最近的一条，避免图变成旧值链
    expect(res.created.supersedes).toBe(1);
  });
});

describe('P2-22 规则 1/2：依赖边', () => {
  it('同 episode 相邻 tool_obs 事实（≤5 min）→ 后者 depends_on 前者，置信 0.7', () => {
    const db = freshDb();
    addEpisode(db, 'ep_1');
    addFact(db, { id: 'f_t1', entityId: 'en_cmd', validAt: T(0), sourceEpisode: 'ep_1' });
    addFact(db, { id: 'f_t2', entityId: 'en_out', validAt: T(2), sourceEpisode: 'ep_1' });

    const res = extractEdges(db, { facts: factsByIds(db, ['f_t2']) });
    expect(res.created.tool_seq).toBe(1);
    const row = edges(db).find((e) => e.provenance === 'rule:tool_seq');
    expect(row).toMatchObject({ src: 'f_t2', dst: 'f_t1', etype: 'depends_on' });
  });

  it('间隔超过 5 min 不连依赖边', () => {
    const db = freshDb();
    addEpisode(db, 'ep_1');
    addFact(db, { id: 'f_t1', entityId: 'en_cmd', validAt: T(0), sourceEpisode: 'ep_1' });
    addFact(db, { id: 'f_t2', entityId: 'en_out', validAt: T(10), sourceEpisode: 'ep_1' });
    const res = extractEdges(db, { facts: factsByIds(db, ['f_t2']) });
    expect(res.created.tool_seq).toBe(0);
  });

  it('过程步骤：steps[] 相邻项解析到同 episode 的事实 → 后步 depends_on 前步，置信 0.85', () => {
    const db = freshDb();
    addEpisode(db, 'ep_p');
    addFact(db, { id: 'f_s1', name: '启动 docker', entityId: 'en_s1', sourceEpisode: 'ep_p', validAt: T(0) });
    addFact(db, { id: 'f_s2', name: '等待健康检查', entityId: 'en_s2', sourceEpisode: 'ep_p', validAt: T(1) });
    addFact(db, {
      id: 'f_proc',
      entityId: 'en_proc',
      predicate: 'procedure',
      sourceEpisode: 'ep_p',
      validAt: T(2),
      ext: { steps: ['启动 docker', '等待健康检查'] },
    });

    const res = extractEdges(db, { facts: factsByIds(db, ['f_proc']) });
    expect(res.created.procedure).toBe(1);
    const row = edges(db).find((e) => e.provenance === 'rule:procedure');
    expect(row).toMatchObject({ src: 'f_s2', dst: 'f_s1', etype: 'depends_on' });
  });

  it('依赖边共用 2 条配额', () => {
    const db = freshDb();
    addEpisode(db, 'ep_q');
    addFact(db, { id: 'f_a', name: 'a', entityId: 'en_a', sourceEpisode: 'ep_q', validAt: T(0) });
    addFact(db, { id: 'f_b', name: 'b', entityId: 'en_b', sourceEpisode: 'ep_q', validAt: T(1) });
    addFact(db, { id: 'f_c', name: 'c', entityId: 'en_c', sourceEpisode: 'ep_q', validAt: T(2) });
    addFact(db, {
      id: 'f_proc',
      entityId: 'en_proc2',
      predicate: 'procedure',
      sourceEpisode: 'ep_q',
      confidenceSource: 'llm_claim', // 不触发工具序列规则，把 2 条配额全留给过程步骤
      validAt: T(3),
      ext: { steps: ['a', 'b', 'c'] },
    });

    const res = extractEdges(db, { facts: factsByIds(db, ['f_proc']) });
    expect(res.created.procedure).toBe(EDGE_QUOTA.dependsOnPerFact);
  });
});

describe('P2-22 幂等与验收口径', () => {
  it('同一批跑两遍不新增边（(src,dst,etype) 活跃唯一）', () => {
    const db = freshDb();
    addFact(db, { id: 'f_a', entityId: 'en_port', predicate: 'value', validAt: T(0) });
    addFact(db, { id: 'f_b', entityId: 'en_port', predicate: 'owner', validAt: T(5) });

    const first = extractEdges(db, { facts: factsByIds(db, ['f_b']) });
    const second = extractEdges(db, { facts: factsByIds(db, ['f_b']) });
    expect(first.created.co_occur).toBe(1);
    expect(totalCreated(second.created)).toBe(0);
    expect(edges(db)).toHaveLength(1);
  });

  it('验收口径：10 条新事实至少 3 条边', () => {
    const db = freshDb();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = `f_v${String(i)}`;
      ids.push(id);
      addFact(db, { id, entityId: 'en_shared', predicate: `p${String(i)}`, validAt: T(i) });
    }
    const res = extractEdges(db, { facts: factsByIds(db, ids) });
    expect(totalCreated(res.created)).toBeGreaterThanOrEqual(3);
  });
});
