/**
 * 检查器纯函数单测（P2-06，详设 §10.5）。
 *
 * UI 测试环境是 node 无 DOM（组件靠浏览器验收），纯函数在此单测：
 * - `guessExtControl` / `formatExtValue`：attrs.ext 按值猜控件
 * - `lastAuditByField` / `lastModifiedLine`：每个可写项的"上次修改"行
 */
import { describe, expect, it } from 'vitest';
import { guessExtControl, formatExtValue } from '../../src/ui/inspector/pure/attrs.js';
import { lastAuditByField, lastModifiedLine, type AuditView } from '../../src/ui/inspector/pure/lastAudit.js';

describe('guessExtControl（attrs.ext 按值猜控件，详设 §10.5）', () => {
  it('number → 数字框', () => {
    expect(guessExtControl(42)).toEqual({ kind: 'number' });
    expect(guessExtControl(0.5)).toEqual({ kind: 'number' });
  });

  it('boolean → 开关', () => {
    expect(guessExtControl(true)).toEqual({ kind: 'boolean' });
    expect(guessExtControl(false)).toEqual({ kind: 'boolean' });
  });

  it('ISO 时间串 → 日期（含 T / 空格 / Z / 偏移）', () => {
    expect(guessExtControl('2026-11-02')).toEqual({ kind: 'datetime' });
    expect(guessExtControl('2026-11-02T10:30:00Z')).toEqual({ kind: 'datetime' });
    expect(guessExtControl('2026-11-02 10:30:00+08:00')).toEqual({ kind: 'datetime' });
  });

  it('非 ISO 时间形态的字符串（裸年份等）→ 文本框', () => {
    expect(guessExtControl('2026')).toEqual({ kind: 'text' });
    expect(guessExtControl('十一月')).toEqual({ kind: 'text' });
  });

  it('其余字符串 → 文本框', () => {
    expect(guessExtControl('v22.0.0')).toEqual({ kind: 'text' });
    expect(guessExtControl('')).toEqual({ kind: 'text' });
  });

  it('数组 / 对象 → KV 原样（猜不出，不做自定义表单）', () => {
    expect(guessExtControl([1, 2, 3])).toEqual({ kind: 'kv' });
    expect(guessExtControl({ steps: ['a', 'b'] })).toEqual({ kind: 'kv' });
    expect(guessExtControl(null)).toEqual({ kind: 'kv' });
    expect(guessExtControl(undefined)).toEqual({ kind: 'kv' });
  });
});

describe('formatExtValue（只读呈现格式化）', () => {
  it('boolean 显示 开/关', () => {
    expect(formatExtValue(true)).toBe('开');
    expect(formatExtValue(false)).toBe('关');
  });

  it('对象 JSON 化，其余 String()', () => {
    expect(formatExtValue({ a: 1 })).toBe('{"a":1}');
    expect(formatExtValue(0.5)).toBe('0.5');
    expect(formatExtValue('x')).toBe('x');
  });
});

describe('lastAuditByField（每个可写项旁"上次修改"行，详设 §10.5）', () => {
  const audits: AuditView[] = [
    { field: 'confidence', before: '0.5', after: '0.6', source: 'human', ts: '2026-11-01T00:00:00Z' },
    { field: 'strength', before: '0.4', after: '0.5', source: 'human', ts: '2026-11-01T01:00:00Z' },
    // 同一字段的第二次修改：最新一行是它（audits 按 ts ASC，末位 = 最新）
    { field: 'confidence', before: '0.6', after: '0.7', source: 'human', ts: '2026-11-02T00:00:00Z' },
  ];

  it('取该字段的最近一次修改（末位）', () => {
    const last = lastAuditByField(audits, 'confidence');
    expect(last?.after).toBe('0.7');
    expect(last?.ts).toBe('2026-11-02T00:00:00Z');
  });

  it('从未改过的字段返回 null', () => {
    expect(lastAuditByField(audits, 'importance')).toBeNull();
  });

  it('空 audit 列表返回 null', () => {
    expect(lastAuditByField([], 'confidence')).toBeNull();
  });
});

describe('lastModifiedLine（`上次修改：{source} @ {ts}`）', () => {
  it('有 audit 时拼单行', () => {
    const line = lastModifiedLine({ field: 'confidence', before: '0.5', after: '0.6', source: 'human', ts: '2026-11-02T00:00:00Z' });
    expect(line).toBe('上次修改：human @ 2026-11-02T00:00:00Z');
  });

  it('source 缺失时回落 unknown', () => {
    const line = lastModifiedLine({ field: 'confidence', before: null, after: '0.6', source: null, ts: '2026-11-02T00:00:00Z' });
    expect(line).toBe('上次修改：unknown @ 2026-11-02T00:00:00Z');
  });

  it('无 audit 返回 null（从未被人工修改）', () => {
    expect(lastModifiedLine(null)).toBeNull();
  });
});
