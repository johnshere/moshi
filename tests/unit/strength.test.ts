/**
 * P2-08 强度方程与惰性衰减（详设 §8.1 / 概设 §5.5.1）。
 *
 * 四类断言：
 * 1. 纯方程形态（adopt 饱和增量 / reject 乘性 / validate 下限 / 衰减到半衰期 / 失效归零）；
 * 2. 数值纪律（clamp 0..1、负 dt 不增不减、4 位小数）；
 * 3. 仓储入口的写入阈值（Δ ≤ 1e-3 不写库，`last_decay_at` 不动——这是「读也写库爆 WAL」的闸）；
 * 4. `decayFacts` 批量子集更新。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADOPT_ALPHA,
  applyStrength,
  HALF_LIFE_MS,
  isProcedure,
  REJECT_BETA,
  round4,
  VALIDATE_FLOOR,
} from '../../src/core/lifecycle/strength.js';
import type { Fact } from '../../src/domain/types.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../fixtures/factories.js';

const DAY = 864e5;
/** 测试用的固定「现在」：常量时钟让 14 天/60 天的断言可以手算 */
const NOW = Date.parse('2026-06-01T00:00:00.000Z');

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'moshi-strength-'));
  const opened = openDb({ file: path.join(dir, 'moshi.db') });
  db = opened.db;
  migrate(db, { backupsDir: path.join(dir, 'backups') });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 造一条真事实（走夹具真库，`Fact` 由真实 mapper 产出，不手搓字面量） */
function makeFact(
  opts: {
    strength?: number;
    predicate?: string;
    /** 距今多少天前做过最后一次衰减；负数 = 时钟回拨（lastDecayAt 在未来） */
    daysAgo?: number;
    validTo?: string | null;
  } = {},
): Fact {
  const id = insertFact(db, {
    strength: opts.strength ?? 0.5,
    predicate: opts.predicate ?? 'version',
    lastDecayAt: new Date(NOW - (opts.daysAgo ?? 0) * DAY).toISOString(),
    ...(opts.validTo === undefined ? {} : { validTo: opts.validTo }),
  });
  const fact = factRepo.getFact(db, id);
  if (fact === null) throw new Error('夹具插入的事实读不回来');
  return fact;
}

function lastDecayAtOf(id: string): string {
  const row = db.prepare('SELECT last_decay_at FROM fact WHERE id = ?').get(id) as {
    last_decay_at: string;
  };
  return row.last_decay_at;
}

describe('参数与判定', () => {
  it('占位参数就是概设 §5.5.1 的那四个数', () => {
    expect(ADOPT_ALPHA).toBe(0.15);
    expect(REJECT_BETA).toBe(0.7);
    expect(VALIDATE_FLOOR).toBe(0.6);
    expect(HALF_LIFE_MS.default).toBe(14 * DAY);
    expect(HALF_LIFE_MS.procedure).toBe(60 * DAY);
  });

  it('isProcedure 按谓词前缀判定（procedure: 承载操作流程类事实）', () => {
    expect(isProcedure(makeFact({ predicate: 'procedure:build' }))).toBe(true);
    expect(isProcedure(makeFact({ predicate: 'version' }))).toBe(false);
  });
});

describe('应用事件', () => {
  it('adopt 连续 20 次：单调不减、不越界、趋近 1', () => {
    const fact = makeFact({ strength: 0.5 });
    let s = fact.strength;
    for (let i = 0; i < 20; i += 1) {
      const next = applyStrength({ ...fact, strength: s }, { kind: 'adopt' }, NOW);
      expect(next).toBeGreaterThanOrEqual(s);
      expect(next).toBeLessThanOrEqual(1);
      s = next;
    }
    // 饱和增量：20 次之后 1-(1-0.5)·0.85^20 ≈ 0.9806
    expect(s).toBeGreaterThan(0.95);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('reject：0.8 → 0.56（乘性惩罚）', () => {
    const fact = makeFact({ strength: 0.8 });
    expect(applyStrength(fact, { kind: 'reject' }, NOW)).toBeCloseTo(0.56, 4);
  });

  it('reject 不会把低值压成负数', () => {
    const fact = makeFact({ strength: 0.05 });
    const s = applyStrength(fact, { kind: 'reject' }, NOW);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeCloseTo(0.035, 4);
  });

  it('validate：0.2 → 0.60（设下限，不给加分）', () => {
    const fact = makeFact({ strength: 0.2 });
    expect(applyStrength(fact, { kind: 'validate' }, NOW)).toBeCloseTo(0.6, 4);
  });

  it('validate 不压低已经高于下限的强度', () => {
    const fact = makeFact({ strength: 0.9 });
    expect(applyStrength(fact, { kind: 'validate' }, NOW)).toBeCloseTo(0.9, 4);
  });

  it('none：只衰减', () => {
    const fact = makeFact({ strength: 0.5, daysAgo: 7 });
    // 0.5 · 2^(-7/14) ≈ 0.35355
    expect(applyStrength(fact, { kind: 'none' }, NOW)).toBe(0.3536);
  });

  it('14 天后约减半（普通事实）', () => {
    const fact = makeFact({ strength: 0.5, daysAgo: 14 });
    expect(applyStrength(fact, { kind: 'none' }, NOW)).toBeCloseTo(0.25, 2);
  });

  it('procedure 事实 60 天后才减半', () => {
    const fact = makeFact({ strength: 0.5, predicate: 'procedure:build', daysAgo: 60 });
    expect(applyStrength(fact, { kind: 'none' }, NOW)).toBeCloseTo(0.25, 2);
    // 同样 60 天，普通事实早就接近 0.05
    const plain = makeFact({ strength: 0.5, daysAgo: 60 });
    expect(applyStrength(plain, { kind: 'none' }, NOW)).toBeLessThan(0.06);
  });

  it('validTo 非空 → 强度 0（行保留）', () => {
    const now = Date.now();
    const fact = makeFact({ strength: 0.9, validTo: new Date(now + DAY).toISOString() });
    expect(fact.validTo).not.toBeNull();
    expect(applyStrength(fact, { kind: 'none' }, now)).toBe(0);
  });

  it('负 dt（时钟回拨）不增不减', () => {
    const fact = makeFact({ strength: 0.5, daysAgo: -3 });
    expect(applyStrength(fact, { kind: 'none' }, NOW)).toBeCloseTo(0.5, 4);
  });

  it('结果四舍五入到 4 位小数', () => {
    // 0.4321 · 0.7 = 0.30247 → 0.3025
    expect(applyStrength(makeFact({ strength: 0.4321 }), { kind: 'reject' }, NOW)).toBe(0.3025);
    expect(round4(1 / 3)).toBe(0.3333);
    const s = applyStrength(makeFact({ strength: 0.6123, daysAgo: 3 }), { kind: 'none' }, NOW);
    expect(Math.abs(s * 1e4 - Math.round(s * 1e4))).toBeLessThan(1e-9);
  });
});

describe('仓储入口：写入阈值', () => {
  it('Δ ≤ 1e-3 不写库，last_decay_at 不动', () => {
    // 10 分钟前衰减过：Δ ≈ 1.7e-4，远低于阈值
    const fact = makeFact({ strength: 0.5, daysAgo: 10 / 1440 });
    const before = lastDecayAtOf(fact.id);

    const r = factRepo.applyStrength(db, fact.id, { kind: 'none' }, NOW);

    expect(r.changed).toBe(false);
    expect(r.strength).toBe(0.5); // 没写库，返回的就是库里的旧值
    expect(lastDecayAtOf(fact.id)).toBe(before);
  });

  it('Δ > 1e-3 才写库，且同时推进 last_decay_at', () => {
    // 1 天前衰减过：Δ ≈ 0.024
    const fact = makeFact({ strength: 0.5, daysAgo: 1 });

    const r = factRepo.applyStrength(db, fact.id, { kind: 'none' }, NOW);

    expect(r.changed).toBe(true);
    // 0.5 · 2^(-1/14) ≈ 0.47585 → 0.4758
    expect(r.strength).toBe(0.4758);
    expect(factRepo.getFact(db, fact.id)?.strength).toBeCloseTo(r.strength, 4);
    expect(lastDecayAtOf(fact.id)).toBe(new Date(NOW).toISOString());
  });

  it('adopt / reject 事件经仓储入口落到库里', () => {
    const adopted = makeFact({ strength: 0.2 });
    expect(factRepo.applyStrength(db, adopted.id, { kind: 'adopt' }, NOW).changed).toBe(true);
    expect(factRepo.getFact(db, adopted.id)?.strength).toBeCloseTo(0.32, 4);

    const rejected = makeFact({ strength: 0.8 });
    expect(factRepo.applyStrength(db, rejected.id, { kind: 'reject' }, NOW).changed).toBe(true);
    expect(factRepo.getFact(db, rejected.id)?.strength).toBeCloseTo(0.56, 4);
  });

  it('事实不存在抛 E_NOT_FOUND', () => {
    expect(() => factRepo.applyStrength(db, 'fact_nope', { kind: 'adopt' }, NOW)).toThrowError(
      /fact 不存在/,
    );
  });

  it('失效事实写到 0，但行仍在（不物理删除）', () => {
    const now = Date.now();
    const fact = makeFact({ strength: 0.9, validTo: new Date(now + DAY).toISOString() });
    const total = factRepo.countFacts(db);

    const r = factRepo.applyStrength(db, fact.id, { kind: 'none' }, now);

    expect(r.strength).toBe(0);
    expect(r.changed).toBe(true);
    expect(factRepo.getFact(db, fact.id)?.strength).toBe(0);
    expect(factRepo.countFacts(db)).toBe(total);
  });
});

describe('decayFacts：批量惰性衰减', () => {
  it('只把变了的行写回，返回的数组已带衰减后强度', () => {
    const stale = makeFact({ strength: 0.5, daysAgo: 14 });
    const fresh = makeFact({ strength: 0.5, daysAgo: 0 });
    const freshDecayAt = lastDecayAtOf(fresh.id);

    const out = factRepo.decayFacts(db, [stale, fresh], NOW);

    expect(out).toHaveLength(2);
    expect(out[0]?.strength).toBeCloseTo(0.25, 2); // 已换成衰减后的值
    expect(out[1]?.strength).toBe(0.5); // Δ ≤ 1e-3，视为没变

    expect(factRepo.getFact(db, stale.id)?.strength).toBeCloseTo(0.25, 2);
    expect(lastDecayAtOf(stale.id)).toBe(new Date(NOW).toISOString());
    expect(lastDecayAtOf(fresh.id)).toBe(freshDecayAt); // 没白写
  });

  it('空数组是 no-op', () => {
    expect(factRepo.decayFacts(db, [], NOW)).toEqual([]);
  });
});
