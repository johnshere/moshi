/**
 * SidecarClient 状态机单测（详设 §4.6 客户端行为 / §7.1 生命周期）。
 *
 * 不拉起真 Python 进程：注入 fake transport（可编程抛错/断开）与 fake spawn，
 * 只验证 Node 侧状态机。端到端（真进程 + 真命名管道）见 tests/integration/sidecar.test.ts。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import {
  SidecarClient,
  type SidecarClientDeps,
} from '../../src/infra/sidecar/client.js';
import type { SidecarTransport } from '../../src/infra/sidecar/transport.js';
import { SidecarTimeoutError } from '../../src/infra/sidecar/transport.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-sc-'));
  dirs.push(d);
  return d;
}

/** 可编程 fake 传输：默认正常响应；可切换为抛错（模拟断开）或超时 */
class FakeTransport implements SidecarTransport {
  fail = false;
  scoreTimeout = false;
  closed = 0;
  /** 每次 /score 收到的超时预算（w6：冷启/稳态区分） */
  scoreTimeouts: number[] = [];
  onDiscard?: (reason: 'timeout') => void;
  scoreResponse: unknown = {
    scores: [{ fact_id: 'f1', delta: 0.01, overturn_prob: 0.2 }],
    model_version: 'v1',
    ms: 1.5,
  };
  requests: Array<{ path: string; body: unknown }> = [];
  request(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    this.requests.push({ path, body });
    if (path === '/score') this.scoreTimeouts.push(timeoutMs);
    if (this.fail) return Promise.reject(new Error('sidecar 连接已关闭'));
    if (path === '/score') {
      if (this.scoreTimeout) {
        // 真传输：超时先通知上层摘掉连接，再拒绝
        this.onDiscard?.('timeout');
        return Promise.reject(new SidecarTimeoutError('/score'));
      }
      return Promise.resolve(this.scoreResponse);
    }
    if (path === '/health') return Promise.resolve({ status: 'ready', rss_mb: 42, loaded: true, pid: 777 });
    if (path === '/encode') return Promise.resolve({ vectors: [[0.1, 0.2]], dim: 2 });
    if (path === '/unload' || path === '/shutdown' || path === '/reload') return Promise.resolve({ ok: true });
    return Promise.resolve({ ok: true });
  }
  close(): void {
    this.closed += 1;
  }
}

interface FakeSpawnRec {
  spawns: number;
  kills: number;
  failReady: boolean;
  waitReady(): Promise<{ pid: number; socket: string; embedModel: string; modelVersion: string; startedAt: string }>;
}

function makeDeps(home: string, transport: FakeTransport): { deps: SidecarClientDeps; spawnRec: FakeSpawnRec; clock: { t: number } } {
  const cfg = loadConfig({ home });
  const clock = { t: 1_000_000 };
  const spawnRec: FakeSpawnRec = {
    spawns: 0,
    kills: 0,
    failReady: false,
    waitReady() {
      return Promise.resolve({ pid: 777, socket: 'pipe', embedModel: 'bge', modelVersion: 'v1', startedAt: 'x' });
    },
  };
  const deps: SidecarClientDeps = {
    cfg,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    createTransport: () => Promise.resolve(transport),
    spawn: () => {
      spawnRec.spawns += 1;
      return {
        pid: 777,
        waitReady: spawnRec.failReady ? () => Promise.reject(new Error('就绪超时')) : spawnRec.waitReady,
        kill: () => {
          spawnRec.kills += 1;
        },
      };
    },
    now: () => clock.t,
  };
  return { deps, spawnRec, clock };
}

describe('SidecarClient（P1-01）', () => {
  it('懒启动：stopped 时不 spawn；首次 encode 立即返回 null 并异步拉起', async () => {
    const home = tempHome();
    const { deps, spawnRec } = makeDeps(home, new FakeTransport());
    const c = new SidecarClient(deps);
    expect(c.status().state).toBe('stopped');
    expect(spawnRec.spawns).toBe(0);

    const before = await c.encode(['x']);
    expect(before).toBeNull(); // 本次立即降级，不阻塞
    expect(spawnRec.spawns).toBe(1); // 已异步触发拉起

    await c.ensureStarted();
    expect(c.status().state).toBe('ready');
    const vecs = await c.encode(['x']);
    expect(vecs).toEqual([[0.1, 0.2]]);
    await c.terminate();
    expect(c.status().state).toBe('stopped');
    expect(spawnRec.kills).toBe(1);
  });

  it('/shutdown 保持兼容：ready 只卸载，不杀进程树', async () => {
    const home = tempHome();
    const { deps, spawnRec } = makeDeps(home, new FakeTransport());
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    await c.shutdown();
    expect(c.status().state).toBe('stopped');
    expect(spawnRec.kills).toBe(0);
  });

  it('启动中不重复 spawn', async () => {
    const home = tempHome();
    const { deps, spawnRec } = makeDeps(home, new FakeTransport());
    const c = new SidecarClient(deps);
    const p1 = c.ensureStarted();
    const p2 = c.ensureStarted();
    await Promise.all([p1, p2]);
    expect(spawnRec.spawns).toBe(1);
    await c.terminate();
  });

  it('encode 断开 → 重启计数 +1 并重新拉起', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps, spawnRec } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    t.fail = true;
    const vecs = await c.encode(['x']);
    expect(vecs).toBeNull();
    expect(spawnRec.spawns).toBeGreaterThanOrEqual(2); // 断开后自动重启
    expect(c.status().restartsThisHour).toBe(1);
    await c.terminate();
  });

  it('1 小时内 ≥ max_restarts 次 → mode=off、state=failed，不再尝试', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps, spawnRec } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    t.fail = true;
    await c.encode(['x']); // 断开 → 计数 1，自动重拉
    await c.ensureStarted(); // 等重拉完成
    await c.encode(['x']); // 断开 → 计数 2
    await c.ensureStarted();
    await c.encode(['x']); // 断开 → 计数 3 → off
    expect(c.status().mode).toBe('off');
    expect(c.status().state).toBe('failed');
    const before = spawnRec.spawns;
    await c.ensureStarted();
    expect(spawnRec.spawns).toBe(before); // off 后不再 spawn
    await c.terminate();
  });

  it('空闲卸载：超 idle_unload_min → unloaded；超 idle_exit_min → stopped', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps, clock } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    await c.encode(['x']); // lastActivityAt = now
    clock.t += 6 * 60_000; // 6 分钟 > idle_unload_min=5
    await c.checkIdle();
    expect(c.status().state).toBe('unloaded');
    expect(t.requests.map((r) => r.path)).toContain('/unload');

    clock.t += 31 * 60_000; // 距上次活动 37 分钟 > idle_exit_min=30
    await c.checkIdle();
    expect(c.status().state).toBe('stopped');
    expect(t.requests.map((r) => r.path)).toContain('/terminate');
    await c.terminate();
  });

  it('启动失败（就绪超时）计入重启计数，连续失败后同样熔断为 off', async () => {
    const home = tempHome();
    const { deps } = makeDeps(home, new FakeTransport());
    deps.spawn = () => ({
      pid: 777,
      waitReady: () => Promise.reject(new Error('就绪超时')),
      kill: () => {},
    });
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    // 失败触发 handleFailure → 异步重试循环，最多 3 次后熔断
    const deadline = Date.now() + 2000;
    while (c.status().mode !== 'off' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(c.status().mode).toBe('off');
    expect(c.status().restartsThisHour).toBeGreaterThanOrEqual(3);
    await c.terminate();
  });
});

describe('SidecarClient /score（P3-04）', () => {
  it('未启动：立即 degraded no_sidecar 并异步拉起', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps, spawnRec } = makeDeps(home, t);
    const c = new SidecarClient(deps);

    const out = await c.score({});
    expect(out).toEqual({ scores: null, modelVersion: null, ms: null, degraded: ['no_sidecar'] });
    expect(spawnRec.spawns).toBe(1);
    await c.terminate();
  });

  it('ready：返回逐节点打分且 degraded 为空', async () => {
    const home = tempHome();
    const { deps } = makeDeps(home, new FakeTransport());
    const c = new SidecarClient(deps);
    await c.ensureStarted();

    const out = await c.score({ schema: 'moshi-subgraph/2', nodes: [], edges: [] });
    expect(out.degraded).toEqual([]);
    expect(out.scores).toEqual([{ fact_id: 'f1', delta: 0.01, overturn_prob: 0.2 }]);
    expect(out.modelVersion).toBe('v1');
    expect(out.ms).toBeCloseTo(1.5);
    await c.terminate();
  });

  it('超时：degraded timeout，不计崩溃重启', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps, spawnRec } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    t.scoreTimeout = true;

    const out = await c.score({});
    expect(out).toEqual({ scores: null, modelVersion: null, ms: null, degraded: ['timeout'] });
    expect(spawnRec.kills).toBe(0);
    expect(c.status().restartsThisHour).toBe(0);
    await c.terminate();
  });

  it('冷启首调用 score_timeout_ms，首次成功后回落 score_steady_timeout_ms', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();

    await c.score({});
    await c.score({});
    await c.score({});
    // 默认 5000（冷启，w6 实测首调 2.81s）→ 成功后 120（稳态 3~8ms）
    expect(t.scoreTimeouts).toEqual([5000, 120, 120]);
    await c.terminate();
  });

  it('超时后丢弃半死连接、后台重连可复用，且不计崩溃重启', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps, spawnRec } = makeDeps(home, t);
    let creates = 0;
    const baseCreate = deps.createTransport!;
    deps.createTransport = (target) => {
      creates += 1;
      return baseCreate(target);
    };
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    expect(creates).toBe(1);

    t.scoreTimeout = true;
    const out = await c.score({});
    expect(out.degraded).toEqual(['timeout']);
    expect(c.status().state).toBe('ready'); // 进程还活着
    expect(c.status().restartsThisHour).toBe(0);
    expect(spawnRec.kills).toBe(0);
    expect(t.closed).toBeGreaterThanOrEqual(1); // 半死连接被关掉

    t.scoreTimeout = false;
    await c.ensureStarted(); // 后台重连完成
    expect(creates).toBe(2);
    const ok = await c.score({});
    expect(ok.degraded).toEqual([]);
    expect(c.status().restartsThisHour).toBe(0);
    // 还没成功跑过一帧：重连不重置冷启预算
    expect(t.scoreTimeouts).toEqual([5000, 5000]);
    await c.terminate();
  });

  it('空闲卸载后首调重新取冷启预算（打分器要重新加载）', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps, clock } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    await c.score({}); // 5000 → 成功，转稳态
    await c.score({}); // 120
    clock.t += 6 * 60_000;
    await c.checkIdle(); // /unload
    expect(c.status().state).toBe('unloaded');
    await c.score({}); // 卸载后重新按冷启预算
    expect(t.scoreTimeouts).toEqual([5000, 120, 5000]);
    await c.terminate();
  });

  it('进程重启后首调重新取冷启预算（scoreWarm 复位）', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();
    await c.score({}); // 冷启 5000，成功 → 稳态

    t.fail = true;
    await c.encode(['x']); // 断开 → 崩溃计数 + 重拉
    t.fail = false;
    await c.ensureStarted();
    await c.score({}); // 新进程：重新 5000
    expect(t.scoreTimeouts).toEqual([5000, 5000]);
    expect(c.status().restartsThisHour).toBe(1);
    await c.terminate();
  });

  it('形状错误 / 模型未加载：映射到对应 degraded 原因', async () => {
    const home = tempHome();
    const t = new FakeTransport();
    const { deps } = makeDeps(home, t);
    const c = new SidecarClient(deps);
    await c.ensureStarted();

    t.scoreResponse = { error: { code: 'E_INPUT_SHAPE', message: 'bad' } };
    expect((await c.score({})).degraded).toEqual(['input_shape']);

    t.scoreResponse = { error: { code: 'E_MODEL_NOT_LOADED', message: 'no weights' } };
    expect((await c.score({})).degraded).toEqual(['model_not_loaded']);

    t.scoreResponse = { error: { code: 'E_INTERNAL', message: 'boom' } };
    expect((await c.score({})).degraded).toEqual(['error']);
    await c.terminate();
  });
});
