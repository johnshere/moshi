import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../fixtures/factories.js';
import {
  clipContent,
  controlCharRatio,
  DEFAULT_QUARANTINE,
  detectStorm,
  enqueue,
  isSerializable,
  listOpen,
  resolve,
  safeJson,
  screen,
  stats,
} from '../../src/core/write/quarantine.js';

const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-quar-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

describe('content 截断（§5.3：只留前两句 + …）', () => {
  it('未超上限原样返回', () => {
    const r = clipContent('node 装了 22.9.0。', 2048);
    expect(r).toEqual({ text: 'node 装了 22.9.0。', truncated: false, overflow: false });
  });

  it('超上限时保留前两句', () => {
    const s1 = `${'甲'.repeat(300)}。`;
    const s2 = `${'乙'.repeat(300)}。`;
    const s3 = `${'丙'.repeat(300)}。`;
    const r = clipContent(s1 + s2 + s3, 2048);
    expect(r.truncated).toBe(true);
    expect(r.overflow).toBe(false);
    expect(r.text).toBe(`${s1}${s2}…`);
  });

  it('整段没有句末标点 → 截断后仍超，报 overflow', () => {
    const r = clipContent('a'.repeat(3000), 2048);
    expect(r.truncated).toBe(true);
    expect(r.overflow).toBe(true);
  });

  it('英文句号只在词尾算句末（node.js 不会被劈开）', () => {
    const r = clipContent(`${'x'.repeat(1200)} node.js 很好用. ${'y'.repeat(1200)}. ${'z'.repeat(1200)}.`, 2048);
    expect(r.text).toContain('node.js 很好用.');
    expect(r.text.endsWith('…')).toBe(true);
  });
});

describe('控制字符占比', () => {
  it('\\t \\n \\r 不算控制字符', () => {
    expect(controlCharRatio('a\tb\nc\rd')).toBe(0);
  });

  it('二进制味的内容比例很高', () => {
    expect(controlCharRatio(`\u0000\u0001\u0002\u0003\u0004abcde`)).toBeCloseTo(0.5, 5);
  });

  it('空串为 0（不除零）', () => {
    expect(controlCharRatio('')).toBe(0);
  });
});

describe('screen：五个判据（§5.9）', () => {
  it('正常条目放行', () => {
    const r = screen({ content: 'node 装了 22.9.0', value: '22.9.0', confidence: 0.95 });
    expect(r).toMatchObject({ accepted: true, reason: null, truncated: false });
  });

  it('低置信进隔离区', () => {
    const r = screen({ content: 'node 可能装了 22', value: '22', confidence: 0.2 });
    expect(r.reason).toBe('low_confidence');
  });

  it('取值不可 canonicalJson', () => {
    const r = screen({ content: 'x', value: { fn: () => 1 }, confidence: 0.9 });
    expect(r.reason).toBe('unserializable');
  });

  it('控制字符超 5%', () => {
    const r = screen({ content: '\u0001\u0002\u0003\u0004\u0005abcdefghij', value: 'x', confidence: 0.9 });
    expect(r.reason).toBe('binary_like');
  });

  it('超长且截断后仍超', () => {
    const r = screen({ content: 'a'.repeat(3000), value: 'x', confidence: 0.9 });
    expect(r.reason).toBe('too_long');
  });

  it('超长但截断后不超 → 放行且 content 已截断', () => {
    const content = `${'甲'.repeat(300)}。${'乙'.repeat(300)}。${'丙'.repeat(300)}。`;
    const r = screen({ content, value: 'x', confidence: 0.9 });
    expect(r.accepted).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.content.endsWith('…')).toBe(true);
  });

  it('既乱码又低置信时报结构性原因（binary_like），不报 low_confidence', () => {
    const r = screen({ content: '\u0001\u0002\u0003\u0004\u0005abcdefghij', value: 'x', confidence: 0.1 });
    expect(r.reason).toBe('binary_like');
  });

  it('阈值可调：0.3 置信在默认 0.25 下放行', () => {
    expect(screen({ content: 'x', value: 1, confidence: 0.3 }).accepted).toBe(true);
    expect(
      screen({ content: 'x', value: 1, confidence: 0.3 }, { ...DEFAULT_QUARANTINE, minConfidence: 0.4 })
        .reason,
    ).toBe('low_confidence');
  });

  it('isSerializable 与 canonicalJson 口径一致', () => {
    expect(isSerializable({ a: 1 })).toBe(true);
    expect(isSerializable({ a: undefined })).toBe(false);
    expect(isSerializable({ a: 1n })).toBe(false);
    expect(isSerializable([1, 2, 3])).toBe(true);
  });
});

describe('mutex_storm（§5.9 最后一行）', () => {
  const opts = DEFAULT_QUARANTINE;
  const key = 'ck1:storm';

  it('50 个不同取值不报，51 个报', () => {
    const db = freshDb();
    for (let i = 0; i < 51; i += 1) {
      insertFact(db, { canonicalKey: key, valueHash: `vh1:${String(i)}`, value: i });
    }
    expect(detectStorm(db, { canonicalKey: key, scope: 'global' }, { ...opts, stormThreshold: 50 })).toBe(
      true,
    );
    expect(detectStorm(db, { canonicalKey: key, scope: 'global' }, { ...opts, stormThreshold: 51 })).toBe(
      false,
    );
  });

  it('同一取值重复 500 次不算 storm（数的是不同取值）', () => {
    const db = freshDb();
    for (let i = 0; i < 500; i += 1) {
      // 唯一索引只约束活跃行，历史行可以同 key 同 value
      insertFact(db, {
        canonicalKey: key,
        valueHash: 'vh1:same',
        validAt: '2026-01-01T00:00:00.000Z',
        validTo: '2026-01-02T00:00:00.000Z',
      });
    }
    expect(detectStorm(db, { canonicalKey: key, scope: 'global' }, opts)).toBe(false);
  });

  it('窗口外的不计', () => {
    const db = freshDb();
    insertFact(db, { canonicalKey: key, valueHash: 'vh1:a', value: 'a' });
    // 把窗口压到 0，刚写入的行也在窗口外
    expect(detectStorm(db, { canonicalKey: key, scope: 'global' }, { ...opts, stormWindowMs: 0 })).toBe(
      false,
    );
  });
});

describe('隔离区落库与人工处理', () => {
  it('入队 → 列表 → 接受 → 再处理报错', () => {
    const db = freshDb();
    const id = enqueue(db, 'low_confidence', {
      content: 'node 可能装了 22',
      value: '22',
      confidence: 0.2,
      subject: 'node',
      predicate: 'installed_version',
    });

    const open = listOpen(db);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(id);
    expect(open[0]!.reason).toBe('low_confidence');
    expect(JSON.parse(open[0]!.payloadJson)).toMatchObject({
      reason: 'low_confidence',
      content: 'node 可能装了 22',
      confidence: 0.2,
    });
    expect(stats(db)).toMatchObject({ open: 1, byReason: { low_confidence: 1 } });

    resolve(db, id, 'accepted');
    expect(listOpen(db)).toHaveLength(0);
    expect(stats(db).open).toBe(0);
    expect(() => resolve(db, id, 'dropped')).toThrow(/已处理|不存在/);
  });

  it('不存在的 id 报 E_INPUT', () => {
    const db = freshDb();
    expect(() => resolve(db, 'qa_01j9z3k2m4n5p6q7r8s9t0ab', 'dropped')).toThrow(/不存在/);
  });

  it('safeJson 对不可序列化的 payload 也不抛', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(() => JSON.parse(safeJson({ fn: () => 1, big: 1n, circular }))).not.toThrow();
    const parsed = JSON.parse(safeJson({ fn: () => 1, big: 1n, circular })) as Record<string, unknown>;
    expect(parsed['fn']).toBe('[Function]');
    expect(parsed['big']).toBe('1n');
    expect((parsed['circular'] as Record<string, unknown>)['self']).toBe('[Circular]');
  });

  it('unserializable 的条目能落进隔离区（不因 payload 再炸一次）', () => {
    const db = freshDb();
    expect(() =>
      enqueue(db, 'unserializable', { content: 'x', value: { fn: () => 1 }, confidence: 0.9 }),
    ).not.toThrow();
    expect(listOpen(db)).toHaveLength(1);
  });
});
