/**
 * P3-09 双门槛 gate（详设 §7.6）。
 *
 * 验收口径：
 * - 门槛 1：非循环样本（source=adjudication && label_kind=overturn）≥ 500；
 * - 门槛 2：最近 200 次带 `subgraph_nodes` 埋点的查询平均节点数 ≥ 20；
 * - 不达标给出 `reason`/`current`/`required`（密度保留一位小数）；
 * - 没有埋点的查询不算 0（不拉低密度），但空库判密度 0 且不达标。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/app/cli/index.js';
import { dataPaths, loadConfig } from '../../src/app/config.js';
import { ensureDataDirs } from '../../src/app/lifecycle.js';
import { checkGatGate, enforceGatGate, evaluateGatGate } from '../../src/core/ops/gate.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertQueryLog } from '../../src/infra/sqlite/queryLogRepo.js';
import { insertSampleOnce } from '../../src/infra/sqlite/trainingSampleRepo.js';

const opened: Db[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-gate-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addSamples(db: Db, n: number, source: 'adjudication' | 'feedback' = 'adjudication'): void {
  for (let i = 0; i < n; i += 1) {
    insertSampleOnce(db, {
      id: `ts_${source}_${i}`,
      queryId: null,
      factIds: ['f1'],
      labelKind: 'overturn',
      label: i % 2,
      source,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
  }
}

function addQuery(db: Db, id: string, ts: string, subgraphNodes: number | null): void {
  insertQueryLog(db, {
    id,
    ts,
    queryText: 'q',
    queryHash: id,
    route: 'global',
    flags: {},
    latencyMs: 1,
    stageMs: subgraphNodes === null ? { route: 1 } : { route: 1, subgraph_nodes: subgraphNodes },
  });
}

describe('evaluateGatGate（纯判定）', () => {
  it('双门槛都达标 → ok', () => {
    const r = evaluateGatGate({ samples: 500, avgSubgraphNodes: 20, observedQueries: 200, window: 200 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.density.current).toBe(20);
  });

  it('非循环样本不足 → reason=samples', () => {
    const r = evaluateGatGate({ samples: 499, avgSubgraphNodes: 30, observedQueries: 200, window: 200 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('samples');
    expect(r.current).toBe(499);
    expect(r.required).toBe(500);
  });

  it('密度不足 → reason=density，current 截断到两位小数', () => {
    const r = evaluateGatGate({ samples: 600, avgSubgraphNodes: 8.34, observedQueries: 200, window: 200 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('density');
    expect(r.current).toBe(8.34);
    expect(r.required).toBe(20);
  });

  it('判定用原始均值：19.96 四舍五入到 20 也必须不达标', () => {
    const r = evaluateGatGate({ samples: 600, avgSubgraphNodes: 19.96, observedQueries: 200, window: 200 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('density');
    // 展示值截断，不会出现 current=20 却 ok:false 的自相矛盾
    expect(r.current).toBe(19.96);
    expect(evaluateGatGate({ samples: 600, avgSubgraphNodes: 19.995, observedQueries: 200, window: 200 }).ok).toBe(false);
    expect(evaluateGatGate({ samples: 600, avgSubgraphNodes: 19.99, observedQueries: 200, window: 200 }).current).toBe(19.99);
    expect(evaluateGatGate({ samples: 600, avgSubgraphNodes: 20, observedQueries: 200, window: 200 }).ok).toBe(true);
  });

  it('没有带埋点的查询 → 密度按 0 判不达标', () => {
    const r = evaluateGatGate({ samples: 600, avgSubgraphNodes: null, observedQueries: 0, window: 200 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('density');
    expect(r.current).toBe(0);
    expect(r.density.observed).toBe(0);
  });
});

describe('checkGatGate（连库读数）', () => {
  it('空库 → samples 不达标', () => {
    const r = checkGatGate(freshDb());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('samples');
    expect(r.density.current).toBe(0);
  });

  it('500 个非循环样本 + 200 条 30 节点的查询 → ok', () => {
    const db = freshDb();
    addSamples(db, 500);
    for (let i = 0; i < 200; i += 1) {
      addQuery(db, `q${i}`, `2026-11-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, 30);
    }
    const r = checkGatGate(db);
    expect(r.ok).toBe(true);
    expect(r.samples.current).toBe(500);
    expect(r.density.current).toBe(30);
    expect(r.density.observed).toBe(200);
  });

  it('feedback 样本不计入门槛 1；无埋点查询不计入密度', () => {
    const db = freshDb();
    addSamples(db, 499, 'adjudication');
    addSamples(db, 100, 'feedback');
    addQuery(db, 'q1', '2026-11-01T00:00:00.000Z', null);
    const r = checkGatGate(db);
    expect(r.samples.current).toBe(499);
    expect(r.density.observed).toBe(0);
  });

  it('只取最近 200 条：更早的小子图查询被窗口排除', () => {
    const db = freshDb();
    addSamples(db, 500);
    for (let i = 0; i < 50; i += 1) {
      addQuery(db, `old${i}`, `2026-10-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, 5);
    }
    for (let i = 0; i < 200; i += 1) {
      addQuery(db, `new${i}`, `2026-11-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, 30);
    }
    const r = checkGatGate(db);
    expect(r.density.current).toBe(30);
    expect(r.density.observed).toBe(200);
    expect(r.ok).toBe(true);
  });
});

describe('moshi eval gate（CLI 读数与退出码）', () => {
  it('空 home → 输出 JSON、退出 1（不建库）', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-gate-cli-'));
    homes.push(home);
    let out = '';
    let err = '';
    const code = await runCli(['eval', 'gate'], {
      home,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    });
    expect(err).toBe('');
    expect(code).toBe(1);
    const r = JSON.parse(out.trim());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('samples');
    expect(r.density.observed).toBe(0);
  });

  it('达标库 → 退出 0', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-gate-cli-'));
    homes.push(home);
    const paths = ensureDataDirs(loadConfig({ home }));
    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });
      addSamples(db, 500);
      for (let i = 0; i < 200; i += 1) {
        addQuery(db, `q${i}`, `2026-11-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, 25);
      }
    } finally {
      closeDb(db);
    }
    let out = '';
    const code = await runCli(['eval', 'gate'], {
      home,
      stdout: (s) => {
        out += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    const r = JSON.parse(out.trim());
    expect(r.ok).toBe(true);
    expect(r.density.current).toBe(25);
    expect(dataPaths(loadConfig({ home })).db).toBe(paths.db);
  });
});

describe('enforceGatGate（daemon 启动门禁，P3-09 验收后修复）', () => {
  it('off 不读数、不拒绝', () => {
    const r = enforceGatGate('off', freshDb());
    expect(r).toEqual({ mode: 'off', refused: false });
  });

  it('shadow 不达标 → 有效模式压回 off 并带上读数', () => {
    const r = enforceGatGate('shadow', freshDb());
    expect(r.mode).toBe('off');
    expect(r.refused).toBe(true);
    expect(r.gate?.reason).toBe('samples');
  });

  it('on 达标 → 保持 on', () => {
    const db = freshDb();
    addSamples(db, 500);
    for (let i = 0; i < 200; i += 1) {
      addQuery(db, `q${i}`, `2026-11-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, 20);
    }
    expect(enforceGatGate('on', db)).toEqual({ mode: 'on', refused: false });
  });
});

describe('moshi eval gate（读取失败路径）', () => {
  it('未迁移的空库 → 退出 2 且给出原因', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-gate-cli-'));
    homes.push(home);
    const paths = ensureDataDirs(loadConfig({ home }));
    openDb({ file: paths.db }).db.close();
    let err = '';
    const code = await runCli(['eval', 'gate'], {
      home,
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
    });
    expect(code).toBe(2);
    expect(err).toContain('gate 读取失败');
  });
});
