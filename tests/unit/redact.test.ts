import { describe, expect, it } from 'vitest';
import { valueHash } from '../../src/domain/hash.js';
import {
  isRedacted,
  mergeHits,
  REDACTED,
  redactText,
  redactValue,
} from '../../src/core/write/redact.js';
import { REDACT_CASES } from '../fixtures/redact-cases.js';

describe('脱敏：八条规则（详设 §1.6）', () => {
  for (const c of REDACT_CASES) {
    it(`${c.name}`, () => {
      const r = redactText(c.input, { privateIp: c.privateIp === true });
      expect(r.text).toBe(c.expected);
      expect(r.text).not.toContain(c.forbidden);
      expect(r.changed).toBe(true);
      expect(r.hits.map((h) => h.rule)).toContain(c.rule);
    });
  }
});

describe('脱敏：顺序', () => {
  it('私钥块先于通用赋值——块里的 password= 不会把块头吃掉', () => {
    const input = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'password=not-a-real-key',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const r = redactText(input);
    expect(r.text).toBe(REDACTED.privateKey);
    expect(r.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    // 只命中私钥一条；如果顺序反了，这里会同时出现 generic_assign
    expect(r.hits).toEqual([{ rule: 'private_key', count: 1 }]);
  });

  it('块被截断（只有 BEGIN 没有 END）也从 BEGIN 抹到结尾', () => {
    const input = 'before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nrest-of-text';
    const r = redactText(input);
    expect(r.text).toBe(`before\n${REDACTED.privateKey}`);
    expect(r.hits.map((h) => h.rule)).toContain('private_key_truncated');
  });

  it('JSON 风格的键值对也抹，且不破坏引号结构', () => {
    const r = redactText('{"password":"p@ss","api_key":"abc123"}');
    expect(r.text).toBe('{"password":"<REDACTED>","api_key":"<REDACTED>"}');
  });
});

describe('脱敏：幂等（§5.10 每批都会重跑）', () => {
  it('第二次不再变化、也不再计命中', () => {
    const once = redactText(REDACT_CASES[4]!.input);
    const twice = redactText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.hits).toEqual([]);
    expect(twice.changed).toBe(false);
  });

  it('全量 fixture 都幂等', () => {
    for (const c of REDACT_CASES) {
      const once = redactText(c.input, { privateIp: c.privateIp === true });
      const twice = redactText(once.text, { privateIp: c.privateIp === true });
      expect(twice.text).toBe(once.text);
    }
  });
});

describe('脱敏：开关与默认值', () => {
  it('enabled=false 原样返回', () => {
    const input = 'password: "hunter2"';
    expect(redactText(input, { enabled: false }).text).toBe(input);
  });

  it('内网 IP 默认不抹（§1.6「可选，默认关」）', () => {
    const input = 'psql -h 192.168.1.42';
    expect(redactText(input).text).toBe(input);
    expect(redactText(input, { privateIp: true }).text).toBe(`psql -h ${REDACTED.privateIp}`);
  });

  it('Windows 用户路径', () => {
    const r = redactText('copy C:\\Users\\john\\AppData\\x.txt');
    expect(r.text).toBe('copy C:\\Users\\<USER>\\AppData\\x.txt');
  });

  it('空串不报错', () => {
    expect(redactText('')).toEqual({ text: '', hits: [], changed: false });
  });
});

describe('脱敏：对象遍历与哈希', () => {
  it('递归抹字符串值，不动键名', () => {
    const attrs = {
      frozen: { subject: 'node', predicate: 'token', value: 'abc' },
      ext: { raw_excerpt: 'password=hunter2', argv: ['lsof', 'token: abcdefghijklmnop'] },
    };
    const out = redactValue(attrs);
    expect(out.ext.raw_excerpt).toBe('password=<REDACTED>');
    expect(out.ext.argv[1]).toBe('token: <REDACTED>');
    // 键名与结构不变
    expect(Object.keys(out.frozen)).toEqual(['subject', 'predicate', 'value']);
    expect(out.frozen.predicate).toBe('token');
  });

  it('同一秘密两次观测得到同一个 value_hash（哈希在脱敏之后算）', () => {
    const a = redactValue({ api_key: 'sk-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const b = redactValue({ api_key: 'sk-bbbbbbbbbbbbbbbbbbbbbbbb' });
    expect(a).toEqual(b);
    expect(valueHash(a)).toBe(valueHash(b));
  });

  it('未脱敏时两个不同秘密的哈希不同（对照组）', () => {
    const a = { api_key: 'sk-aaaaaaaaaaaaaaaaaaaaaaaa' };
    const b = { api_key: 'sk-bbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(valueHash(a)).not.toBe(valueHash(b));
  });

  it('isRedacted 认得所有占位符', () => {
    expect(isRedacted('<REDACTED>')).toBe(true);
    expect(isRedacted('<REDACTED:API_KEY>')).toBe(true);
    expect(isRedacted('<USER>')).toBe(true);
    expect(isRedacted('hunter2')).toBe(false);
  });

  it('mergeHits 按规则累加', () => {
    const merged = mergeHits(
      [{ rule: 'openai_key', count: 2 }],
      [
        { rule: 'openai_key', count: 1 },
        { rule: 'bearer', count: 3 },
      ],
    );
    expect(merged).toEqual([
      { rule: 'openai_key', count: 3 },
      { rule: 'bearer', count: 3 },
    ]);
  });
});
