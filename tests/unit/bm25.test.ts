/**
 * P1-03 预分词与 BM25 单测（详设 §6.4.2）。
 *
 * 验收：查 EADDRINUSE 命中；查"本机开发环境"命中（二元组生效）；
 * 写入与查询走同一个 tokenizeForFts。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalKey, valueHash } from '../../src/domain/hash.js';
import { newId } from '../../src/domain/ids.js';
import { nowIso } from '../../src/domain/time.js';
import type { Fact } from '../../src/domain/types.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { countFts, bm25Search } from '../../src/infra/sqlite/ftsRepo.js';
import { recallBm25 } from '../../src/core/read/recall/bm25.js';
import { orQuery, tokenizeForFts } from '../../src/core/parse/tokenize.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-bm25-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function makeFact(content: string, over: Partial<Fact> = {}): Fact {
  const ts = nowIso();
  const entityId = newId('entity');
  const scope = over.scope ?? 'global';
  return {
    id: newId('fact'),
    content,
    ftype: 'semantic',
    confidence: 0.9,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs: {
      frozen: { subject: { entity_id: entityId, name: 'node' }, predicate: 'state', value: content },
      ext: {},
    },
    canonicalKey: canonicalKey(scope, entityId, 'state'),
    valueHash: valueHash(content),
    scope,
    supersededBy: null,
    validAt: ts,
    validTo: null,
    recordedAt: ts,
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: ts,
    sourceEpisode: null,
    span: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

describe('tokenizeForFts（P1-03）', () => {
  it('标识符切分：保留原串与各段', () => {
    expect(tokenizeForFts('pnpm-lock.yaml')).toBe('pnpm-lock.yaml pnpm lock yaml');
  });

  it('驼峰兜底：EADDRINUSE 小写整串保留', () => {
    expect(tokenizeForFts('EADDRINUSE')).toBe('eaddrinuse');
    // 驼峰段补充：getPageText → get page text
    const t = tokenizeForFts('getPageText');
    expect(t.split(' ')).toEqual(expect.arrayContaining(['get', 'page', 'text', 'getpagetext']));
  });

  it('CJK 二元组：本机开发环境 → 5 个二元组', () => {
    expect(tokenizeForFts('本机开发环境')).toBe('本机 机开 开发 发环 环境');
  });

  it('单字 CJK 原样保留', () => {
    expect(tokenizeForFts('风')).toBe('风');
  });

  it('去停用词：的/了/the/of 不出现在结果', () => {
    const t = tokenizeForFts('这台机器的状态是好的');
    for (const w of ['的', '是', '了']) expect(t.split(' ')).not.toContain(w);
    expect(tokenizeForFts('the of a to')).toBe('');
  });

  it('orQuery：多 token 逐个加引号后 OR 连接（P1-26）', () => {
    expect(orQuery('pnpm lock yaml')).toBe('"pnpm" OR "lock" OR "yaml"');
    // 引号内部双写转义；空串丢弃
    expect(orQuery('a"b')).toBe('"a""b"');
    expect(orQuery('')).toBe('');
  });

  it('冒号进分隔符：pkg:node 拆出 pkg / node 两个 token（P1-26）', () => {
    const tokens = tokenizeForFts('pkg:node').split(' ');
    expect(tokens).toEqual(expect.arrayContaining(['pkg', 'node']));
    // 整串保留仍可能带冒号（step 1），但它会被 orQuery 加引号，不会再当列过滤语法
    expect(orQuery(tokenizeForFts('pkg:node'))).toContain('"pkg:node"');
  });
});

describe('BM25 检索（P1-03）', () => {
  it('fact 插入即同步 FTS 行；写入与查询同一 tokenize 口径', () => {
    const db = freshDb();
    const f = makeFact('端口 8080 被 node 占用，报错 EADDRINUSE');
    factRepo.insertFact(db, f);
    expect(countFts(db)).toBe(1);

    // 验收：查 EADDRINUSE 命中（大小写折叠 + 整串 token）
    const hits = recallBm25(db, 'EADDRINUSE');
    expect(hits.map((h) => h.fact_id)).toContain(f.id);
  });

  it('验收：查"本机开发环境"命中（二元组生效）', () => {
    const db = freshDb();
    const f = makeFact('本机开发环境：node 22 + pnpm 10，端口 53000');
    factRepo.insertFact(db, f);
    factRepo.insertFact(db, makeFact('远程服务器部署了 nginx，端口 8080'));

    const hits = recallBm25(db, '本机开发环境');
    expect(hits[0]!.fact_id).toBe(f.id);

    // 任意二元组也能命中（OR 语义，宽松召回）
    const partial = recallBm25(db, '开发环境');
    expect(partial.map((h) => h.fact_id)).toContain(f.id);
  });

  it('OR 连接避免长查询零命中', () => {
    const db = freshDb();
    const f = makeFact('端口 8080 被 node 占用');
    factRepo.insertFact(db, f);
    // 查询词与文档只有部分重叠（pnpm 未出现），OR 下仍能命中
    const hits = recallBm25(db, '8080 pnpm node');
    expect(hits.map((h) => h.fact_id)).toContain(f.id);
  });

  it('空查询返回空数组', () => {
    const db = freshDb();
    expect(recallBm25(db, '的 了')).toEqual([]);
  });

  it('含冒号的查询不再整条失效（P1-26）', () => {
    const db = freshDb();
    const f = makeFact('包 pkg:node 的版本是 22.22.2');
    factRepo.insertFact(db, f);
    expect(recallBm25(db, 'pkg:node').map((h) => h.fact_id)).toContain(f.id);
  });

  it('MATCH 语法错必须上抛，不吞成空结果（P1-26）', () => {
    const db = freshDb();
    // 裸 OR 是 FTS5 语法错：旧实现 catch 后返回 []，上层会当成"查无结果"
    expect(() => bm25Search(db, 'OR OR')).toThrow(/FTS 查询失败/);
  });
});
