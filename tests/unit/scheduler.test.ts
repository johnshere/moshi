/**
 * 调度器单测（P2-17 / 详设 §8.6）。
 *
 * 覆盖：cron 解析与匹配、03:00 依赖链顺序、同分钟不重复、错过不补跑、并发 1、
 * 超时告警后继续、令牌桶 20 条/秒、last_harvest_at 更新、collect/layout 不自装定时器。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { getMeta } from '../../src/infra/sqlite/metaRepo.js';
import { countSamplesByKind } from '../../src/infra/sqlite/trainingSampleRepo.js';
import { openAdjudication, resolveAdjudication } from '../../src/infra/sqlite/adjudicationRepo.js';
import { loadConfig, type Config } from '../../src/app/config.js';
import { startCollectRunner } from '../../src/app/collectRunner.js';
import { startLayoutRunner } from '../../src/app/layoutRunner.js';
import { insertFact } from '../fixtures/factories.js';
import {
  createRateLimiter,
  cronMatches,
  parseCron,
  startScheduler,
  type SchedulerJob,
  type SchedulerLog,
} from '../../src/app/jobs/scheduler.js';

const dirs: string[] = [];
const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeEnv(): { db: Db; cfg: Config; home: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'moshi-sched-'));
  dirs.push(home);
  const { db } = openDb({ file: path.join(home, 'moshi.db') });
  migrate(db, { backupsDir: path.join(home, 'backups') });
  opened.push(db);
  return { db, cfg: loadConfig({ home }), home };
}

function fakeLog(): SchedulerLog & { lines: { level: string; obj: Record<string, unknown>; msg: string }[] } {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    lines,
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => lines.push({ level: 'error', obj, msg }),
  };
}

function fakeJob(
  name: string,
  extra: Partial<SchedulerJob> & { onRun?: () => Promise<void> | void } = {},
): SchedulerJob {
  const { onRun, ...rest } = extra;
  return {
    name,
    priority: 10,
    ...rest,
    async run() {
      await onRun?.();
      return null;
    },
  };
}

describe('cron 解析', () => {
  it('5 段表达式与分钟/小时/星期匹配', () => {
    const spec = parseCron('0 3 * * *');
    expect(cronMatches(spec, new Date(2026, 10, 4, 3, 0, 0))).toBe(true);
    expect(cronMatches(spec, new Date(2026, 10, 4, 3, 1, 0))).toBe(false);
    expect(cronMatches(spec, new Date(2026, 10, 4, 4, 0, 0))).toBe(false);

    const every15 = parseCron('*/15 * * * *');
    expect(cronMatches(every15, new Date(2026, 10, 4, 9, 45, 0))).toBe(true);
    expect(cronMatches(every15, new Date(2026, 10, 4, 9, 46, 0))).toBe(false);

    const monday = parseCron('0 4 * * 1');
    expect(cronMatches(monday, new Date(2026, 10, 2, 4, 0, 0))).toBe(true); // 2026-11-02 周一
    expect(cronMatches(monday, new Date(2026, 10, 3, 4, 0, 0))).toBe(false);

    expect(parseCron('0 0 1 * *').days.has(1)).toBe(true);
    expect(() => parseCron('0 3 * *')).toThrow(/5 fields/);
    expect(() => parseCron('61 3 * * *')).toThrow(/out of range/);
  });
});

describe('调度链（P2-17 §8.6）', () => {
  it('03:00 依次跑 harvest→consolidate→infer，同一分钟不重复触发', async () => {
    const { db, cfg } = makeEnv();
    const order: string[] = [];
    const log = fakeLog();
    const sched = startScheduler({
      db,
      cfg,
      log,
      timerMs: 0,
      jobs: [
        fakeJob('harvest', { cron: '0 3 * * *', priority: 10, onRun: () => void order.push('harvest') }),
        fakeJob('consolidate', { after: 'harvest', priority: 20, onRun: () => void order.push('consolidate') }),
        fakeJob('infer', { after: 'consolidate', priority: 30, onRun: () => void order.push('infer') }),
      ],
    });

    const at = new Date(2026, 10, 4, 3, 0, 0);
    const res = await sched.runDue(at);
    expect(res.map((r) => r.name)).toEqual(['harvest', 'consolidate', 'infer']);
    expect(order).toEqual(['harvest', 'consolidate', 'infer']);

    // 同一年分钟再次 tick：不重复跑
    expect(await sched.runDue(at)).toEqual([]);
    expect(order).toHaveLength(3);
    expect(sched.state().runs).toBe(3);
    sched.stop();
  });

  it('错过的 tick 不补跑：只处理当前分钟', async () => {
    const { db, cfg } = makeEnv();
    const order: string[] = [];
    const sched = startScheduler({
      db,
      cfg,
      log: fakeLog(),
      timerMs: 0,
      jobs: [fakeJob('harvest', { cron: '0 3 * * *', onRun: () => void order.push('harvest') })],
    });

    // 03:05 / 03:06：03:00 已错过，不补跑
    expect(await sched.runDue(new Date(2026, 10, 4, 3, 5, 0))).toEqual([]);
    expect(await sched.runDue(new Date(2026, 10, 4, 3, 6, 0))).toEqual([]);
    expect(order).toEqual([]);
    sched.stop();
  });

  it('并发 1：第二个 tick 排队，任务不并发执行', async () => {
    const { db, cfg } = makeEnv();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const sched = startScheduler({
      db,
      cfg,
      log: fakeLog(),
      timerMs: 0,
      jobs: [
        fakeJob('harvest', {
          cron: '* * * * *',
          priority: 10,
          onRun: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            order.push('harvest');
            await sleep(15);
            active -= 1;
          },
        }),
        fakeJob('consolidate', {
          after: 'harvest',
          priority: 20,
          onRun: () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            order.push('consolidate');
            active -= 1;
          },
        }),
      ],
    });

    const p1 = sched.runDue(new Date(2026, 10, 4, 3, 0, 0));
    const p2 = sched.runDue(new Date(2026, 10, 4, 3, 1, 0));
    await Promise.all([p1, p2]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(['harvest', 'consolidate', 'harvest', 'consolidate']);
    expect(sched.state().running).toBeNull();
    expect(sched.state().queued).toBe(0);
    sched.stop();
  });

  it('超时写 warn 并继续下一任务', async () => {
    const { db, cfg } = makeEnv();
    const log = fakeLog();
    const ran: string[] = [];
    const sched = startScheduler({
      db,
      cfg,
      log,
      timerMs: 0,
      timeoutMs: 30,
      jobs: [
        fakeJob('harvest', {
          cron: '0 3 * * *',
          priority: 10,
          onRun: () => new Promise<void>(() => undefined),
        }),
        fakeJob('consolidate', {
          after: 'harvest',
          priority: 20,
          onRun: () => {
            ran.push('consolidate');
          },
        }),
      ],
    });

    const res = await sched.runDue(new Date(2026, 10, 4, 3, 0, 0));
    expect(res.map((r) => [r.name, r.status])).toEqual([
      ['harvest', 'timeout'],
      ['consolidate', 'ok'],
    ]);
    expect(ran).toEqual(['consolidate']);
    expect(log.lines.some((l) => l.level === 'warn' && l.obj.event === 'scheduler.job.timeout')).toBe(true);
    sched.stop();
  });
});

describe('每日样本回填（P1②）', () => {
  it('03:30 跑 samples，把新裁决转成 training_sample，重复跑幂等', async () => {
    const { db, cfg } = makeEnv();
    const adjId = openAdjudication(db, {
      kind: 'mutex_win',
      factIds: ['f_a', 'f_b'],
      decidedBy: 'mutex_by_confidence@2',
      decidedAt: '2026-11-04T00:00:00.000Z',
    });
    resolveAdjudication(db, adjId, 'overturned', null, '2026-11-04T00:00:00.000Z');

    const sched = startScheduler({ db, cfg, log: fakeLog(), timerMs: 0 });
    const res = await sched.runDue(new Date(2026, 10, 5, 3, 30, 0));
    expect(res.map((r) => [r.name, r.status])).toEqual([['samples', 'ok']]);
    expect(countSamplesByKind(db)).toEqual([
      { source: 'adjudication', labelKind: 'overturn', n: 1 },
    ]);

    // 幂等：同一份来源再跑一次不新增
    const again = await sched.runJob('samples');
    expect(again.status).toBe('ok');
    expect(countSamplesByKind(db)).toEqual([
      { source: 'adjudication', labelKind: 'overturn', n: 1 },
    ]);
    sched.stop();
  });
});

describe('限速与联动', () => {
  it('令牌桶 20 条/秒：满桶立即可用，超出的等到下一窗口', async () => {
    let clock = 0;
    const limiter = createRateLimiter({
      capacity: 20,
      intervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await limiter.take(20);
    expect(limiter.available()).toBe(0);

    await limiter.take(1);
    expect(clock).toBeGreaterThanOrEqual(50);
    expect(limiter.available()).toBe(0);
  });

  it('collect 由调度器按 collect.interval_ms 驱动（不在 collectRunner 里自调度）', async () => {
    const { db, cfg } = makeEnv();
    const base = new Date(2026, 10, 4, 3, 0, 0);
    const runs: number[] = [];
    const collectCfg = { ...cfg, collect: { ...cfg.collect, interval_ms: 1000 } };
    const sched = startScheduler({
      db,
      cfg: collectCfg,
      log: fakeLog(),
      timerMs: 0,
      now: () => base,
      jobs: [],
      collect: () => {
        runs.push(1);
      },
    });

    await sched.runDue(new Date(base.getTime() + 2000));
    expect(runs).toHaveLength(1);
    expect(sched.state().lastRuns.collect?.status).toBe('ok');
    sched.stop();
  });

  it('collectRunner / layoutRunner 默认不装定时器', () => {
    const { db, cfg } = makeEnv();
    const fast = {
      ...cfg,
      collect: { ...cfg.collect, interval_ms: 5 },
      layout: { ...cfg.layout, interval_ms: 5 },
    };
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const collect = startCollectRunner({
      db,
      cfg: fast,
      cursorsFile: path.join(tmpdir(), 'never-written-cursors.json'),
      home: tmpdir(),
      });
    const layout = startLayoutRunner({ db, cfg: fast });

    expect(setIntervalSpy).not.toHaveBeenCalled();
    // schedule() 只在 intervalMs>0 时用 setTimeout；默认 0 不应出现
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(collect.state().runs).toBe(0);
    expect(layout.state().runs).toBe(0);
    collect.stop();
    layout.stop();
  });

  it('真实默认 JOBS：03:00 跑 backup→harvest→consolidate→infer→community，并更新 last_harvest_at', async () => {
    const { db, cfg, home } = makeEnv();
    const log = fakeLog();
    const sched = startScheduler({ db, cfg, log, timerMs: 0, now: () => new Date(2026, 10, 4, 3, 0, 0) });

    const res = await sched.runDue(new Date(2026, 10, 4, 3, 0, 0));
    const names = res.map((r) => r.name);
    // backup 优先级 5 最先；harvest 触发 consolidate → infer → community
    expect(names.indexOf('harvest')).toBeGreaterThan(names.indexOf('backup'));
    expect(names.indexOf('consolidate')).toBeGreaterThan(names.indexOf('harvest'));
    expect(names.indexOf('infer')).toBeGreaterThan(names.indexOf('consolidate'));
    expect(names.indexOf('community')).toBeGreaterThan(names.indexOf('infer'));
    expect(res.every((r) => r.status === 'ok' || r.status === 'skipped')).toBe(true);
    expect(getMeta(db, 'last_harvest_at')).not.toBeNull();
    expect(home.length).toBeGreaterThan(0);
    sched.stop();
  });

  it('社区重建：独立周级 cron（周日 05:00）+ after:infer 顺序，且一轮只触发一次', async () => {
    const { db, cfg } = makeEnv();
    const sched = startScheduler({ db, cfg, log: fakeLog(), timerMs: 0 });

    // 周三 03:00：harvest 链把 community 带进本轮，排在 infer 之后、只出现一次
    const chain = await sched.runDue(new Date(2026, 10, 4, 3, 0, 0));
    const chainNames = chain.map((r) => r.name);
    expect(chainNames).toContain('community');
    expect(chainNames.indexOf('community')).toBeGreaterThan(chainNames.indexOf('infer'));
    expect(chainNames.filter((n) => n === 'community')).toHaveLength(1);

    // 周六 05:00：既不是 harvest 链，也不是周日 cron —— 不触发
    const sat = await sched.runDue(new Date(2026, 10, 7, 5, 0, 0));
    expect(sat.map((r) => r.name)).not.toContain('community');

    // 周日 05:00：独立 cron 兜底触发（图没变时走脏检查跳过，仍算一次触发）
    const sun = await sched.runDue(new Date(2026, 10, 8, 5, 0, 0));
    expect(sun.map((r) => r.name)).toContain('community');
    sched.stop();
  });
});

describe('周期 layout 合流（P2-28 / Z-2）', () => {
  it('到期且有新事实才运行；未到期、零脏事实与同分钟去重均不运行', async () => {
    const { db, cfg } = makeEnv();
    const base = new Date(2026, 10, 4, 3, 0, 0);
    const fast = { ...cfg, layout: { ...cfg.layout, interval_ms: 120_000 } };
    let runs = 0;
    const sched = startScheduler({
      db, cfg: fast, log: fakeLog(), timerMs: 0, now: () => base,
      jobs: [fakeJob('layout', { onRun: () => { runs += 1; } })],
    });

    expect(await sched.runDue(new Date(base.getTime() + 60_000))).toEqual([]);
    expect(await sched.runDue(new Date(base.getTime() + 120_000))).toEqual([]);
    expect(runs).toBe(0);

    insertFact(db, { id: 'layout-dirty', content: '待布局事实' });
    const due = await sched.runDue(new Date(base.getTime() + 180_000));
    expect(due.map((r) => r.name)).toEqual(['layout']);
    expect(await sched.runDue(new Date(base.getTime() + 180_000))).toEqual([]);
    expect(runs).toBe(1);
    sched.stop();
  });

  it('layout.enabled=false 或 interval_ms=0 时不触发', async () => {
    const { db, cfg } = makeEnv();
    insertFact(db, { id: 'layout-dirty', content: '待布局事实' });
    const base = new Date(2026, 10, 4, 3, 0, 0);
    for (const layout of [
      { ...cfg.layout, enabled: false, interval_ms: 1000 },
      { ...cfg.layout, enabled: true, interval_ms: 0 },
    ]) {
      let runs = 0;
      const sched = startScheduler({
        db, cfg: { ...cfg, layout }, log: fakeLog(), timerMs: 0, now: () => base,
        jobs: [fakeJob('layout', { onRun: () => { runs += 1; } })],
      });
      expect(await sched.runDue(new Date(base.getTime() + 60_000))).toEqual([]);
      expect(runs).toBe(0);
      sched.stop();
    }
  });

  it('export 链已含 layout 时不重复，并从 export 轮重新计算周期', async () => {
    const { db, cfg } = makeEnv();
    insertFact(db, { id: 'layout-dirty', content: '待布局事实' });
    const base = new Date(2026, 10, 4, 3, 59, 0);
    const order: string[] = [];
    const sched = startScheduler({
      db,
      cfg: { ...cfg, layout: { ...cfg.layout, interval_ms: 120_000 } },
      log: fakeLog(), timerMs: 0, now: () => base,
      jobs: [
        fakeJob('export', { cron: '0 4 * * *', priority: 40, onRun: () => void order.push('export') }),
        fakeJob('layout', { after: 'export', priority: 50, onRun: () => void order.push('layout') }),
      ],
    });

    const exported = await sched.runDue(new Date(2026, 10, 4, 4, 0, 0));
    expect(exported.map((r) => r.name)).toEqual(['export', 'layout']);
    expect(await sched.runDue(new Date(2026, 10, 4, 4, 1, 0))).toEqual([]);
    const next = await sched.runDue(new Date(2026, 10, 4, 4, 2, 0));
    expect(next.map((r) => r.name)).toEqual(['layout']);
    expect(order).toEqual(['export', 'layout', 'layout']);
    sched.stop();
  });

  it('layout 失败不阻塞后续任务，下周期重试且全链并发仍为 1', async () => {
    const { db, cfg } = makeEnv();
    insertFact(db, { id: 'layout-dirty', content: '待布局事实' });
    const base = new Date(2026, 10, 4, 3, 0, 0);
    let attempts = 0;
    let active = 0;
    let maxActive = 0;
    const runExclusive = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
    };
    const sched = startScheduler({
      db,
      cfg: { ...cfg, layout: { ...cfg.layout, interval_ms: 1000 } },
      log: fakeLog(), timerMs: 0, now: () => base,
      jobs: [
        fakeJob('layout', {
          priority: 10,
          onRun: async () => {
            attempts += 1;
            await runExclusive();
            if (attempts === 1) throw new Error('layout boom');
          },
        }),
        fakeJob('other', { cron: '* * * * *', priority: 20, onRun: runExclusive }),
      ],
    });

    const first = await sched.runDue(new Date(base.getTime() + 60_000));
    expect(first.map((r) => [r.name, r.status])).toEqual([['layout', 'failed'], ['other', 'ok']]);
    const second = await sched.runDue(new Date(base.getTime() + 120_000));
    expect(second.map((r) => [r.name, r.status])).toEqual([['layout', 'ok'], ['other', 'ok']]);
    expect(attempts).toBe(2);
    expect(maxActive).toBe(1);
    sched.stop();
  });
});
