/**
 * unplug-safe（概设 §1.5「不改内核」验收 / 台账 P0-20）。
 *
 * 语义：把 daemon（含 MCP / HTTP 面）整个拔掉，宿主侧行为必须**完全不变、无报错、无重试**。
 *
 * 这条测试证明三件事：
 * 1. 零调用可用——不 boot、不开 MCP/HTTP，核心闭环（标注 → harvest → 查询）照常产事实；
 * 2. 降级静默——没有常驻服务时不存在任何会向调用方抛错的路径，也不留下 daemon 产物
 *    （锁文件 / 日志 / 会话目录），拔掉就是拔干净；
 * 3. 写盘守护——即使有代码路径想写宿主工作区，safeWrite 的白名单也会在落盘前拦下
 *    （E_ACCESS），外置系统永远没有资格污染宿主。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MoshiError } from '../../src/domain/errors.js';
import { assertWritablePath } from '../../src/infra/fs/safeWrite.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as annotationRepo from '../../src/infra/sqlite/annotationRepo.js';
import { searchFacts } from '../../src/infra/sqlite/factRepo.js';
import { harvest } from '../../src/core/write/harvest.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { dir: string; dbFile: string; db: Db } {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-unplug-'));
  dirs.push(dir);
  const dbFile = path.join(dir, 'moshi.db');
  const { db } = openDb({ file: dbFile });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  return { dir, dbFile, db };
}

function seedOne(db: Db, payload: unknown): void {
  db.prepare(
    `INSERT INTO annotation (id, dedup_key, payload_json, channel, received_at, harvested_at, error)
     VALUES (?, ?, ?, 'tool_parse', ?, NULL, NULL)`,
  ).run('an_unplug01', 'dk-unplug-1', JSON.stringify(payload), '2026-11-01T08:00:00.000Z');
}

describe('unplug-safe：daemon 缺席时宿主无感', () => {
  it('零调用可用：不开 daemon/MCP，harvest 闭环照常产出事实并可查询', async () => {
    const { db } = setup();
    // 全程没有任何 boot()/server/MCP——只有核心层的入队 → harvest → 查询
    seedOne(db, { tool: 'bash', cmd: 'node --version', output: 'v22.22.2\n', exitCode: 0 });

    const r = await harvest(db, { batchSize: 100 });
    expect(r.scanned).toBe(1);
    expect(r.created).toBe(1);
    expect(annotationRepo.countPending(db)).toBe(0);

    const hits = searchFacts(db, { q: '22.22.2', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('22.22.2');

    closeDb(db);
  });

  it('降级静默：不启动 daemon 不产生锁/日志/会话等常驻产物，库正常开关无异常', () => {
    const { dir, db } = setup();
    // 未 boot 的目录应当干净：没有任何 daemon 产物（拔掉就是拔干净）
    for (const name of ['daemon.lock', 'log', 'sessions', 'tmp']) {
      expect(existsSync(path.join(dir, name)), `${name} 不应存在`).toBe(false);
    }
    expect(() => closeDb(db)).not.toThrow();
  });

  it('写盘守护：任何路径想写宿主工作区都会被 E_ACCESS 拦在落盘前', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moshi-unplug-'));
    dirs.push(dir);
    const workspaceFile = path.join(tmpdir(), 'moshi-host-workspace.txt'); // 宿主工作区文件
    writeFileSync(workspaceFile, 'original'); // 宿主自己的文件，先造出来
    try {
      assertWritablePath(workspaceFile, [dir]);
      expect.unreachable('写盘白名单外应当抛 E_ACCESS');
    } catch (err) {
      expect(err).toBeInstanceOf(MoshiError);
      expect((err as MoshiError).code).toBe('E_ACCESS');
    }
  });
});
