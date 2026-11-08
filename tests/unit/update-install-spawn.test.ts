import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnInstaller } from '../../src/app/update/install.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function waitFor(file: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe.runIf(process.platform === 'win32')('spawnInstaller 真实执行（V-03B）', () => {
  it('带空格路径的安装器真的被 cmd 执行', async () => {
    // 目录名带空格，覆盖 %LOCALAPPDATA%\Programs\... 之类的真实形态；
    // spawnInstaller 只检查文件存在，用 .bat 当"安装器"即可验证命令组装。
    const dir = mkdtempSync(path.join(tmpdir(), 'moshi spawn '));
    dirs.push(dir);
    const marker = path.join(dir, 'installed.txt');
    const fakeInstaller = path.join(dir, 'setup.bat');
    writeFileSync(fakeInstaller, `@echo OK> "${marker}"\r\n`);

    spawnInstaller(fakeInstaller);

    expect(await waitFor(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8').trim()).toBe('OK');
  }, 15_000);
});
