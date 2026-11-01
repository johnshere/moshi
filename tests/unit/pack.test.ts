/**
 * P1-09 预算装箱单测（详设 §6.8）。
 *
 * 验收：B=1500/utilB=1050/floorB=450；floor 先满足 2 条；floor 未用满借给 util
 * （反向不可）；总量不超 B；estimateTokens 口径（cjk×1+ascii/3.2）；
 * 单条超 80 token 截断到首句且不改 content。
 */
import { describe, expect, it } from 'vitest';
import type { Fact } from '../../src/domain/types.js';
import { packFacts, estimateTokens, truncateToFirstSentence } from '../../src/core/read/pack.js';
import type { AdjudicatedFact } from '../../src/core/read/adjudicate.js';

function fact(id: string, content: string, pool: 'value_floor' | 'utility' = 'utility'): Fact {
  return {
    id, content, ftype: 'semantic', confidence: 0.9, confidenceSource: 'tool_obs',
    strength: 0.5, importance: 0.5, pool, epistemicStatus: 'active',
    attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: id }, ext: {} },
    canonicalKey: `ck_${id}`, valueHash: `vh_${id}`, scope: 'global', supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z', validTo: null, recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: null, degree: 0, accessCount: 0, lastAccessAt: null, lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: null, span: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function adj(f: Fact, score: number): AdjudicatedFact {
  return { fact: f, finalScore: score, flags: [], disputedBy: null };
}

describe('预算装箱（P1-09）', () => {
  it('estimateTokens：CJK 1 token/字，ascii /3.2，向上取整', () => {
    expect(estimateTokens('系统运行正常')).toBe(6); // 6 CJK
    expect(estimateTokens('node v22 版本')).toBe(Math.ceil(2 + 9 / 3.2)); // 2 CJK + 9 ascii
    expect(estimateTokens('')).toBe(0);
  });

  it('floor 先满足 2 条，再按 score×1.15 贪心', () => {
    const floor1 = adj(fact('f1', '甲乙丙丁戊己庚辛壬癸', 'value_floor'), 0.4);
    const floor2 = adj(fact('f2', '一二三四五六七八九十', 'value_floor'), 0.3);
    const floor3 = adj(fact('f3', '子丑寅卯辰巳午未申酉', 'value_floor'), 0.2);
    const res = packFacts([floor3, floor2, floor1], { floorBudget: 450, utilBudget: 1050 });
    // 3 条 floor 都进（30 token < 450）
    expect(res.items.filter((i) => i.pool === 'value_floor').length).toBe(3);
    expect(res.floorTokens).toBe(30);
  });

  it('floor 未用满 → 预算借给 util；总量不超 B', () => {
    const floor1 = adj(fact('f1', '甲', 'value_floor'), 0.4);
    // util 13 条各 80 token（'x'.repeat(256) → 256/3.2=80，恰好 cap）
    const utils = Array.from({ length: 13 }, (_, i) => adj(fact(`u${i}`, 'x'.repeat(256), 'utility'), 0.9 - i * 0.01));
    const res = packFacts([floor1, ...utils], { budget: 1500, utilBudget: 1050, floorBudget: 450 });
    // util 预算 = 1050 + (450-1) = 1499；13×80=1040 → 全进
    expect(res.utilTokens).toBe(1040);
    expect(res.floorTokens).toBe(1);
    expect(res.totalTokens).toBe(1041);
    expect(res.totalTokens).toBeLessThanOrEqual(1500);
  });

  it('floor 用满时借出极少（50），util 停在 1040 装不下第 14 条', () => {
    const floors = Array.from({ length: 5 }, (_, i) => adj(fact(`f${i}`, 'x'.repeat(320), 'value_floor'), 0.5));
    const utils = Array.from({ length: 14 }, (_, i) => adj(fact(`u${i}`, 'x'.repeat(256), 'utility'), 0.8 - i * 0.01));
    const res = packFacts([...floors, ...utils], { budget: 1500, utilBudget: 1050, floorBudget: 450 });
    // floor 5×80=400；util 预算 = 1050 + 50 = 1100；14×80=1120 超 → 13 条
    expect(res.floorTokens).toBe(400);
    expect(res.utilTokens).toBe(1040);
    expect(res.items.filter((i) => i.pool === 'utility').length).toBe(13);
    expect(res.totalTokens).toBeLessThanOrEqual(1500);
  });

  it('单条超 80 token 截断到首句，且不改 fact.content 本体', () => {
    const long = adj(fact('fL', `${'好'.repeat(100)}。${'后'.repeat(100)}`, 'utility'), 0.9);
    const res = packFacts([long]);
    const item = res.items[0]!;
    expect(item.tokens).toBe(80);
    expect(item.packedText.endsWith('…')).toBe(true);
    expect(item.fact.content.length).toBe(201); // 100+1+100，本体未截
    expect(truncateToFirstSentence('第一句。第二句')).toBe('第一句。…');
  });

  it('floor_min=2：floor 候选只有 1 条时也只进 1 条', () => {
    const floor1 = adj(fact('f1', '甲', 'value_floor'), 0.4);
    const res = packFacts([floor1]);
    expect(res.items.filter((i) => i.pool === 'value_floor').length).toBe(1);
    expect(res.floorTokens).toBe(1);
  });
});
