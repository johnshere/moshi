import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn(() => ({ unref: vi.fn() })) }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { launchScript, spawnInstaller } from '../../src/app/update/install.js';

const dirs: string[] = [];

afterEach(() => {
  spawnMock.mockClear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-install-'));
  dirs.push(d);
  return d;
}

describe('spawnInstaller（V-03B）', () => {
  it('用 cmd 静默安装，安装器缺失时抛 E_UPDATE 且不 spawn', () => {
    const missing = path.join(tempDir(), 'nope.exe');
    expect(() => spawnInstaller(missing)).toThrow(/更新包不存在/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('存在安装器时 detached 静默执行', () => {
    const dir = tempDir();
    const installer = path.join(dir, 'moshi-setup-0.2.0.exe');
    // 空文件即可：本用例只验证命令组装，不真的执行安装器
    writeFileSync(installer, '');
    expect(existsSync(installer)).toBe(true);

    spawnInstaller(installer);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { detached?: boolean; stdio?: string; windowsHide?: boolean },
    ];
    expect(cmd).toBe('cmd.exe');
    expect(args[0]).toBe('/d');
    expect(args[1]).toBe('/s');
    expect(args[2]).toBe('/c');
    expect(args[3]).toContain(`"${installer}" /S`);
    // 开发目录没有 launch.vbs 时不应拼重启命令（避免误起安装器）
    if (launchScript() === null) expect(args[3]).not.toContain('wscript');
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
  });
});
