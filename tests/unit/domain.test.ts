import { describe, expect, it } from 'vitest';
import { isMoshiError } from '../../src/domain/errors.js';
import { canonicalJson, canonicalKey, sha256Hex, shortHash, valueHash } from '../../src/domain/hash.js';
import { ID_PREFIX, isId, newId, parseId } from '../../src/domain/ids.js';
import {
  assertFeatureSafe,
  assertFeatureWhitelist,
  assertProbability,
  LIFECYCLE_FIELDS,
} from '../../src/domain/invariants.js';
import { addDays, compareTs, formatLocal, isTs, nowIso, parseTs } from '../../src/domain/time.js';
import { EPISTEMIC, isFeatureEligible, isReturnable } from '../../src/domain/enums.js';

describe('canonicalJson（详设 §1.3 五条规则）', () => {
  it('键按 UTF-16 序排序，无空白', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('中文原样输出，不转成 \\u 转义', () => {
    expect(canonicalJson({ 名: '默识' })).toBe('{"名":"默识"}');
    expect(canonicalJson('端口 8080 被 nginx 占用')).toBe('"端口 8080 被 nginx 占用"');
  });

  it('数字规范化：整数不带 .0、-0 归一为 0、浮点用原生 toString', () => {
    expect(canonicalJson(2)).toBe('2');
    expect(canonicalJson(2.0)).toBe('2');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004');
  });

  it('数组保序，对象内数组元素也规范化', () => {
    expect(canonicalJson([3, { b: 1, a: 2 }, null])).toBe('[3,{"a":2,"b":1},null]');
  });

  it('只转义必要字符', () => {
    expect(canonicalJson('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it('不可序列化的值一律抛错，不静默丢弃', () => {
    for (const bad of [undefined, () => 1, Symbol('s'), 10n, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => canonicalJson(bad)).toThrow();
    }
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });

  it('Date / Map / 类实例不是纯对象，抛错', () => {
    expect(() => canonicalJson(new Date())).toThrow();
    expect(() => canonicalJson(new Map())).toThrow();
    class Foo {
      x = 1;
    }
    expect(() => canonicalJson(new Foo())).toThrow();
  });

  it('错误里带出位置，便于定位是哪个字段不可序列化', () => {
    try {
      canonicalJson({ a: { b: [1, undefined] } });
      throw new Error('should throw');
    } catch (err) {
      expect(isMoshiError(err)).toBe(true);
      expect((err as Error).message).toContain('a.b[1]');
    }
  });

  it('Object.create(null) 也接受', () => {
    const o = Object.create(null) as Record<string, number>;
    o['k'] = 1;
    expect(canonicalJson(o)).toBe('{"k":1}');
  });

  it('键序不同的等价对象哈希相同', () => {
    expect(valueHash({ a: 1, b: 2 })).toBe(valueHash({ b: 2, a: 1 }));
  });
});

describe('哈希与身份键（详设 §1.3）', () => {
  it('sha256Hex 对齐已知向量', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('shortHash 取前 n 位', () => {
    expect(shortHash('abc', 8)).toBe('ba7816bf');
    expect(shortHash('abc')).toHaveLength(32);
  });

  it('canonical_key 带格式版本前缀，且三段都影响结果', () => {
    const base = canonicalKey('global', 'en_1', 'port.occupied_by');
    expect(base.startsWith('ck1:')).toBe(true);
    expect(base).toHaveLength(4 + 32);
    expect(canonicalKey('repo', 'en_1', 'port.occupied_by')).not.toBe(base);
    expect(canonicalKey('global', 'en_2', 'port.occupied_by')).not.toBe(base);
    expect(canonicalKey('global', 'en_1', 'port.free')).not.toBe(base);
  });

  it('分隔符防拼接歧义：a|bc 与 ab|c 不撞', () => {
    expect(canonicalKey('global', 'en_ab', 'c')).not.toBe(canonicalKey('global', 'en_a', 'bc'));
  });

  it('value_hash 带 vh1 前缀', () => {
    expect(valueHash({ port: 8080 }).startsWith('vh1:')).toBe(true);
  });
});

describe('标识符（详设 §1.1）', () => {
  it('前缀正确且 ULID 为 26 位小写', () => {
    for (const kind of Object.keys(ID_PREFIX) as (keyof typeof ID_PREFIX)[]) {
      const id = newId(kind);
      expect(id.startsWith(`${ID_PREFIX[kind]}_`)).toBe(true);
      expect(id.slice(id.indexOf('_') + 1)).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    }
  });

  it('同毫秒内单调递增（批量写入排序稳定）', () => {
    const ids = Array.from({ length: 50 }, () => newId('fact'));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('parseId 往返一致，类型不匹配判假', () => {
    const id = newId('edge');
    expect(parseId(id)?.kind).toBe('edge');
    expect(isId('edge', id)).toBe(true);
    expect(isId('fact', id)).toBe(false);
    expect(parseId('nope_01j9z3k2m4n5p6q7r8s9t0ab')).toBeNull();
    expect(parseId('f_short')).toBeNull();
  });
});

describe('时间（详设 §1.2）', () => {
  it('nowIso 恒为 24 位 UTC', () => {
    const s = nowIso();
    expect(s).toHaveLength(24);
    expect(s.endsWith('Z')).toBe(true);
    expect(isTs(s)).toBe(true);
  });

  it('字符串比较即时间比较', () => {
    expect(compareTs('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z')).toBe(-1);
    expect('2026-01-01T00:00:00.000Z' < '2026-01-01T00:00:00.001Z').toBe(true);
  });

  it('非法输入抛 E_INPUT（唯一解析入口）', () => {
    for (const bad of ['2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01 00:00:00.000Z', 'abc']) {
      try {
        parseTs(bad);
        throw new Error('should throw');
      } catch (err) {
        expect(isMoshiError(err)).toBe(true);
        expect((err as { code: string }).code).toBe('E_INPUT');
      }
    }
  });

  it('addDays 保持格式', () => {
    expect(addDays('2026-01-01T00:00:00.000Z', 2)).toBe('2026-01-03T00:00:00.000Z');
  });

  it('formatLocal 输出本地时间且可读', () => {
    const s = formatLocal('2026-11-01T03:00:00.000Z');
    expect(s).toContain('2026');
    expect(s.length).toBeGreaterThan(10);
  });
});

describe('不变量（概设 §5.2 红线）', () => {
  it('7 个生命周期字段逐个命中即抛错', () => {
    const samples: Record<string, unknown>[] = [
      { strength: 0.5 },
      { pool: 'utility' },
      { access_count: 1 },
      { last_access_at: nowIso() },
      { archive_meta: {} },
      { layout: { x: 1 } },
      { community_summary: { derived_at: nowIso() } },
    ];
    expect(samples).toHaveLength(LIFECYCLE_FIELDS.length);
    for (const s of samples) expect(() => assertFeatureSafe(s)).toThrow(/生命周期字段/);
  });

  it('嵌套位置也能抓到', () => {
    expect(() => assertFeatureSafe({ node: { meta: { strength: 1 } } })).toThrow(/node\.meta\.strength/);
    expect(() => assertFeatureSafe({ list: [{ pool: 'utility' }] })).toThrow(/list\[0\]\.pool/);
  });

  it('值为 undefined 也算命中（防止传空对象绕过）', () => {
    expect(() => assertFeatureSafe({ strength: undefined })).toThrow();
  });

  it('合法特征不报错', () => {
    expect(() =>
      assertFeatureSafe({
        embedding: [0.1, 0.2],
        ftype: 'semantic',
        confidence: 0.9,
        importance: 0.5,
        epistemic_status: 'active',
        degree: 3,
      }),
    ).not.toThrow();
  });

  it('白名单外字段被拒绝', () => {
    expect(() => assertFeatureWhitelist({ embedding: [1], secret_extra: 1 })).toThrow(/白名单/);
    expect(() => assertFeatureWhitelist({ confidence: 0.5 })).not.toThrow();
  });

  it('概率越界拒绝', () => {
    expect(() => assertProbability('p', 1.2)).toThrow();
    expect(() => assertProbability('p', -0.1)).toThrow();
    expect(assertProbability('p', 0.5)).toBe(0.5);
  });
});

describe('epistemic 语义（D8）', () => {
  it('返回规则与特征规则是两件事', () => {
    expect(isReturnable('active', false)).toBe(true);
    expect(isReturnable('disputed', false)).toBe(true);
    expect(isReturnable('archived', false)).toBe(false);
    expect(isReturnable('archived', true)).toBe(true);
    expect(isReturnable('invalidated', false)).toBe(false);
    expect(isReturnable('pruned', true)).toBe(false);

    expect(isFeatureEligible('active')).toBe(true);
    expect(isFeatureEligible('disputed')).toBe(true);
    expect(isFeatureEligible('archived')).toBe(false);
    expect(isFeatureEligible('pruned')).toBe(false);
  });

  it('枚举值齐全', () => {
    expect([...EPISTEMIC]).toEqual(['active', 'archived', 'invalidated', 'pruned', 'disputed']);
  });
});
