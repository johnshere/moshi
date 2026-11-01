import { describe, expect, it } from 'vitest';
import { main, parseMode, VERSION } from '../../src/app/main.js';

describe('app/main 入口', () => {
  it('无参数默认 daemon', () => {
    expect(parseMode([])).toBe('daemon');
  });

  it('识别 version', async () => {
    expect(parseMode(['--version'])).toBe('version');
    expect(await main(['--version'])).toBe(0);
  });

  it('未知命令走 CLI 并返回码 2', async () => {
    expect(parseMode(['nope'])).toBe('cli');
    expect(await main(['nope'])).toBe(2);
  });

  it('--help 打印用法并返回 0', async () => {
    expect(parseMode(['--help'])).toBe('cli');
    expect(await main(['--help'])).toBe(0);
  });

  it('版本号与 package.json 一致', async () => {
    const pkg = (await import('../../package.json', { with: { type: 'json' } })) as {
      default: { version: string };
    };
    expect(VERSION).toBe(pkg.default.version);
  });
});
