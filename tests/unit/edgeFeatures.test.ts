/**
 * P3-00 边特征 16 维单测（详设 §4.5、P3-00 设计/验收）。
 *
 * 覆盖：6 种 etype one-hot、weight/confidence clamp、hop、direction、
 * 保留位 10–15、padding/截断、白名单（禁入字段抛 E_INPUT）、未知 etype，
 * 以及 TS 实现与跨语言 fixture `tests/fixtures/edge-features.json` 的一致性。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ETYPE, type Etype } from '../../src/domain/enums.js';
import { MoshiError } from '../../src/domain/errors.js';
import {
  EDGE_FEAT_DIM,
  EDGE_PAD_MAX,
  EDGE_RESERVED_FROM,
  edgeFeatures,
  edgeFeaturesPadded,
  type EdgeFeatureInput,
} from '../../src/domain/edgeFeatures.js';

const BASE: EdgeFeatureInput = {
  etype: 'depends_on',
  weight: 1.0,
  confidence: 0.5,
  hop: null,
  direction: 0,
};

function withEtype(etype: Etype): EdgeFeatureInput {
  return { ...BASE, etype };
}

function expectEInput(fn: () => unknown, pattern?: RegExp): MoshiError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MoshiError);
  const err = caught as MoshiError;
  expect(err.code).toBe('E_INPUT');
  if (pattern !== undefined) expect(err.message).toMatch(pattern);
  return err;
}

describe('16 维常量与逐维布局', () => {
  it('EDGE_FEAT_DIM=16、EDGE_RESERVED_FROM=10、EDGE_PAD_MAX=192', () => {
    expect(EDGE_FEAT_DIM).toBe(16);
    expect(EDGE_RESERVED_FROM).toBe(10);
    expect(EDGE_PAD_MAX).toBe(192);
  });

  it('6 种 etype 的 one-hot 下标与 ETYPE 顺序一致', () => {
    expect(ETYPE).toEqual([
      'depends_on',
      'logic',
      'mutually_exclusive',
      'co_occur',
      'supersedes',
      'derived_from',
    ]);
    for (const [index, etype] of ETYPE.entries()) {
      const feature = edgeFeatures(withEtype(etype));
      expect(feature).toHaveLength(EDGE_FEAT_DIM);
      expect(feature.slice(0, ETYPE.length)).toEqual(ETYPE.map((e) => (e === etype ? 1 : 0)));
      expect(feature.slice(0, ETYPE.length)).toHaveLength(6);
      // 明确钉住下标，防止 ETYPE 顺序漂移时测试跟着漂
      expect(feature[index]).toBe(1);
      expect(feature.slice(0, ETYPE.length).reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  it('weight 在 6、confidence 在 7、hop 在 8、direction 在 9', () => {
    const feature = edgeFeatures({ ...BASE, weight: 0.25, confidence: 0.75, hop: 2, direction: 1 });
    expect(feature[6]).toBe(0.25);
    expect(feature[7]).toBe(0.75);
    expect(feature[8]).toBe(1.0);
    expect(feature[9]).toBe(1);
  });

  it('10–15 保留位对每种 etype 都恒 0', () => {
    for (const etype of ETYPE) {
      const reserved = edgeFeatures({
        ...withEtype(etype),
        weight: 1,
        confidence: 1,
        hop: 2,
        direction: -1,
      }).slice(EDGE_RESERVED_FROM);
      expect(reserved).toEqual([0, 0, 0, 0, 0, 0]);
      expect(reserved).toHaveLength(EDGE_FEAT_DIM - EDGE_RESERVED_FROM);
    }
  });
});

describe('weight / confidence clamp 到 [0,1]', () => {
  it.each([
    [-0.5, 0],
    [0, 0],
    [0.42, 0.42],
    [1, 1],
    [1.5, 1],
  ])('weight=%s → %s', (input, expected) => {
    expect(edgeFeatures({ ...BASE, weight: input })[6]).toBe(expected);
  });

  it.each([
    [-0.5, 0],
    [0, 0],
    [0.42, 0.42],
    [1, 1],
    [1.5, 1],
  ])('confidence=%s → %s', (input, expected) => {
    expect(edgeFeatures({ ...BASE, confidence: input })[7]).toBe(expected);
  });

  it('NaN / Infinity 不是可 clamp 的值，明确抛 E_INPUT', () => {
    expectEInput(() => edgeFeatures({ ...BASE, weight: Number.NaN }), /weight/);
    expectEInput(() => edgeFeatures({ ...BASE, confidence: Number.POSITIVE_INFINITY }), /confidence/);
  });
});

describe('hop 归一化', () => {
  it('1 跳 → 0.5，2 跳 → 1.0，null → 0', () => {
    expect(edgeFeatures({ ...BASE, hop: 1 })[8]).toBe(0.5);
    expect(edgeFeatures({ ...BASE, hop: 2 })[8]).toBe(1.0);
    expect(edgeFeatures({ ...BASE, hop: null })[8]).toBe(0);
  });

  it('非法 hop 抛 E_INPUT', () => {
    expectEInput(
      () => edgeFeatures({ ...BASE, hop: 3 as unknown as EdgeFeatureInput['hop'] }),
      /hop/,
    );
  });
});

describe('direction', () => {
  it('src→dst +1、逆序 −1、无向 0', () => {
    expect(edgeFeatures({ ...BASE, direction: 1 })[9]).toBe(1);
    expect(edgeFeatures({ ...BASE, direction: -1 })[9]).toBe(-1);
    expect(edgeFeatures({ ...BASE, direction: 0 })[9]).toBe(0);
  });

  it('非法 direction 抛 E_INPUT', () => {
    expectEInput(
      () => edgeFeatures({ ...BASE, direction: 2 as unknown as EdgeFeatureInput['direction'] }),
      /direction/,
    );
  });
});

describe('etype 白名单', () => {
  it('未知 etype 抛 E_INPUT 并带出原值', () => {
    const err = expectEInput(
      () => edgeFeatures({ ...BASE, etype: 'unknown_edge' as Etype }),
      /未知 etype/,
    );
    expect(err.detail).toEqual({ etype: 'unknown_edge' });
  });
});

describe('字段白名单（禁入生命周期/治理字段）', () => {
  const forbidden: ReadonlyArray<readonly [string, unknown]> = [
    ['strength', 0.9],
    ['pool', 'utility'],
    ['access_count', 7],
    ['last_access_at', '2026-11-07T00:00:00Z'],
    ['archive_meta', { derived_at: '2026-11-07T00:00:00Z' }],
    ['layout', { x: 1, y: 2 }],
    ['community_summary', { derived_at: '2026-11-07T00:00:00Z' }],
  ];

  it.each(forbidden)('多传 %s 抛 E_INPUT', (field, value) => {
    const dirty = { ...BASE, [field]: value } as unknown as EdgeFeatureInput;
    const err = expectEInput(() => edgeFeatures(dirty), new RegExp(field));
    expect(err.detail).toEqual({ field });
  });

  it('只允许 etype/weight/confidence/hop/direction 五个字段', () => {
    // 合法入参不抛错，且 16 维完整
    const feature = edgeFeatures(BASE);
    expect(feature).toHaveLength(16);
    expect(feature[0]).toBe(1);
    expect(feature[6]).toBe(1);
    // 干净入参的 key 集合就是白名单
    expect(Object.keys(BASE).sort()).toEqual(['confidence', 'direction', 'etype', 'hop', 'weight']);
  });
});

describe('padding 到 192 与截断', () => {
  it('空边 → 192 行 × 16 维全 0', () => {
    const rows = edgeFeaturesPadded([]);
    expect(rows).toHaveLength(EDGE_PAD_MAX);
    expect(rows).toHaveLength(192);
    for (const row of rows) {
      expect(row).toHaveLength(EDGE_FEAT_DIM);
      expect(row).toEqual(new Array<number>(16).fill(0));
    }
  });

  it('1 条边 → 首行等于 edgeFeatures，其余行全 0', () => {
    const edge: EdgeFeatureInput = {
      ...BASE,
      etype: 'supersedes',
      weight: 0.6,
      confidence: 0.8,
      hop: 2,
      direction: -1,
    };
    const rows = edgeFeaturesPadded([edge]);
    expect(rows).toHaveLength(192);
    expect(rows[0]).toEqual(edgeFeatures(edge));
    for (const row of rows.slice(1)) expect(row).toEqual(new Array<number>(16).fill(0));
  });

  it('超过 192 条截断为前 192 条', () => {
    const many: EdgeFeatureInput[] = Array.from({ length: 200 }, (_, i) => ({
      ...BASE,
      weight: i / 200,
      confidence: (i + 1) / 200,
    }));
    const rows = edgeFeaturesPadded(many);
    expect(rows).toHaveLength(192);
    expect(rows[0]![6]).toBe(0);
    expect(rows[1]![6]).toBeCloseTo(1 / 200, 10);
    expect(rows[191]![7]).toBeCloseTo(192 / 200, 10);
    expect(rows[191]![6]).toBeCloseTo(191 / 200, 10);
  });

  it('显式 maxEdges 生效；0 返回空数组', () => {
    expect(edgeFeaturesPadded([BASE], 4)).toHaveLength(4);
    expect(edgeFeaturesPadded([BASE], 0)).toEqual([]);
  });

  it('非法 maxEdges 抛 E_INPUT', () => {
    expectEInput(() => edgeFeaturesPadded([BASE], -1), /maxEdges/);
    expectEInput(() => edgeFeaturesPadded([BASE], 1.5), /maxEdges/);
  });
});

describe('跨语言契约 fixture（tests/fixtures/edge-features.json）', () => {
  interface Fixture {
    schema: string;
    dim: number;
    max_edges: number;
    edges: Array<{ input: EdgeFeatureInput; expected: number[] }>;
  }

  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/edge-features.json', import.meta.url), 'utf8'),
  ) as Fixture;

  it('fixture 元数据与 TS 常量一致', () => {
    expect(fixture.schema).toBe('moshi-edge-features/1');
    expect(fixture.dim).toBe(EDGE_FEAT_DIM);
    expect(fixture.max_edges).toBe(EDGE_PAD_MAX);
    expect(fixture.edges).toHaveLength(2);
  });

  it('fixture 的 expected 行由 TS 实现逐维复现', () => {
    for (const edge of fixture.edges) {
      expect(edge.expected).toHaveLength(EDGE_FEAT_DIM);
      expect(edgeFeatures(edge.input)).toEqual(edge.expected);
    }
  });

  it('fixture 2 条边 padding 到 192 行后首两行保留、其余全 0', () => {
    const rows = edgeFeaturesPadded(fixture.edges.map((e) => e.input));
    expect(rows).toHaveLength(192);
    expect(rows.slice(0, 2)).toEqual(fixture.edges.map((e) => e.expected));
    for (const row of rows.slice(2)) expect(row).toEqual(new Array<number>(16).fill(0));
  });
});
