/**
 * `app/collectRunner.ts` 的端到端用例：把「真实目录里的会话文件 → 扫描 → 入队 →
 * 唤醒 harvest」这条生产链路跑一遍，确认 P2-21 的调用点不是摆设。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { startCollectRunner } from '../../src/app/collectRunner.js';

const dirs: string[] = [];
const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-runner-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function count(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

function jsonlLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-02T02:00:00.000Z',
    sessionId: 'sess1',
    cwd: 'J:\\ws',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

const BLOCK = '```moshi\n{"v":1,"facts":[{"subject":"daemon","predicate":"port","value":"53000",' +
  '"content":"daemon 监听端口 = 53000","confidence":0.95,"source":"tool_obs"}],"edges":[]}\n```';

describe('P2-21 生产驱动 collectRunner', () => {
  it('runOnce 扫到真实会话文件并入队，第二遍不重复、不重复唤醒', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-home-'));
    dirs.push(home);
    const proj = path.join(home, '.claude', 'projects', '-ws-proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, 'sess1.jsonl'), `${jsonlLine(`记一下\n${BLOCK}`)}\n`, 'utf8');

    const db = freshDb();
    const cfg = loadConfig({ home });
    const cursorsFile = path.join(home, 'moshi-data', 'cursors.blocks.json');

    let wakes = 0;
    const runner = startCollectRunner({
      db,
      cfg,
      cursorsFile,
      home,
      genericInbox: path.join(home, 'inbox'),
      intervalMs: 0, // 测试里手动驱动，不开定时器
      onEnqueued: () => {
        wakes += 1;
      },
    });

    const first = await runner.runOnce();
    expect(first?.blockAnnotationsCreated).toBe(1);
    expect(wakes).toBe(1);
    expect(count(db, 'annotation')).toBe(1);
    expect(existsSync(cursorsFile)).toBe(true);

    const second = await runner.runOnce();
    expect(second?.blockAnnotationsCreated).toBe(0);
    expect(wakes).toBe(1);
    expect(count(db, 'annotation')).toBe(1);

    runner.stop();
    expect(runner.state().runs).toBe(2);
    expect(runner.state().lastError).toBeNull();
  });

  it('collect.enabled=false 时一轮都不扫', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-home-'));
    dirs.push(home);
    const db = freshDb();
    const base = loadConfig({ home });
    const cfg = { ...base, collect: { ...base.collect, enabled: false } };

    const runner = startCollectRunner({
      db,
      cfg,
      cursorsFile: path.join(home, 'cursors.blocks.json'),
      home,
      genericInbox: path.join(home, 'inbox'),
      intervalMs: 0,
    });

    expect(await runner.runOnce()).toBeNull();
    expect(runner.state().runs).toBe(0);
    runner.stop();
  });
});
