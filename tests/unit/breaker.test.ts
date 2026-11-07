/**
 * P3-10 熔断（详设 §7.7）。
 *
 * 验收口径：
 * - 连续 100 次同分（每次打分的平均 δ 相同）→ 塌缩熔断，`on → shadow`；
 * - 熔断后 `mode()` 永远返回熔断档位，只有 `reset()`（人工）恢复；
 * - 延迟：3 分钟窗口 P95 > 80ms 且持续 3 分钟才触发；样本不足、门槛以下不触发；
 * - 崩溃：sidecar 判失败 → 直接 `off`；
 * - `scoreWithBreaker` 把打分喂给熔断，降级时不喂 δ、按 sidecar 失败信号补崩溃。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMemoryQuery } from '../../src/app/mcp/query.js';
import { loadConfig } from '../../src/app/config.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { insertFact } from '../fixtures/factories.js';
import {
  Breaker,
  BREAKER_COLLAPSE_WINDOW,
  BREAKER_P95_LIMIT_MS,
  type BreakerTrip,
} from '../../src/core/read/breaker.js';
import { scoreWithBreaker } from '../../src/app/mcp/deps.js';
import type { ModelScoreFn, ModelScoreOutcome } from '../../src/core/read/search.js';
import type { MoshiSubgraphPayload } from '../../src/domain/subgraph.js';

function score(delta: number): { fact_id: string; delta: number; overturn_prob: number } {
  return { fact_id: 'f1', delta, overturn_prob: 0.1 };
}

const PAYLOAD = { nodes: [], edges: [] } as unknown as MoshiSubgraphPayload;

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('塌缩与人工恢复', () => {
  it('连续 100 次同分 → on→shadow，之后只有 reset() 恢复', () => {
    const trips: BreakerTrip[] = [];
    const b = new Breaker({ onTrip: (t) => trips.push(t) });
    for (let i = 0; i < BREAKER_COLLAPSE_WINDOW; i += 1) b.recordScore([score(0.05)], 1);
    expect(b.current()?.reason).toBe('collapse');
    expect(b.current()?.to).toBe('shadow');
    expect(trips).toHaveLength(1);
    expect(b.mode('on')).toBe('shadow');
    expect(b.mode('shadow')).toBe('shadow');
    expect(b.mode('off')).toBe('off');

    // 熔断后继续打分不会重复告警，也不会自己恢复
    b.recordScore([score(0.9)], 1);
    expect(trips).toHaveLength(1);
    expect(b.mode('on')).toBe('shadow');

    b.reset();
    expect(b.current()).toBeNull();
    expect(b.mode('on')).toBe('on');
  });

  it('分数有起伏 → 不熔断', () => {
    const b = new Breaker();
    for (let i = 0; i < BREAKER_COLLAPSE_WINDOW; i += 1) {
      b.recordScore([score(i % 2 === 0 ? -0.1 : 0.1)], 1);
    }
    expect(b.current()).toBeNull();
  });
});

describe('延迟触发', () => {
  it('P95 > 80ms 持续 3 分钟才熔断', () => {
    let now = 0;
    const b = new Breaker({ now: () => now });
    let trippedAt: number | null = null;
    for (let t = 0; t <= 400_000; t += 5_000) {
      now = t;
      b.recordScore([score(t / 1e6)], 100);
      if (b.current() !== null) {
        trippedAt = t;
        break;
      }
    }
    expect(b.current()?.reason).toBe('latency');
    expect(b.current()?.to).toBe('shadow');
    // 至少 20 个样本后开始计时，再满 3 分钟
    expect(trippedAt).toBeGreaterThanOrEqual(95_000 + 180_000);
  });

  it('P95 未超 80ms → 永不熔断', () => {
    let now = 0;
    const b = new Breaker({ now: () => now });
    for (let t = 0; t <= 600_000; t += 5_000) {
      now = t;
      b.recordScore([score(t / 1e6)], BREAKER_P95_LIMIT_MS);
    }
    expect(b.current()).toBeNull();
  });

  it('样本不足 20 个 → 不熔断', () => {
    let now = 0;
    const b = new Breaker({ now: () => now });
    for (let t = 0; t <= 240_000; t += 60_000) {
      now = t;
      b.recordScore([score(t / 1e6)], 500);
    }
    expect(b.current()).toBeNull();
  });
});

describe('崩溃触发', () => {
  it('sidecar 判失败 → on→off', () => {
    const trips: BreakerTrip[] = [];
    const b = new Breaker({ onTrip: (t) => trips.push(t) });
    b.recordSidecarFailure();
    expect(b.current()).toEqual({ reason: 'crash', at: expect.any(Number), to: 'off' });
    expect(trips[0]?.reason).toBe('crash');
    expect(b.mode('on')).toBe('off');
    expect(b.mode('shadow')).toBe('off');
  });
});

describe('scoreWithBreaker（deps 接线）', () => {
  const ok: ModelScoreOutcome = {
    scores: [score(0.05)],
    modelVersion: 'gat-v1@test',
    degraded: [],
  };

  it('成功打分喂给熔断：100 次同分即塌缩', async () => {
    const b = new Breaker();
    const fn: ModelScoreFn = async () => ok;
    const wrapped = scoreWithBreaker(fn, b);
    for (let i = 0; i < BREAKER_COLLAPSE_WINDOW; i += 1) await wrapped(PAYLOAD);
    expect(b.current()?.reason).toBe('collapse');
  });

  it('降级 + sidecar 失败 → 崩溃熔断；sidecar 正常则不动', async () => {
    const degraded: ModelScoreOutcome = { scores: null, modelVersion: null, degraded: ['no_sidecar'] };
    const failing = new Breaker();
    await scoreWithBreaker(async () => degraded, failing, () => true)(PAYLOAD);
    expect(failing.current()?.reason).toBe('crash');

    const healthy = new Breaker();
    await scoreWithBreaker(async () => degraded, healthy, () => false)(PAYLOAD);
    expect(healthy.current()).toBeNull();
  });

  it('透传原结果，不吞降级', async () => {
    const degraded: ModelScoreOutcome = { scores: null, modelVersion: null, degraded: ['timeout'] };
    const b = new Breaker();
    const out = await scoreWithBreaker(vi.fn(async () => degraded), b)(PAYLOAD);
    expect(out).toBe(degraded);
  });
});

describe('延迟窗口边界与重新计时（验收后修复）', () => {
  it('恰好 3 分钟前的样本被裁掉，不会被拼进新一段', () => {
    let now = 0;
    const b = new Breaker({ now: () => now });
    for (let t = 0; t < 20; t += 1) b.recordScore([score(0)], 100);
    // 同一毫秒注入的 20 个样本在 t=180s 必须全部过期
    now = 180_000;
    b.recordScore([score(0.1)], 100);
    expect(b.current()).toBeNull();
  });

  it('p95 回落后重新计时：两段慢查询不会被拼成一次熔断', () => {
    let now = 0;
    const b = new Breaker({ now: () => now });
    for (let t = 0; t <= 95_000; t += 5_000) {
      now = t;
      b.recordScore([score(t / 1e6)], 100);
    }
    expect(b.current()).toBeNull();
    // 空窗 3 分钟以上：旧样本全被裁掉、样本不足 → hotSince 清零
    now = 400_000;
    b.recordScore([score(0.2)], 5);
    expect(b.current()).toBeNull();
    // 第二段要重新凑满 20 个样本后再持续 3 分钟
    let trippedAt: number | null = null;
    for (let t = 405_000; t <= 900_000; t += 5_000) {
      now = t;
      b.recordScore([score(t / 1e6)], 100);
      if (b.current() !== null) {
        trippedAt = t;
        break;
      }
    }
    expect(b.current()?.reason).toBe('latency');
    expect(trippedAt).toBeGreaterThanOrEqual(405_000 + 95_000 + 180_000 - 5_000);
  });
});

describe('降级也计入延迟样本（D2 修复）', () => {
  it('超时/降级的一次 /score 也喂延迟窗口', async () => {
    const b = new Breaker();
    const spy = vi.spyOn(b, 'recordScore');
    const degraded: ModelScoreOutcome = { scores: null, modelVersion: null, degraded: ['timeout'] };
    await scoreWithBreaker(async () => degraded, b)(PAYLOAD);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual([]);
    expect(spy.mock.calls[0]![1]).toBeGreaterThanOrEqual(0);
  });
});

describe('query 生效档位（D5 覆盖）', () => {
  it('熔断后 cfg 仍是 on，但查询快照记 off', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moshi-breaker-'));
    dirs.push(dir);
    const { db } = openDb({ file: path.join(dir, 'moshi.db') });
    opened.push(db);
    migrate(db, { backupsDir: path.join(dir, 'backups') });
    insertFact(db, { content: 'alpha one' });
    syncMissingFts(db);

    const cfg = loadConfig({ home: dir });
    cfg.model.gat_mode = 'on';
    const breaker = new Breaker();
    breaker.recordSidecarFailure(); // on → off
    const scoreFn: ModelScoreFn = async () => ({
      scores: [{ fact_id: 'x', delta: 0.1, overturn_prob: 0.1 }],
      modelVersion: 'gat-v1@test',
      degraded: [],
    });

    await runMemoryQuery(
      { db, cfg, breaker, score: scoreFn },
      { query: 'alpha', top_k: 5, scope: 'global', include_history: false, format: 'json' },
    );

    const row = db.prepare('SELECT flags_json AS flags FROM query_log ORDER BY ts DESC LIMIT 1').get() as {
      flags: string;
    };
    expect(JSON.parse(row.flags).gat).toBe('off');
    expect(cfg.model.gat_mode).toBe('on'); // 配置本身不动
  });
});
