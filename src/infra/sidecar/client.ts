/**
 * SidecarClient（详设 §4.6 客户端行为 / §7.1 生命周期）。
 *
 * 状态机：STOPPED → STARTING → READY ⇄ UNLOADED → STOPPED
 *                ↘ FAILED（1h 内 3 次崩溃后停在 FAILED，mode 降为 off）
 *
 * 纪律：
 * - **懒启动**：daemon 启动不拉起；首次需要时异步 ensureStarted()，本次返回 null
 *   （调用方标 `degraded:["no_sidecar"]`），不阻塞查询；
 * - **空闲卸载**：idle_unload_min 无请求 → POST /unload（进程保留）；
 *   idle_exit_min 无请求 → POST /shutdown（进程退出）；
 * - **崩溃重启上限**：断开计 1 次，1h 窗口内 ≥ max_restarts_per_hour → off + 告警
 *   （不弹窗，概设 §1.5 纪律 2）。
 */
import path from 'node:path';
import type { Config } from '../../app/config.js';
import {
  connectTransport,
  type SidecarTransport,
  type TransportTarget,
} from './transport.js';
import {
  defaultSidecarModuleDir,
  SIDECAR_PIPE_NAME,
  spawnSidecar,
  type ReadyInfo,
  type SpawnedSidecar,
} from './spawn.js';

export type SidecarState = 'stopped' | 'starting' | 'ready' | 'unloaded' | 'failed';
export type SidecarMode = 'on' | 'off';

export interface SidecarStatus {
  state: SidecarState;
  mode: SidecarMode;
  pid: number | null;
  embedModel: string;
  rssMb: number | null;
  restartsThisHour: number;
  lastActivityAt: number | null;
}

export interface LoggerLike {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface SidecarClientDeps {
  cfg: Pick<Config, 'sidecar' | 'model' | 'storage'>;
  logger: LoggerLike;
  /** 测试注入点：创建传输 */
  createTransport?: (target: TransportTarget) => Promise<SidecarTransport>;
  /** 测试注入点：拉起进程 */
  spawn?: (opts: {
    pythonPath: string;
    moduleDir: string;
    readyPath: string;
    pipeName: string;
    model: string;
    dim: number;
    logFile: string;
    startupTimeoutMs: number;
  }) => SpawnedSidecar;
  now?: () => number;
}

const HOUR_MS = 3_600_000;

export class SidecarClient {
  private state: SidecarState = 'stopped';
  private mode: SidecarMode = 'on';
  private transport: SidecarTransport | null = null;
  private spawned: SpawnedSidecar | null = null;
  private ready: ReadyInfo | null = null;
  private restartsThisHour = 0;
  private restartWindowStart = 0;
  private lastActivityAt: number | null = null;
  private startingPromise: Promise<void> | null = null;
  private readonly idleTimer: NodeJS.Timeout;

  constructor(private readonly deps: SidecarClientDeps) {
    const checkMs = 30_000;
    this.idleTimer = setInterval(() => void this.checkIdle(), checkMs);
    this.idleTimer.unref();
  }

  status(): SidecarStatus {
    return {
      state: this.state,
      mode: this.mode,
      pid: this.ready?.pid ?? this.spawned?.pid ?? null,
      embedModel: this.deps.cfg.model.embed_model,
      rssMb: null,
      restartsThisHour: this.restartsThisHour,
      lastActivityAt: this.lastActivityAt,
    };
  }

  /** 懒启动：已有连接直接返回；否则异步拉起，本次调用方照旧降级。并发调用共享同一个启动 promise。 */
  async ensureStarted(): Promise<void> {
    if (this.mode === 'off') {
      this.state = 'failed';
      return;
    }
    if (this.state === 'ready' || this.state === 'unloaded') return;
    if (this.startingPromise !== null) return this.startingPromise;
    this.state = 'starting';
    const now = this.now();
    if (now - this.restartWindowStart > HOUR_MS) {
      this.restartWindowStart = now;
      this.restartsThisHour = 0;
    }
    this.startingPromise = this.doStart().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  private async doStart(): Promise<void> {
    try {
      const s = this.spawnSidecarProcess();
      this.spawned = s;
      const ready = await s.waitReady();
      this.ready = ready;
      this.transport = await this.createTransport({
        pipeName: process.platform === 'win32' ? SIDECAR_PIPE_NAME : null,
        socketPath: process.platform === 'win32' ? null : SIDECAR_PIPE_NAME,
      });
      this.state = 'ready';
      this.deps.logger.info(
        { event: 'sidecar.ready', pid: ready.pid, model: ready.embedModel },
        'sidecar ready',
      );
    } catch (err) {
      this.deps.logger.warn(
        { event: 'sidecar.start_failed', err: (err as Error).message },
        'sidecar 启动失败',
      );
      // 必须等 doStart 的 finally 清掉 startingPromise 再计失败/重启，
      // 否则 handleFailure 里的 ensureStarted() 会被去重吞掉 → 永远停在 stopped。
      queueMicrotask(() => this.handleFailure());
    }
  }

  /**
   * 编码一批文本。不可用（未启动/启动中/已停用/请求失败）一律返回 null，
   * 调用方标 `degraded:["no_sidecar"]`。永不抛错、永不阻塞超过 timeout。
   */
  async encode(texts: string[]): Promise<number[][] | null> {
    this.lastActivityAt = this.now();
    if (this.mode === 'off' || this.state === 'failed') return null;
    if (this.state !== 'ready' && this.state !== 'unloaded') {
      void this.ensureStarted();
      return null;
    }
    if (this.transport === null) {
      void this.ensureStarted();
      return null;
    }
    try {
      const res = (await this.transport.request(
        '/encode',
        { texts },
        this.deps.cfg.sidecar.encode_timeout_ms,
      )) as { vectors?: number[][]; dim?: number } & { error?: { code: string; message: string } };
      if (res.error !== undefined) return null;
      return res.vectors ?? null;
    } catch (err) {
      this.deps.logger.warn(
        { event: 'sidecar.encode_failed', err: (err as Error).message },
        'encode 失败',
      );
      this.handleFailure();
      return null;
    }
  }

  /** 健康检查（诊断/状态条用）；不可用返回 null */
  async health(): Promise<{ rssMb: number; loaded: boolean; pid: number } | null> {
    if (this.state !== 'ready' || this.transport === null) return null;
    try {
      const res = (await this.transport.request('/health', {}, 500)) as {
        rss_mb?: number;
        loaded?: boolean;
        pid?: number;
      } & { error?: { code: string } };
      if (res.error !== undefined) return null;
      return { rssMb: res.rss_mb ?? 0, loaded: res.loaded ?? false, pid: res.pid ?? 0 };
    } catch {
      return null;
    }
  }

  /** 关停（daemon 退出时兜底）：尽力发 /shutdown，不再重启 */
  async shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    if (this.state === 'ready' && this.transport !== null) {
      try {
        await this.transport.request('/shutdown', {}, 1000);
      } catch {
        /* 尽力而为 */
      }
    }
    // 还在启动中（waitReady 未返回）时没有可用传输：直接杀进程树，
    // 否则 shutdown 会留一个孤儿 sidecar + 挂着日志流（目录被删后 ENOENT）
    if (this.spawned !== null && this.ready === null) {
      try {
        this.spawned.kill();
      } catch {
        /* 尽力而为 */
      }
    }
    this.transport?.close();
    this.transport = null;
    this.spawned = null;
    this.ready = null;
    this.state = 'stopped';
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private createTransport(target: TransportTarget): Promise<SidecarTransport> {
    return this.deps.createTransport ? this.deps.createTransport(target) : connectTransport(target);
  }

  private spawnSidecarProcess(): SpawnedSidecar {
    const opts = {
      pythonPath: this.deps.cfg.sidecar.python_path,
      moduleDir: defaultSidecarModuleDir(),
      readyPath: path.join(this.deps.cfg.storage.data_dir, 'sidecar.ready'),
      pipeName: SIDECAR_PIPE_NAME,
      model: this.deps.cfg.model.embed_model,
      dim: this.deps.cfg.model.embed_dim,
      logFile: path.join(this.deps.cfg.storage.data_dir, 'logs', 'sidecar.log'),
      startupTimeoutMs: this.deps.cfg.sidecar.startup_timeout_ms,
    };
    return this.deps.spawn ? this.deps.spawn(opts) : spawnSidecar(opts);
  }

  /** 断开/失败：计数，≥上限 → off；否则在当前启动完成后重新拉起 */
  private handleFailure(): void {
    this.cleanupTransport();
    const now = this.now();
    if (now - this.restartWindowStart > HOUR_MS) {
      this.restartWindowStart = now;
      this.restartsThisHour = 0;
    }
    this.restartsThisHour += 1;
    const max = this.deps.cfg.sidecar.max_restarts_per_hour;
    if (this.restartsThisHour >= max) {
      this.mode = 'off';
      this.state = 'failed';
      this.deps.logger.warn(
        { event: 'sidecar.breaker', restarts: this.restartsThisHour, max },
        'sidecar 1 小时内崩溃次数达上限，停用（纯符号模式）',
      );
      return;
    }
    this.state = 'stopped';
    this.deps.logger.warn(
      { event: 'sidecar.restart', restarts: this.restartsThisHour, max },
      'sidecar 断开，准备重启',
    );
    const resume = (): void => {
      void this.ensureStarted();
    };
    if (this.startingPromise !== null) {
      // 当前启动还没 settle（如失败中）：等它结束后再拉起，避免被去重吞掉
      void this.startingPromise.then(resume, resume);
    } else {
      resume();
    }
  }

  private cleanupTransport(): void {
    this.transport?.close();
    this.transport = null;
    this.spawned = null;
    this.ready = null;
  }

  /**
   * 空闲检查（内部定时器驱动；公开便于测试直接触发）。
   * 幂等：unloaded 后再触发只走 exit 分支；stopped/failed 直接返回。
   */
  async checkIdle(): Promise<void> {
    if (this.lastActivityAt === null || this.state === 'failed' || this.mode === 'off') return;
    const idleMs = this.now() - this.lastActivityAt;
    const { idle_unload_min, idle_exit_min } = this.deps.cfg.sidecar;
    if (idleMs >= idle_exit_min * 60_000) {
      if (this.transport !== null) {
        try {
          await this.transport.request('/shutdown', {}, 1000);
        } catch {
          /* 尽力 */
        }
      }
      this.cleanupTransport();
      this.state = 'stopped';
      this.lastActivityAt = null;
      this.deps.logger.info({ event: 'sidecar.idle_exit' }, 'sidecar 空闲超时退出');
      return;
    }
    if (idleMs >= idle_unload_min * 60_000 && this.state === 'ready' && this.transport !== null) {
      try {
        await this.transport.request('/unload', {}, 1000);
        this.state = 'unloaded';
        this.deps.logger.info({ event: 'sidecar.idle_unload' }, 'sidecar 空闲卸载权重');
      } catch {
        /* 卸载失败不致命 */
      }
    }
  }
}
