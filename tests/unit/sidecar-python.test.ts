/**
 * P3-A2：Python 解释器运行时探测（infra/sidecar/python.ts）。
 * 用假 runner 枚举「谁能跑」，不碰本机真实解释器。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { resolvePython, venvPython, type ProbeRunner } from '../../src/infra/sidecar/python.js';
import { SidecarClient } from '../../src/infra/sidecar/client.js';

const MOD = path.join('X:', 'repo', 'sidecar');
const VENV = venvPython(MOD, 'win32');

/** ok 里的命令能跑；py / python 返回 exe（模拟打印 sys.executable） */
function runner(ok: Record<string, string>, calls: string[] = []): ProbeRunner {
  return (cmd) => {
    calls.push(cmd);
    return cmd in ok ? ok[cmd]! : null;
  };
}

const base = { moduleDir: MOD, platform: 'win32' as const, env: {}, modules: ['win32pipe'] };

describe('resolvePython（P3-A2）', () => {
  it('配置显式值优先，且必须真能跑', () => {
    expect(resolvePython({ ...base, configured: 'C:/py/python.exe', run: runner({ 'C:/py/python.exe': 'x', [VENV]: 'v' }) }))
      .toEqual({ path: 'C:/py/python.exe', source: 'config' });
    // 配置的跑不通 → 往下落到 venv，而不是直接失败
    expect(resolvePython({ ...base, configured: 'C:/gone.exe', run: runner({ [VENV]: 'v' }) }))
      .toEqual({ path: VENV, source: 'venv' });
  });

  it('MOSHI_PYTHON 先于 venv', () => {
    const r = resolvePython({ ...base, configured: '', env: { MOSHI_PYTHON: 'E:/p.exe' }, run: runner({ 'E:/p.exe': 'x', [VENV]: 'v' }) });
    expect(r).toEqual({ path: 'E:/p.exe', source: 'env' });
  });

  it('py 启动器：取它打印的真实 sys.executable，不返回 py 本身', () => {
    const r = resolvePython({ ...base, configured: '', run: runner({ py: 'D:\\Py313\\python.exe' }) });
    expect(r).toEqual({ path: 'D:\\Py313\\python.exe', source: 'py-launcher' });
  });

  it('PATH 兜底同样取 sys.executable；非 Windows 不试 py', () => {
    const calls: string[] = [];
    const r = resolvePython({ ...base, platform: 'linux', configured: '', run: runner({ python3: '/usr/bin/python3.13' }, calls) });
    expect(r).toEqual({ path: '/usr/bin/python3.13', source: 'path' });
    expect(calls).not.toContain('py');
  });

  it('全部不可用 → null（纯符号模式）', () => {
    expect(resolvePython({ ...base, configured: '', run: runner({}) })).toBeNull();
  });

  it('探测脚本包含必需模块的 import', () => {
    const seen: string[][] = [];
    resolvePython({ ...base, configured: '', modules: ['win32pipe', 'torch'], run: (_c, a) => (seen.push([...a]), null) });
    expect(seen[0]?.[1]).toContain('import win32pipe, torch');
  });
});

describe('SidecarClient 接线', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('拉起时用探测结果作为 pythonPath；找不到则按启动失败处理、不 spawn', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-py-'));
    dirs.push(home);
    const cfg = loadConfig({ home });
    expect(cfg.sidecar.python_path).toBe(''); // 默认走探测，不再写死路径
    const mk = (found: string | null, used: string[]): SidecarClient =>
      new SidecarClient({
        cfg,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        resolvePython: () => (found === null ? null : { path: found, source: 'venv' }),
        spawn: (o) => {
          used.push(o.pythonPath);
          return { pid: 1, waitReady: () => Promise.reject(new Error('stop')), kill: () => {} };
        },
      });
    const usedOk: string[] = [];
    const ok = mk('Z:/venv/python.exe', usedOk);
    await ok.ensureStarted();
    // 就绪失败后客户端会按既有策略重拉；每次都用探测结果
    expect(usedOk.length).toBeGreaterThan(0);
    expect(new Set(usedOk)).toEqual(new Set(['Z:/venv/python.exe']));
    await ok.shutdown();

    const usedNone: string[] = [];
    const none = mk(null, usedNone);
    await none.ensureStarted();
    await new Promise((r) => setTimeout(r, 0));
    expect(usedNone).toHaveLength(0);
    await none.shutdown();
  });
});
