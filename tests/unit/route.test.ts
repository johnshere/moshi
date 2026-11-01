/**
 * P1-05 意图分流与实体识别单测（详设 §6.2 / §6.3）。
 *
 * 验收："8080 有哪些风险"→local（全局词但含实体）；
 * "这台机器整体什么样"→global（全局词、无实体）；
 * `pnpm-lock.yaml` 只识别一个实体（最长匹配优先）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nowIso } from '../../src/domain/time.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import { routeIntent } from '../../src/core/read/route.js';
import { recognizeEntities } from '../../src/core/read/recognize.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-route-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 造实体 + alias（source=rule，confidence 可调） */
function addAlias(db: Db, alias: string, opts: { etype?: string; confidence?: number } = {}) {
  const e = entityRepo.ensureProvisional(db, alias, nowIso());
  entityRepo.addAlias(db, { alias, entityId: e.id, source: 'rule', confidence: opts.confidence ?? 1.0 });
  return e;
}

describe('实体识别（P1-05）', () => {
  it('端口识别：查 alias 表命中并带 span', () => {
    const db = freshDb();
    addAlias(db, '8080');
    const ents = recognizeEntities(db, '8080 有哪些风险');
    expect(ents.length).toBe(1);
    expect(ents[0]).toMatchObject({ matched_text: '8080', span: [0, 4] });
  });

  it('最长匹配优先：pnpm-lock.yaml 只识别一个实体（整体，不再单查 pnpm）', () => {
    const db = freshDb();
    addAlias(db, 'pnpm-lock.yaml');
    addAlias(db, 'pnpm');
    const ents = recognizeEntities(db, 'pnpm-lock.yaml 是什么');
    // 长候选先命中并占用 span，pnpm 不再单独识别
    expect(ents.length).toBe(1);
    expect(ents[0]!.matched_text).toBe('pnpm-lock.yaml');
  });

  it('路径候选按原样+规范化两形态查', () => {
    const db = freshDb();
    // normalizePath 只小写盘符、其余保留大小写（Linux 路径区分大小写）
    const e = entityRepo.ensureProvisional(db, 'C:/Users/john/project', nowIso());
    entityRepo.addAlias(db, { alias: 'c:/Users/john/project', entityId: e.id, source: 'rule', confidence: 0.9 });
    const ents = recognizeEntities(db, 'C:/Users/john/project 的构建脚本');
    expect(ents.length).toBe(1);
    expect(ents[0]!.entity_id).toBe(e.id);
    expect(ents[0]!.matched_text).toBe('C:/Users/john/project');
  });

  it('同一片段命中多实体（不同 etype）取前 2', () => {
    const db = freshDb();
    // 两个实体都有 alias "v22"：一个 pkg、一个 version
    const a = entityRepo.insertEntity(db, { canonicalName: 'pkg:v22', etype: 'pkg' });
    const b = entityRepo.insertEntity(db, { canonicalName: 'version:v22', etype: 'version' });
    entityRepo.addAlias(db, { alias: 'v22', entityId: a.id, source: 'rule', confidence: 0.8 });
    entityRepo.addAlias(db, { alias: 'v22', entityId: b.id, source: 'rule', confidence: 0.9 });
    const ents = recognizeEntities(db, 'v22 的节点版本');
    expect(ents.length).toBe(2);
    expect(ents.map((e) => e.entity_id).sort()).toEqual([a.id, b.id].sort());
  });

  it('无命中返回空', () => {
    const db = freshDb();
    expect(recognizeEntities(db, '这台机器整体什么样')).toEqual([]);
  });
});

describe('意图分流（P1-05）', () => {
  it('验收："8080 有哪些风险"→local（全局词但含实体）', () => {
    const db = freshDb();
    addAlias(db, '8080');
    const r = routeIntent(db, '8080 有哪些风险');
    expect(r.route).toBe('local');
    expect(r.hasEntity).toBe(true);
  });

  it('验收："这台机器整体什么样"→global（全局词、无实体）', () => {
    const db = freshDb();
    const r = routeIntent(db, '这台机器整体什么样');
    expect(r.route).toBe('global');
    expect(r.globalWord).toBe(true);
  });

  it('含具体标识符→local（未注册实体也被 LOCAL_HINTS 判 local）', () => {
    const db = freshDb();
    expect(routeIntent(db, '查一下 EADDRINUSE 是什么').route).toBe('local');
    expect(routeIntent(db, '/src/infra/ 有哪些文件').route).toBe('local');
    expect(routeIntent(db, 'PORT_8080 还在占用吗').route).toBe('local');
  });

  it('默认 local', () => {
    const db = freshDb();
    expect(routeIntent(db, '帮我看看 node 版本').route).toBe('local');
  });

  it('全局词按词边界匹配：install / small 不再被当成 all（P1-27）', () => {
    const db = freshDb();
    const install = routeIntent(db, 'install pnpm 到哪个目录');
    expect(install.globalWord).toBe(false);
    expect(install.route).toBe('local');

    const small = routeIntent(db, 'small.png 这张图放哪');
    expect(small.globalWord).toBe(false);
    expect(small.route).toBe('local');

    // 真正的 all 仍然算全局词
    expect(routeIntent(db, 'all risks').route).toBe('global');
    expect(routeIntent(db, '有哪些风险').route).toBe('global');
  });
});
