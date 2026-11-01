/**
 * P1-06 RRF 融合与两个信号单测（详设 §6.5）。
 *
 * 验收：归一化到 [0,1]（0.25 实体加成不会淹没在原始 RRF 里）；
 * 实体信号 +0.25×confidence；时序 now/past/range 取值表；
 * clamp [0,1.5]；三路去重后排序。
 */
import { describe, expect, it } from 'vitest';
import type { Fact } from '../../src/domain/types.js';
import { fuseRank, recencyScore, detectTimeKind } from '../../src/core/read/fuse.js';
import type { RecognizedEntity } from '../../src/core/read/recognize.js';

function fact(id: string, opts: { validAt?: string; validTo?: string | null; subjEnt?: string } = {}): Fact {
  return {
    id,
    content: `content ${id}`,
    ftype: 'semantic',
    confidence: 0.9,
    confidenceSource: 'tool_obs',
    strength: 0.5,
    importance: 0.5,
    pool: 'utility',
    epistemicStatus: 'active',
    attrs: {
      frozen: { subject: { entity_id: opts.subjEnt ?? `en_${id}`, name: id }, predicate: 'state', value: id },
      ext: {},
    },
    canonicalKey: `ck_${id}`,
    valueHash: `vh_${id}`,
    scope: 'global',
    supersededBy: null,
    validAt: opts.validAt ?? '2026-10-01T00:00:00.000Z',
    validTo: opts.validTo ?? null,
    recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: null,
    degree: 0,
    accessCount: 0,
    lastAccessAt: null,
    lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: null,
    span: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function toMap(fs: Fact[]): Map<string, Fact> {
  return new Map(fs.map((f) => [f.id, f]));
}

describe('RRF 融合（P1-06）', () => {
  it('归一化到 [0,1]：单路单命中 rrf=1，实体加成不会被量级淹没', () => {
    const f = fact('f1');
    const out = fuseRank({ vector: { ids: ['f1'] } }, toMap([f]), { entities: [], query: 'x' });
    expect(out.length).toBe(1);
    expect(out[0]!.rrf).toBe(1); // 只有一路一个候选 → 归一化后为 1
    expect(out[0]!.final).toBe(1); // clamp 上限
  });

  it('三路同一 fact 累加且排序正确', () => {
    const a = fact('fa');
    const b = fact('fb');
    const out = fuseRank(
      { vector: { ids: ['fa', 'fb'] }, bm25: { ids: ['fb'] } },
      toMap([a, b]),
      { entities: [], query: 'x' },
    );
    // fb 两路命中（1/61 + 1/62）> fa 一路（1/61）
    expect(out[0]!.fact_id).toBe('fb');
    expect(out[0]!.rrf).toBeGreaterThan(out[1]!.rrf);
    expect(out[0]!.rrf).toBeLessThanOrEqual(1);
  });

  it('实体信号：subject.entity_id 命中 → +0.25×confidence', () => {
    const f = fact('f1', { subjEnt: 'en_8080' });
    const ents: RecognizedEntity[] = [
      { entity_id: 'en_8080', name: '8080', etype: 'port', matched_text: '8080', span: [0, 4], confidence: 0.8 },
    ];
    const out = fuseRank({ vector: { ids: ['f1'] } }, toMap([f]), { entities: ents, query: '8080' });
    expect(out[0]!.entity_bonus).toBeCloseTo(0.2);
    expect(out[0]!.final).toBeCloseTo(1.2);
  });

  it('clamp [0,1.5]：多信号叠加不越界', () => {
    const f = fact('f1', { subjEnt: 'en_x' });
    const ents: RecognizedEntity[] = [
      { entity_id: 'en_x', name: 'x', etype: 'pkg', matched_text: 'x', span: [0, 1], confidence: 1.0 },
    ];
    const out = fuseRank({ vector: { ids: ['f1'] }, bm25: { ids: ['f1'] }, ppr: { ids: ['f1'] } }, toMap([f]), {
      entities: ents,
      query: '当前 x',
    });
    // rrf=1 + 0.25 + 0.2 = 1.45，不越界
    expect(out[0]!.final).toBeCloseTo(1.45);
    expect(out[0]!.final).toBeLessThanOrEqual(1.5);
  });
});

describe('recencyScore 取值表（P1-06）', () => {
  const active = fact('f1', { validAt: '2026-10-01T00:00:00.000Z', validTo: null });
  const closed = fact('f2', { validAt: '2026-09-01T00:00:00.000Z', validTo: '2026-09-30T00:00:00.000Z' });

  it('now 词：active=1.0，closed=0.15', () => {
    expect(recencyScore(active, 'now', '现在', new Date())).toBe(1.0);
    expect(recencyScore(closed, 'now', '当前', new Date())).toBe(0.15);
  });

  it('past 词：closed=1.0，active=0.4', () => {
    expect(recencyScore(closed, 'past', '以前', new Date())).toBe(1.0);
    expect(recencyScore(active, 'past', '之前', new Date())).toBe(0.4);
  });

  it('无时间词 = 0', () => {
    expect(recencyScore(active, 'none', 'node 版本', new Date())).toBe(0);
  });

  it('range 区间重叠 overlap/union', () => {
    // fact 有效 09-01~09-30，查询单日 2026-09-10：交集 1 天（该日在区间内）/ union 30 天
    const s = recencyScore(closed, 'range', '2026-09-10 的服务', new Date('2026-11-01T00:00:00Z'));
    expect(s).toBeCloseTo(1 / 30);
    // 查询 2026-08（月粒度展开为 08-01~08-31）与 fact 无交集 → 0
    expect(recencyScore(closed, 'range', '2026-08 的服务', new Date('2026-11-01T00:00:00Z'))).toBe(0);
  });

  it('detectTimeKind 优先级：now > past > range > none', () => {
    expect(detectTimeKind('现在看看 node')).toBe('now');
    expect(detectTimeKind('上次的 node 版本')).toBe('past');
    expect(detectTimeKind('2026-09-10 的服务')).toBe('range');
    expect(detectTimeKind('node 版本')).toBe('none');
  });
});
