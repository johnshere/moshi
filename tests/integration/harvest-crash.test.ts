/**
 * harvest 崩溃恢复（P0-15 验收："中途 kill -9 后重跑不丢不重"）。
 *
 * 为什么必须是真进程：事务回滚、WAL 恢复、写锁释放这三件事，**在同一个进程里
 * 模拟不出来**。用 `throw` 模拟只能证明"catch 到了"，证明不了"磁盘上留下的是什么"。
 *
 * 断言的核心不变量只有一条：
 *
 * ```
 * 对每条 annotation：要么 harvested_at 非空且事实已落库，要么 harvested_at 为空且没有事实
 * ```
 *
 * 也就是"事实数 == 已处理标注数"。这条成立，崩溃就不可能造成"半条事实"。
 * 然后重跑一遍，收敛到全量——这就是"不丢不重"。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import * as annotationRepo from '../../src/infra/sqlite/annotationRepo.js';
import { harvest } from '../../src/core/write/harvest.js';

const TOTAL = 4000;
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { dbFile: string; db: Db } {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-crash-'));
  dirs.push(dir);
  const dbFile = path.join(dir, 'moshi.db');
  const { db } = openDb({ file: dbFile });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  return { dbFile, db };
}

function seed(db: Db): void {
  const insert = db.prepare(
    `INSERT INTO annotation (id, dedup_key, payload_json, channel, received_at, harvested_at, error)
     VALUES (?, ?, ?, 'tool_parse', ?, NULL, NULL)`,
  );
  db.transaction(() => {
    for (let i = 0; i < TOTAL; i += 1) {
      const payload = {
        tool: 'bash',
        cmd: 'npm install',
        output: `+ pkg${String(i)}@1.0.0\n`,
        exitCode: 0,
      };
      insert.run(
        `an_${String(i).padStart(26, '0')}`,
        `dk-${String(i)}`,
        JSON.stringify(payload),
        '2026-10-31T02:10:00.000Z',
      );
    }
  })();
}

function counts(db: Db): { facts: number; harvested: number; pending: number } {
  const facts = (db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n;
  const harvested = (
    db.prepare('SELECT COUNT(*) AS n FROM annotation WHERE harvested_at IS NOT NULL').get() as {
      n: number;
    }
  ).n;
  return { facts, harvested, pending: annotationRepo.countPending(db) };
}

function activeDuplicates(db: Db): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT canonical_key, scope, value_hash, COUNT(*) AS c FROM fact
          WHERE valid_to IS NULL GROUP BY canonical_key, scope, value_hash HAVING c > 1)`,
    )
    .get() as { n: number };
  return row.n;
}

describe('harvest：kill -9 之后重跑', () => {
  it('不丢不重：事实数 == 已处理标注数，重跑收敛到全量', async () => {
    const { dbFile, db } = setup();
    seed(db);
    expect(annotationRepo.countPending(db)).toBe(TOTAL);
    closeDb(db); // 子进程要独占打开

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(import.meta.dirname, '..', 'fixtures', 'harvest-child.ts'), dbFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // 等子进程喊 ready（此时库已打开、即将开始 harvest）
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => {
        reject(new Error(`子进程没有就绪：${out}`));
      }, 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // 给它一点时间提交若干批，然后硬杀
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const killed = child.kill('SIGKILL');
    expect(killed).toBe(true);
    await once(child, 'exit');

    // ---- 崩溃后的现场 ----
    const after = openDb({ file: dbFile });
    const mid = counts(after.db);
    expect(mid.facts).toBe(mid.harvested); // 不变量：没有"半条事实"
    expect(mid.pending).toBeGreaterThan(0); // 确实被打断了
    expect(mid.harvested).toBeGreaterThan(0); // 且确实已经提交过若干批（否则这个测试什么都没测）
    expect(mid.harvested).toBeLessThan(TOTAL);
    expect(activeDuplicates(after.db)).toBe(0);
    closeDb(after.db);

    // ---- 重跑：收敛到全量，不重复 ----
    const resumed = openDb({ file: dbFile });
    const r = await harvest(resumed.db, { batchSize: 200, yieldBetweenBatches: true });
    const end = counts(resumed.db);
    expect(end.pending).toBe(0);
    expect(end.facts).toBe(TOTAL);
    expect(end.harvested).toBe(TOTAL);
    expect(activeDuplicates(resumed.db)).toBe(0);
    expect(r.scanned).toBe(TOTAL - mid.harvested);
    expect(r.created).toBe(TOTAL - mid.facts);
    closeDb(resumed.db);
  }, 60_000);
});
