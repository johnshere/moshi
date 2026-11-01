import { describe, expect, it } from 'vitest';
import { main, parseMode, VERSION } from '../../src/app/main.js';

describe('app/main 入口', () => {
  it('无参数默认 daemon', () => {
    expect(parseMode([])).toBe('daemon');
  });

  it('识别 version', () => {
    expect(parseMode(['--version'])).toBe('version');
    expect(main(['--version'])).toBe(0);
  });

  it('未知模式返回码 2', () => {
    expect(() => parseMode(['nope'])).toThrow(/unknown mode/);
    expect(main(['nope'])).toBe(2);
  });

  it('版本号与 package.json 一致', async () => {
    const pkg = (await import('../../package.json', { with: { type: 'json' } })) as {
      default: { version: string };
    };
    expect(VERSION).toBe(pkg.default.version);
  });
});
