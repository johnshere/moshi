/**
 * 接入页客户端契约（用户 m00882）：采集源状态 + 导入的失败人话。
 *
 * 只钉 `src/ui/access/api.ts` 的取数与错误映射——组件（置灰按钮）在浏览器里验，
 * vitest 跑 node 环境、没有 jsdom，这里用全局 fetch/window 打桩（同 hook-package.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCollectSources, postImport } from '../../src/ui/access/api.js';

const savedFetch = globalThis.fetch;

function stubWindow(search = ''): void {
  vi.stubGlobal('window', {
    location: { search },
    localStorage: { getItem: () => null, setItem: () => undefined },
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  stubWindow('');
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  vi.unstubAllGlobals();
});

describe('fetchCollectSources', () => {
  it('GET /api/collect/sources，带 token，原样给出 configured/available/sources', async () => {
    stubWindow('?token=tk');
    const calls = stubFetch(200, {
      configured: true,
      available: false,
      sources: [{ id: 'cc-main', adapter: 'claude-code', root: 'C:\\x', available: false }],
    });
    const state = await fetchCollectSources();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/collect/sources');
    expect((calls[0]?.init?.headers as Record<string, string>)['X-Moshi-Token']).toBe('tk');
    expect(state.configured).toBe(true);
    expect(state.available).toBe(false);
    expect(state.sources[0]?.id).toBe('cc-main');
  });

  it('非 2xx 抛后端 message（页面据此显示「来源状态读取失败」）', async () => {
    stubFetch(500, { error: 'E_INTERNAL', message: '读取采集源失败' });
    await expect(fetchCollectSources()).rejects.toThrow('读取采集源失败');
  });
});

describe('postImport 的失败人话', () => {
  it('400 + detail.reason=no_source → 说没有可用来源，不是 409 文案（用户 m00882）', async () => {
    stubFetch(400, {
      error: 'E_INPUT',
      message: '没有可用的采集来源，请先配置 collect.sources',
      detail: { reason: 'no_source' },
    });
    await expect(postImport('1d')).rejects.toThrow('没有可用的采集来源，请先配置 collect.sources');
  });

  it('409 → 已有导入在执行（保持原口径）', async () => {
    stubFetch(409, { error: 'E_CONFLICT', message: '导入正在执行，稍后再试', detail: { reason: 'import_running' } });
    await expect(postImport('1d')).rejects.toThrow('已有导入在执行');
  });

  it('400 的其它 reason 用后端 message，不误报成无源', async () => {
    stubFetch(400, { error: 'E_INPUT', message: 'since 不合法', detail: { reason: 'bad_since' } });
    await expect(postImport('1d')).rejects.toThrow('since 不合法');
  });

  it('202 返回启动态', async () => {
    stubFetch(202, { ok: true, since: '1d', started_at: '2026-11-16T00:00:00.000Z' });
    await expect(postImport('1d')).resolves.toEqual({
      ok: true,
      since: '1d',
      started_at: '2026-11-16T00:00:00.000Z',
    });
  });
});
