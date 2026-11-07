/**
 * P3-11 入包集合差异率（详设 §11.2 / 综述 §15.7）。
 *
 * 验收口径：
 * - `rate = 1 - |on ∩ off| / K`，K 取实际入包条数（两组不同时取较大者）；
 * - 集合语义：重复 id 去重；两组都空记 0；
 * - 逐题对齐：两组条数不一致直接报错，不把错位算成差异；
 * - 同一批题跑两组（`--flags gat=on,gat=off`）可算出总体差异率与逐题明细。
 */
import { describe, expect, it } from 'vitest';
import {
  comparePacks,
  formatPackDiff,
  packDiffRows,
  PACK_DIFF_THRESHOLD,
  summarizePackDiff,
} from '../../src/core/ops/pack-diff.js';
import { runGoldenSet } from '../../src/core/ops/eval.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../../src/app/cli/index.js';
import { orderedGatModes, parseGatFlags } from '../../src/app/cli/commands/eval.js';
import type { EvalPackView } from '../../src/core/ops/eval.js';

describe('comparePacks', () => {
  it('完全相同 → 0；完全不相交 → 1', () => {
    expect(comparePacks(['a', 'b'], ['a', 'b']).rate).toBe(0);
    const disjoint = comparePacks(['a', 'b'], ['c', 'd']);
    expect(disjoint.overlap).toBe(0);
    expect(disjoint.rate).toBe(1);
  });

  it('两组条数不同：K 取较大者，rate 对称且落在 [0,1]', () => {
    const ab = comparePacks(['a', 'b', 'c'], ['b', 'c']);
    expect(ab.kOn).toBe(3);
    expect(ab.kOff).toBe(2);
    expect(ab.k).toBe(3);
    expect(ab.rate).toBeCloseTo(1 / 3);
    // 对称：交换两组结果不变
    expect(comparePacks(['b', 'c'], ['a', 'b', 'c']).rate).toBeCloseTo(1 / 3);
  });

  it('重复 id 按集合去重；两组都空记 0（不除零）', () => {
    const dup = comparePacks(['a', 'a', 'b'], ['a', 'b']);
    expect(dup.kOn).toBe(2);
    expect(dup.rate).toBe(0);
    expect(comparePacks([], []).rate).toBe(0);
  });
});

describe('packDiffRows / summarizePackDiff', () => {
  it('逐题对齐；条数不一致直接报错', () => {
    const rows = packDiffRows(['g1', 'g2'], [['a'], ['b', 'c']], [['a'], ['b']]);
    expect(rows.map((r) => r.id)).toEqual(['g1', 'g2']);
    expect(rows[0]!.rate).toBe(0);
    expect(rows[1]!.rate).toBe(0.5);
    expect(() => packDiffRows(['g1'], [['a']], [])).toThrow(/条数不一致/);
  });

  it('总体取逐题平均；阈值 5% 严格大于才算达标', () => {
    const pass = summarizePackDiff(packDiffRows(['g1'], [['a', 'b', 'c']], [['a', 'b']]));
    expect(pass.meanRate).toBeCloseTo(1 / 3);
    expect(pass.pass).toBe(true);

    const mixed = summarizePackDiff(
      packDiffRows(['g1', 'g2'], [['a', 'b', 'c'], ['x']], [['a', 'b', 'c'], ['x', 'y']]),
    );
    // g1 差异 0，g2 差异 0.5 → 平均 0.25
    expect(mixed.meanRate).toBeCloseTo(0.25);

    const letters = 'abcdefghijklmnopqrstu'.split(''); // 21 个
    const below = summarizePackDiff(
      packDiffRows(['g1'], [letters], [letters.slice(0, 20).concat('z')]),
    );
    // 交集 20 / K 21 ≈ 4.76% < 5%
    expect(below.meanRate).toBeCloseTo(1 / 21);
    expect(below.threshold).toBe(PACK_DIFF_THRESHOLD);
    expect(below.pass).toBe(false);
  });

  it('报告：总体一行 + 只列有差异的题，给出达标结论', () => {
    const rows = packDiffRows(['g1', 'g2'], [['a', 'b'], ['c', 'd']], [['a', 'b'], ['c', 'e']]);
    const text = formatPackDiff(rows, summarizePackDiff(rows));
    expect(text).toContain('入包差异率');
    expect(text).toContain('达标');
    expect(text).not.toContain('g1');
    expect(text).toContain('g2 on=2 off=2 交集 1 差异 50.0%');
  });
});

describe('parseGatFlags（--flags 参数）', () => {
  it('接受成对的 gat=off/on（顺序不限）', () => {
    expect(parseGatFlags('gat=on,gat=off')).toEqual(['on', 'off']);
    expect(parseGatFlags('gat=off,gat=shadow')).toEqual(['off', 'shadow']);
  });

  it('拒绝：缺 off、重复档位、非法值、非 gat 键', () => {
    expect(parseGatFlags('gat=on')).toBeNull();
    expect(parseGatFlags('gat=on,gat=on')).toBeNull();
    expect(parseGatFlags('gat=off,gat=auto')).toBeNull();
    expect(parseGatFlags('vector=on,gat=off')).toBeNull();
    expect(parseGatFlags('')).toBeNull();
  });
});

describe('同一批题跑两组（指标与判题组合）', () => {
  it('runGoldenSet 两组结果能对齐成差异率', async () => {
    const items = [
      { id: 'g1', type: 'single_hop' as const, query: 'q1', expect_facts: ['a'] },
      { id: 'g2', type: 'single_hop' as const, query: 'q2', expect_facts: ['c'] },
    ];
    const pack = (ids: string[]): EvalPackView => ({
      evidence: ids.map((fact_id) => ({ fact_id })),
      numbered_list: ids.join('\n'),
      dependency_summary: [],
      confidence_summary: 'high',
    });
    const collect = async (packs: EvalPackView[]) => {
      const out: string[][] = [];
      const query = async (_q: string) => {
        const p = packs[out.length]!;
        out.push(p.evidence.map((e) => e.fact_id));
        return p;
      };
      const result = await runGoldenSet(items, query);
      return { result, out };
    };

    const on = await collect([pack(['a', 'b']), pack(['c', 'd'])]);
    const off = await collect([pack(['a']), pack(['c'])]);
    expect(on.result.passed).toBe(2);
    expect(off.result.passed).toBe(2);

    const rows = packDiffRows(
      items.map((i) => i.id),
      on.out,
      off.out,
    );
    // g1: 交集 1 / K 2 = 0.5；g2 同理 → 平均 0.5
    expect(summarizePackDiff(rows).meanRate).toBeCloseTo(0.5);
  });
});

describe('CLI 分支（runCli 级）', () => {
  it('orderedGatModes 固定 off 在前', () => {
    expect(orderedGatModes(['on', 'off'])).toEqual(['off', 'on']);
    expect(orderedGatModes(['off', 'shadow'])).toEqual(['off', 'shadow']);
  });

  it('--flags 与 --in-place 互斥 → 退出 2', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-p311-'));
    try {
      let err = '';
      const code = await runCli(['eval', 'run', '--flags', 'gat=on,gat=off', '--in-place'], {
        home,
        stdout: () => {},
        stderr: (s) => {
          err += s;
        },
      });
      expect(code).toBe(2);
      expect(err).toContain('不能与 --in-place');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--flags 缺值 → 退出 2（不能静默退回普通评估）', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-p311-'));
    try {
      let err = '';
      const code = await runCli(['eval', 'run', '--flags'], {
        home,
        stdout: () => {},
        stderr: (s) => {
          err += s;
        },
      });
      expect(code).toBe(2);
      expect(err).toContain('--flags 需要');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
