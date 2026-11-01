import { describe, expect, it } from 'vitest';
import {
  isKnownNormalizer,
  normalizePath,
  normalizePkg,
  normalizePort,
  normalizePredicate,
  normalizeProcess,
  normalizeSubject,
  normalizeVersion,
} from '../../src/core/parse/normalizers.js';

describe('normalizePort（详设 §5.4）', () => {
  it.each([
    ['8080', 'port:8080'],
    [':8080', 'port:8080'],
    ['  8080  ', 'port:8080'],
    [8080, 'port:8080'],
    ['1', 'port:1'],
    ['65535', 'port:65535'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePort(input)).toBe(expected);
  });

  it.each([['0'], ['65536'], ['abc'], ['8080.5'], ['-1'], ['']])('非法 %s → null', (input) => {
    expect(normalizePort(input)).toBeNull();
  });

  it('前导零归一（同一个端口只能有一个 key）', () => {
    expect(normalizePort('08080')).toBe('port:8080');
  });
});

describe('normalizePkg', () => {
  it.each([
    ['node', 'pkg:node'],
    ['Node.js', 'pkg:node'],
    ['nodejs', 'pkg:node'],
    ['NODE', 'pkg:node'],
    ['py', 'pkg:python'],
    ['python3', 'pkg:python'],
    ['golang', 'pkg:go'],
    ['postgres', 'pkg:postgresql'],
    ['lodash', 'pkg:lodash'],
    ['@types/node', 'pkg:@types/node'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePkg(input)).toBe(expected);
  });

  it('空串 → null', () => {
    expect(normalizePkg('   ')).toBeNull();
  });

  it('大小写与分隔符不产生第二个 key', () => {
    expect(normalizePkg('Node.js')).toBe(normalizePkg('nodejs'));
    expect(normalizePkg('NODE')).toBe(normalizePkg('node'));
  });
});

describe('normalizePath', () => {
  it.each([
    ['~/a//b/../c/', '~/a/c'],
    ['~/a/b/', '~/a/b'],
    ['~', '~'],
    ['/usr//local/bin/', '/usr/local/bin'],
    ['./a/./b', 'a/b'],
    ['a/b/../c', 'a/c'],
    ['/../a', '/a'],
    ['~/../x', '~/x'],
    ['C:\\Users\\john\\x', 'c:/Users/john/x'],
    ['~/a\\b', '~/a/b'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it('相对路径的 .. 保留（不能凭空吃掉）', () => {
    expect(normalizePath('../a')).toBe('../a');
    expect(normalizePath('a/../../b')).toBe('../b');
  });

  it('纯词法：不存在的路径也能规范化（不碰文件系统）', () => {
    expect(normalizePath('/definitely/not/exist/../x')).toBe('/definitely/not/x');
  });

  it('空串 → null', () => {
    expect(normalizePath('  ')).toBeNull();
  });
});

describe('normalizeVersion', () => {
  it.each([
    ['v22.9.0', '22.9.0'],
    ['22.9', '22.9'],
    ['22.9.0', '22.9.0'],
    ['v1.2.3-beta.1', '1.2.3'],
    ['1.2.3+build5', '1.2.3'],
    ['  v22.9.0  ', '22.9.0'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeVersion(input)).toBe(expected);
  });

  it.each([['22'], ['abc'], ['v'], ['1.2.3.4']])('非法 %s → null', (input) => {
    expect(normalizeVersion(input)).toBeNull();
  });
});

describe('normalizeProcess', () => {
  it('取 basename 并去 .exe', () => {
    expect(normalizeProcess('/usr/bin/node')).toBe('node');
    expect(normalizeProcess('C:\\Program Files\\nodejs\\node.exe')).toBe('node');
    expect(normalizeProcess('node')).toBe('node');
    expect(normalizeProcess('  nginx  ')).toBe('nginx');
  });

  it('空串 → null', () => {
    expect(normalizeProcess('')).toBeNull();
    expect(normalizeProcess('/usr/bin/')).toBeNull();
  });
});

describe('normalizePredicate', () => {
  it.each([
    ['Installed Version', 'installed_version'],
    ['occupied  by', 'occupied_by'],
    ['is-active', 'isactive'],
    ['  UPPER_case  ', 'upper_case'],
    ['a__b', 'a_b'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePredicate(input)).toBe(expected);
  });

  it('纯符号 → null', () => {
    expect(normalizePredicate('---')).toBeNull();
    expect(normalizePredicate('')).toBeNull();
  });
});

describe('normalizeSubject 分派', () => {
  it('已知 kind 走对应规范化器', () => {
    expect(normalizeSubject('Node.js', 'pkg')).toBe('pkg:node');
    expect(normalizeSubject(':8080', 'port')).toBe('port:8080');
  });

  it('未知 kind 只去空白，不丢原文（service / concept / unknown）', () => {
    expect(normalizeSubject('  nginx service  ', 'service')).toBe('nginx service');
    expect(normalizeSubject('   ', 'unknown')).toBeNull();
  });

  it('isKnownNormalizer 判定', () => {
    expect(isKnownNormalizer('pkg')).toBe(true);
    expect(isKnownNormalizer('service')).toBe(false);
  });
});
