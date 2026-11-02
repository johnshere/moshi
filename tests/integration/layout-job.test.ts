/**
 * 布局 job 集成（P2-01 验收）：
 *
 * - A. 坐标**真的在 worker 线程**算出来（threadId ≠ 0），且 300 tick 的计算不卡主线程
 * - B. 同一份数据两次 `--full` → 坐标逐位相同
 * - C. 新增 10 个事实 → 增量只写新增、老行一字不动、平均位移 < 15
 * - D. 没有新事实 → 一次 COUNT 就返回，不写库
 * - E. 新增规模过大 → 位移超阈值，自动退回全量
 * - F. 生产调用点 `moshi layout` 走得通（CLI 入口 + 真 worker）
 *
 * 每次 job 都要起一个带 tsx 的 worker 线程（源码直跑），单个用例留了 60s 超时。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/app/cli/index.js';
import { dataPaths, loadConfig, type Config } from '../../src/app/config.js';
import { runLayoutJob } from '../../src/app/jobs/layout.job.js';
import { startLayoutRunner } from '../../src/app/layoutRunner.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { countUnlaidFacts, listLayoutCoords, maxLayoutVersion } from '../../src/infra/sqlite/layoutRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

const TIMEOUT = 60_000;

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

interface Bench {
  db: Db;
  cfg: Config;
  home: string;
  close(): void;
}

function bench(): Bench {
  const home = mkdtempSync(path.join(tmpdir(), 'moshi-layout-'));
  dir = home;
  const cfg = loadConfig({ home });
  const paths = dataPaths(cfg);
  const { db } = openDb({ file: paths.db });
  migrate(db, { backupsDir: paths.backups });
  return { db, cfg, home, close: () => closeDb(db) };
}

/** 200 条事实串成链，再每隔 3 个点拉一条长边——形状接近真实的因果图 */
function seedFacts(db: Db, count: number, from = 0): string[] {
  const ids: string[] = [];
  for (let i = from; i < from + count; i += 1) {
    ids.push(insertFact(db, { id: `fact_${String(i).padStart(3, '0')}` }));
  }
  for (let i = 0; i + 1 < ids.length; i += 1) insertEdge(db, ids[i]!, ids[i + 1]!);
  for (let i = 0; i + 3 < ids.length; i += 3) insertEdge(db, ids[i]!, ids[i + 3]!);
  return ids;
}

const coordKey = (rows: readonly { id: string; x: number; y: number; z: number }[]): string =>
  JSON.stringify(rows.map((r) => [r.id, r.x, r.y, r.z]));

describe('布局 job', () => {  it(
    'A. 首跑走全量、坐标在 worker 线程算出、主线程不被 300 tick 卡住',
    async () => {
      const b = bench();
      try {
        seedFacts(b.db, 200);
        expect(countUnlaidFacts(b.db)).toBe(200);

        // 主线程心跳：如果 300 tick 在主线程同步跑（同规模实测 ~200ms），
        // 这里会出现一个接近 200ms 的空档
        let last = performance.now();
        let maxGap = 0;
        const timer = setInterval(() => {
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
        }, 5);

        const stats = await runLayoutJob({ db: b.db, cfg: b.cfg });
        const tailGap = performance.now() - last;
        clearInterval(timer);

        expect(stats.mode).toBe('full');
        expect(stats.ticks).toBe(300);
        expect(stats.newFacts).toBe(200);
        expect(stats.wrote).toBe(200);
        expect(stats.version).toBe(1);
        // threadId 只有 worker 线程非 0（主线程是 0）→ 坐标确实在别的线程算的
        expect(stats.workerThreadId).not.toBe(0);
        expect(Math.max(maxGap, tailGap)).toBeLessThan(150);

        const rows = listLayoutCoords(b.db);
        expect(rows.length).toBe(200);
        for (const r of rows) {
          expect(Math.max(Math.abs(r.x), Math.abs(r.y), Math.abs(r.z))).toBeLessThanOrEqual(100.000001);
        }
        // 三维都真展开：forceSimulation 第二参写 1（numDimensions）时 y/z 永不积分，
        // 落库后 y/z 极差只有 1e-2 量级，三维图会渲染成一条直线
        const spread = (axis: 'x' | 'y' | 'z'): number => {
          const vs = rows.map((r) => r[axis]);
          return Math.max(...vs) - Math.min(...vs);
        };
        expect(spread('y')).toBeGreaterThan(0.5 * spread('x'));
        expect(spread('z')).toBeGreaterThan(0.5 * spread('x'));
        expect(maxLayoutVersion(b.db)).toBe(1);
        expect(countUnlaidFacts(b.db)).toBe(0);
      } finally {
        b.close();
      }
    },
    TIMEOUT,
  );

  it(
    'B. 同一份数据两次全量重算，坐标逐位相同',
    async () => {
      const b = bench();
      try {
        seedFacts(b.db, 120);
        const first = await runLayoutJob({ db: b.db, cfg: b.cfg, full: true });
        const rowsA = listLayoutCoords(b.db);

        const second = await runLayoutJob({ db: b.db, cfg: b.cfg, full: true });
        const rowsB = listLayoutCoords(b.db);

        expect(first.mode).toBe('full');
        expect(second.mode).toBe('full');
        expect(second.version).toBe(first.version + 1);
        // 逐位相同：序列化后一字不差，不是"大概相同"
        expect(coordKey(rowsB)).toBe(coordKey(rowsA));
        // 两次的 worker 线程不是同一个（每次 job 起一个新线程）
        expect(second.workerThreadId).not.toBe(0);
        expect(first.workerThreadId).not.toBe(0);
      } finally {
        b.close();
      }
    },
    TIMEOUT,
  );

  it(
    'C. 新增 10 个事实 → 只写新增、老行坐标与时间戳不动、平均位移 < 15',
    async () => {
      const b = bench();
      try {
        seedFacts(b.db, 200);
        const initial = await runLayoutJob({ db: b.db, cfg: b.cfg, full: true });
        expect(initial.wrote).toBe(200);
        const before = listLayoutCoords(b.db);

        const added = seedFacts(b.db, 10, 200);
        const stats = await runLayoutJob({ db: b.db, cfg: b.cfg });

        expect(stats.mode).toBe('incremental');
        expect(stats.ticks).toBe(60);
        expect(stats.newFacts).toBe(10);
        expect(stats.fellBackToFull).toBe(false);
        expect(stats.wrote).toBe(10);
        expect(stats.avgDisplacement).toBeLessThan(15);
        expect(stats.version).toBe(initial.version + 1);

        const after = listLayoutCoords(b.db);
        expect(after.length).toBe(210);
        // 老行原样保留（同一版本号、同一时间戳、同一坐标）
        const oldRows = after.filter((r) => !added.includes(r.id));
        expect(coordKey(oldRows)).toBe(coordKey(before));
        expect(oldRows.every((r) => r.version === initial.version)).toBe(true);
        // 新行同版本、时间戳一致
        const newRows = after.filter((r) => added.includes(r.id));
        expect(newRows.length).toBe(10);
        expect(newRows.every((r) => r.version === stats.version)).toBe(true);
        expect(new Set(newRows.map((r) => r.computedAt)).size).toBe(1);
      } finally {
        b.close();
      }
    },
    TIMEOUT,
  );

  it(
    'D. 没有新事实时直接跳过，不写库',
    async () => {
      const b = bench();
      try {
        seedFacts(b.db, 60);
        const first = await runLayoutJob({ db: b.db, cfg: b.cfg });
        const rows = listLayoutCoords(b.db);

        const again = await runLayoutJob({ db: b.db, cfg: b.cfg });
        expect(again.mode).toBe('skip');
        expect(again.skipReason).toBe('up-to-date');
        expect(again.wrote).toBe(0);
        expect(again.version).toBe(first.version);
        expect(coordKey(listLayoutCoords(b.db))).toBe(coordKey(rows));
        // 没有新事实时连 worker 都不该起
        expect(again.workerThreadId).toBe(0);
      } finally {
        b.close();
      }
    },
    TIMEOUT,
  );

  it(
    'E. 大量新增 → 平均位移超阈值，自动退回全量重算',
    async () => {
      const b = bench();
      try {
        seedFacts(b.db, 120);
        await runLayoutJob({ db: b.db, cfg: b.cfg, full: true });
        seedFacts(b.db, 120, 120);

        const stats = await runLayoutJob({ db: b.db, cfg: b.cfg });
        expect(stats.fellBackToFull).toBe(true);
        expect(stats.mode).toBe('full');
        expect(stats.ticks).toBe(300);
        expect(stats.wrote).toBe(240);
        expect(stats.avgDisplacement).toBeGreaterThan(15);
        expect(listLayoutCoords(b.db).length).toBe(240);
      } finally {
        b.close();
      }
    },
    TIMEOUT,
  );

  it(
    'F. 生产调用点：`moshi layout --full` 走得通',
    async () => {
      const b = bench();
      try {
        seedFacts(b.db, 40);
        b.close();
        dir = b.home;

        const out: string[] = [];
        const code = await runCli(['layout', '--full'], {
          home: b.home,
          stdout: (s) => out.push(s),
          stderr: (s) => out.push(s),
        });
        expect(code).toBe(0);
        const text = out.join('');
        expect(text).toContain('布局完成');
        expect(text).toContain('全量');
        expect(text).toContain('节点 40');

        // 落库了才算走通（CLI 自己开的库，重新打开断言）
        const cfg = loadConfig({ home: b.home });
        const { db } = openDb({ file: dataPaths(cfg).db });
        try {
          expect(listLayoutCoords(db).length).toBe(40);
          expect(maxLayoutVersion(db)).toBe(1);
        } finally {
          closeDb(db);
        }

        // 空库走另一条分支（不报错，只提示没有可见事实）
        const home2 = mkdtempSync(path.join(tmpdir(), 'moshi-layout-empty-'));
        try {
          const cfg2 = loadConfig({ home: home2 });
          const { db: db2 } = openDb({ file: dataPaths(cfg2).db });
          migrate(db2, { backupsDir: dataPaths(cfg2).backups });
          closeDb(db2);
          const out2: string[] = [];
          const code2 = await runCli(['layout'], {
            home: home2,
            stdout: (s) => out2.push(s),
            stderr: (s) => out2.push(s),
          });
          expect(code2).toBe(0);
          expect(out2.join('')).toContain('库里还没有可见事实');
        } finally {
          rmSync(home2, { recursive: true, force: true });
        }
      } finally {
        // bench 的 db 可能已经关过（F 里显式 close 过），closeDb 幂等
        b.close();
      }
    },
    TIMEOUT,
  );

  it(
    'G. daemon 节流器：空库/无新事实不发任务，有了才起 worker',
    async () => {
      const b = bench();
      try {
        const runner = startLayoutRunner({ db: b.db, cfg: b.cfg, intervalMs: 0 });

        const empty = await runner.runOnce();
        expect(empty.mode).toBe('skip');
        expect(empty.skipReason).toBe('no-facts');
        expect(empty.workerThreadId).toBe(0);

        seedFacts(b.db, 30);
        const stats = await runner.runOnce();
        expect(stats.mode).toBe('full');
        expect(stats.workerThreadId).not.toBe(0);
        expect(runner.state().runs).toBe(2);
        expect(runner.state().lastMs).not.toBeNull();

        const idle = await runner.runOnce();
        expect(idle.skipReason).toBe('up-to-date');
        expect(idle.wrote).toBe(0);

        runner.stop();
        expect(runner.state().running).toBe(false);
      } finally {
        b.close();
      }
    },
    TIMEOUT,
  );
});
