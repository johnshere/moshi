/**
 * 钩子入口包的**一致性**测试（Z-01C）。
 *
 * `packages/magpie-moshi/identity.cjs` 是 `domain/identity.ts` 的一份零依赖可复制实现
 * ——因为 Magpie 的 plugin-host 在自己的进程里加载它，拿不到 moshi 的 dist。
 * 两份实现的口径一旦漂移，同一个会话在钩子里算出的 `moshi_id` 与 daemon 落库的
 * 就不一样，跨入口归并会静默失效。所以这里**逐向量对照真实输出**，不靠人眼核对。
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectIdOf, sessionMoshiId } from '../../src/domain/identity.js';

const require = createRequire(import.meta.url);
const pkg = require('../../packages/magpie-moshi/identity.cjs') as {
  sessionMoshiId: (id: string) => string | null;
  projectIdOf: (input: { kind: 'vcs'; root: string; remote: string | null } | { kind: 'local'; root: string }) => string | null;
};
const hook = require('../../packages/magpie-moshi/hook.cjs') as {
  onRequest: (body: unknown, ctx: unknown) => Promise<unknown>;
};

describe('packages/magpie-moshi/identity.cjs 与 domain/identity.ts 逐字节一致', () => {
  it('会话 id', () => {
    const ids = ['sess-1', '  spaced  ', '会话-中文', 'a:b/c\\d', '0000'];
    for (const id of ids) {
      expect(pkg.sessionMoshiId(id)).toBe(sessionMoshiId({ id }));
    }
  });

  it('会话 id 为空时两边都返回 null', () => {
    expect(pkg.sessionMoshiId('')).toBeNull();
    expect(pkg.sessionMoshiId('   ')).toBeNull();
    expect(sessionMoshiId({ id: '' })).toBeNull();
  });

  it('vcs 工程（有/无 remote）', () => {
    const roots = ['j:/workspace/codes/moshi', 'C:\\Users\\john\\proj', '/home/x/p'];
    for (const root of roots) {
      for (const remote of ['github.com/johnshere/moshi', null] as const) {
        const input = { kind: 'vcs' as const, root, remote };
        expect(pkg.projectIdOf(input)).toBe(projectIdOf(input));
      }
    }
  });

  it('local 工程', () => {
    for (const root of ['j:/temp/x', '/tmp/y', 'd:/中文/目录']) {
      const input = { kind: 'local' as const, root };
      expect(pkg.projectIdOf(input)).toBe(projectIdOf(input));
    }
  });

  it('空 root 两边都返回 null', () => {
    expect(pkg.projectIdOf({ kind: 'local', root: '' })).toBeNull();
    expect(projectIdOf({ kind: 'local', root: '' })).toBeNull();
  });

  it('固定向量（升级哈希口径时这一条必须一起改，否则等于静默破坏兼容）', () => {
    // 这组值是在实现时用 daemon 侧真实函数算出来的
    expect(pkg.sessionMoshiId('sess-1')).toBe('b56ed156bab52740c805785237405f43');
    expect(projectIdOf({ kind: 'vcs', root: 'j:/workspace/codes/moshi', remote: 'github.com/johnshere/moshi' }))
      .toBe(pkg.projectIdOf({ kind: 'vcs', root: 'j:/workspace/codes/moshi', remote: 'github.com/johnshere/moshi' }));
  });
});

describe('hook.cjs 从 daemon.lock 取端口与 token（token 每次 daemon 启动都会换）', () => {
  const dirs: string[] = [];
  const savedFetch = globalThis.fetch;
  const savedDataDir = process.env.MOSHI_DATA_DIR;

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedDataDir === undefined) delete process.env.MOSHI_DATA_DIR;
    else process.env.MOSHI_DATA_DIR = savedDataDir;
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 忽略：Windows 上偶发 EBUSY */
      }
    }
  });

  function dataDirWithLock(lock: Record<string, unknown>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'moshi-hook-lock-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'daemon.lock'), JSON.stringify(lock));
    process.env.MOSHI_DATA_DIR = dir;
    return dir;
  }

  it('没有 options.token 时用锁文件里的 token 与端口', async () => {
    dataDirWithLock({ pid: 1234, port: 51234, token: 'tok-from-lock', version: '0.1.0' });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init.headers });
      return { ok: true, json: async () => ({ schema: 'moshi-hook/1', inject: false, degraded: [], text: '' }) };
    }) as unknown as typeof fetch;

    const out = await hook.onRequest(
      { messages: [{ role: 'user', content: '范围模型是什么' }] },
      { context: { sessionID: 'sess-1' } },
    );
    expect(out).toBeUndefined(); // inject:false → 原请求原样放行
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:51234/hook/api/recall');
    expect(calls[0]?.headers['x-moshi-token']).toBe('tok-from-lock');
  });

  it('既没有 token 也没有锁文件：一个请求都不发（原样放行，不报错）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'moshi-hook-nolock-'));
    dirs.push(dir);
    process.env.MOSHI_DATA_DIR = dir;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const out = await hook.onRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { context: { sessionID: 'sess-1' } },
    );
    expect(out).toBeUndefined();
    expect(called).toBe(0);
  });
});
