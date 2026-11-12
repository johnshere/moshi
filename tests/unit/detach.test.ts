import { describe, expect, it, vi } from 'vitest';
import {
  DETACHED_ENV,
  DETACH_FLAG,
  type DetachSpawnFn,
  detachArgs,
  detachCreationFlags,
  detachDaemon,
  waitDaemonUp,
  wantsDetach,
} from '../../src/app/detach.js';

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: Record<string, unknown>;
}

function recorder(
  pid: number | undefined,
  unref: () => void = () => {},
): { spawn: DetachSpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: DetachSpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { pid, unref };
  };
  return { spawn, calls };
}

describe('app/detach 后台拉起', () => {
  it('识别 --detach 参数', () => {
    expect(wantsDetach(['daemon', DETACH_FLAG])).toBe(true);
    expect(wantsDetach(['daemon'])).toBe(false);
    expect(wantsDetach([])).toBe(false);
  });

  it('子进程 argv 里剥掉 --detach', () => {
    expect(detachArgs(['entry.js', 'daemon', '--detach'])).toEqual(['entry.js', 'daemon']);
    expect(detachArgs(['entry.js', 'daemon'])).toEqual(['entry.js', 'daemon']);
  });

  it('Windows 用 DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP，其他平台不加标志', () => {
    expect(detachCreationFlags('win32')).toEqual({ creationFlags: 0x00000208 });
    expect(detachCreationFlags('linux')).toEqual({});
    expect(detachCreationFlags('darwin')).toEqual({});
  });

  it('spawn 出来的子进程无控制台、stdio 忽略、带自证环境变量', () => {
    const unref = vi.fn();
    const { spawn, calls } = recorder(4242, unref);
    const pid = detachDaemon({
      execPath: 'C:\\node.exe',
      entry: 'E:\\moshi\\dist\\app\\main.js',
      argv: ['E:\\moshi\\dist\\app\\main.js', 'daemon', '--detach'],
      cwd: 'E:\\moshi',
      platform: 'win32',
      env: { PATH: 'x' },
      spawn,
    });

    expect(pid).toBe(4242);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd).toBe('C:\\node.exe');
    expect(call.args).toEqual(['E:\\moshi\\dist\\app\\main.js', 'daemon']);
    expect(call.opts).toMatchObject({
      cwd: 'E:\\moshi',
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      creationFlags: 0x00000208,
    });
    const env = call.opts.env as Record<string, string>;
    expect(env[DETACHED_ENV]).toBe('1');
    expect(env.PATH).toBe('x');
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('非 Windows 不加 creationFlags（靠 detached 自成进程组）', () => {
    const { spawn, calls } = recorder(7);
    detachDaemon({
      execPath: '/usr/bin/node',
      entry: '/opt/moshi/main.js',
      argv: ['/opt/moshi/main.js', 'daemon'],
      platform: 'linux',
      spawn,
    });
    const opts = calls[0]!.opts;
    expect(opts.creationFlags).toBeUndefined();
    expect(opts.detached).toBe(true);
  });

  it('拿不到入口脚本时直接报错，不 spawn', () => {
    const { spawn, calls } = recorder(1);
    expect(() => detachDaemon({ entry: '', argv: [], spawn })).toThrow(/入口脚本/);
    expect(calls).toHaveLength(0);
  });

  it('等锁：写下来就返回 pid', async () => {
    let polls = 0;
    const pid = await waitDaemonUp(
      () => {
        polls += 1;
        return polls >= 3 ? 999 : null;
      },
      { intervalMs: 0, sleep: async () => {} },
    );
    expect(pid).toBe(999);
    expect(polls).toBe(3);
  });

  it('等锁：超时返回 null（让调用方给出非 0 退出码）', async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => (now += 1000);
    try {
      const pid = await waitDaemonUp(() => null, { timeoutMs: 2000, intervalMs: 100, sleep: async () => {} });
      expect(pid).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
