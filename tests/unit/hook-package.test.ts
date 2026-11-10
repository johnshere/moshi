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
  onResponse: (reply: unknown, ctx: unknown) => unknown;
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
      { session: 'sess-1' },
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
      { session: 'sess-1' },
    );
    expect(out).toBeUndefined();
    expect(called).toBe(0);
  });
});

describe('hook.cjs 身份：扁平 ctx + 无 session 头时的会话开头指纹（DSH 走 pi-ai，不发 session 头）', () => {
  const savedFetch = globalThis.fetch;

  interface Envelope {
    turn: string;
    session: { id: string | null; source: string };
    project: { cwd: string | null };
    identity: { moshi_id: string | null };
  }

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  function setup(reply: { text: string } | null): { envelopes: Envelope[]; reports: [string, number][] } {
    const envelopes: Envelope[] = [];
    const reports: [string, number][] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      envelopes.push(JSON.parse(init.body) as Envelope);
      const json = async () =>
        reply === null
          ? { schema: 'moshi-hook/1', inject: false, degraded: [], text: '' }
          : { schema: 'moshi-hook/1', inject: true, degraded: [], text: reply.text, evidence: [1, 2, 3, 4, 5] };
      return { ok: true, json };
    }) as unknown as typeof fetch;
    return { envelopes, reports };
  }

  function ctxOf(reports: [string, number][], state: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      options: { token: 'test-token' },
      state,
      report: (code: string, count: number) => reports.push([code, count]),
    };
  }

  it('扁平 ctx 的 session/cwd 原样进入信封（宿主给了就不做指纹）', async () => {
    const { envelopes, reports } = setup({ text: '## 记忆台账（moshi）\n[M1] hello' });
    await hook.onRequest(
      { messages: [{ role: 'user', content: 'q' }] },
      { session: 'host-sess', cwd: 'E:\\proj', ...ctxOf(reports) },
    );
    expect(envelopes[0]?.session.id).toBe('host-sess');
    expect(envelopes[0]?.project.cwd).toBe('E:\\proj');
  });

  it('没有 session 时用「cwd + 会话开头」派生：同开头稳定、换开头就换号，快照不参与', async () => {
    const snapA = {
      role: 'user',
      content:
        'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "E:\\\\Workspace\\\\moshi".',
    };
    const snapB = { role: 'user', content: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' };
    const opening = { role: 'user', content: '把 golden 默认路径补上' };
    const { envelopes, reports } = setup(null);
    const ctx = ctxOf(reports);

    await hook.onRequest({ messages: [snapA, opening] }, ctx);
    await hook.onRequest({ messages: [snapB, { role: 'assistant', content: '好' }, opening] }, ctx);
    await hook.onRequest({ messages: [snapA, { role: 'user', content: '换个开头' }] }, ctx);

    const first = envelopes[0]?.session.id;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(envelopes[1]?.session.id).toBe(first); // 快照变了、开头没变 → 同一个会话
    expect(envelopes[2]?.session.id).not.toBe(first); // 开头变了 → 新会话
    expect(envelopes[0]?.session.source).toBe('conversation-opening');
    // DSH 的目录文本带引号/双反斜杠/句末点，插件自己清洗
    expect(envelopes[0]?.project.cwd).toBe('E:\\Workspace\\moshi');
    expect(envelopes[0]?.identity.moshi_id).toBeNull();
  });

  it('report 传注入文本的字节数（宿主面板按字节记账，不是证据条数）', async () => {
    const text = '## 记忆台账（moshi）\n[M1] hello';
    const { reports } = setup({ text });
    await hook.onRequest({ messages: [{ role: 'user', content: 'q' }] }, ctxOf(reports));
    const last = reports[reports.length - 1];
    expect(last?.[0]).toBe('ready');
    expect(last?.[1]).toBe(new TextEncoder().encode(text).length);
    expect(last?.[1]).toBeGreaterThan(5);
  });

  it('onResponse 复用 onRequest 留在 ctx.state 里的会话标志', async () => {
    const { envelopes, reports } = setup(null);
    const state: Record<string, unknown> = {};
    const ctx = ctxOf(reports, state);
    const body = { messages: [{ role: 'user', content: '起始消息' }] };
    await hook.onRequest(body, ctx);
    hook.onResponse({ choices: [{ message: { content: '回答' } }] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const signal = envelopes.find((e) => e.turn === 'response');
    expect(signal?.session.id).toBe(envelopes[0]?.session.id);
  });
});
