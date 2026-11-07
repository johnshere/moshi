/**
 * sidecar 传输层（详设 §4.6）：行分隔 JSON over 命名管道/域套接字。
 *
 * Windows 用命名管道（`\\.\pipe\moshi-infer`，daemon 单实例故固定名），
 * unix 平台用域套接字文件。协议与 `sidecar/moshi_sidecar/server.py` 严格对齐：
 * 请求一行 `{"path": "...", "body": {...}}`，响应一行 JSON。
 */
import net from 'node:net';

export interface SidecarTransport {
  request(path: string, body: unknown, timeoutMs: number): Promise<unknown>;
  close(): void;
}

/**
 * 单次请求超时（区别于连接级失败）。
 * 客户端据此标 `degraded:["timeout"]`，不走崩溃重启计数（详设 §4.6）。
 */
export class SidecarTimeoutError extends Error {
  constructor(path: string) {
    super(`sidecar 请求超时（${path}）`);
    this.name = 'SidecarTimeoutError';
  }
}

export interface TransportTarget {
  /** Windows 命名管道名（`\\.\pipe\...`）；优先于 socketPath */
  pipeName: string | null;
  /** unix 域套接字路径 */
  socketPath: string | null;
}

/** 把 TCP/socket 错误翻译成统一信号：返回 null 表示连接级失败（崩溃/未起） */
export function connectTransport(target: TransportTarget): Promise<SidecarTransport> {
  const path = target.pipeName ?? target.socketPath;
  if (path === null) return Promise.reject(new Error('sidecar 传输目标为空'));

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path });
    let settled = false;
    const onError = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      settled = true;
      sock.removeListener('error', onError);
      sock.on('error', () => {
        // 已建立的连接断掉：由上层 request 感知，这里不抛（避免未捕获）
      });
      resolve(new PipeTransport(sock));
    });
  });
}

class PipeTransport implements SidecarTransport {
  private buffer = '';
  private queue: {
    path: string;
    body: unknown;
    timeoutMs: number;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }[] = [];
  private active: {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(private readonly sock: net.Socket) {
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => this.onData(chunk));
    this.sock.on('close', () => this.onClosed());
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const nl = this.buffer.indexOf('\n');
    if (nl < 0 || this.active === null) return;
    const line = this.buffer.slice(0, nl).trim();
    this.buffer = this.buffer.slice(nl + 1);
    if (line === '') return;
    const p = this.active;
    this.active = null;
    clearTimeout(p.timer);
    try {
      p.resolve(JSON.parse(line));
    } catch (err) {
      p.reject(err instanceof Error ? err : new Error('响应不是合法 JSON'));
    }
    this.pump();
  }

  private onClosed(): void {
    if (this.active !== null) {
      const p = this.active;
      this.active = null;
      clearTimeout(p.timer);
      p.reject(new Error('sidecar 连接已关闭'));
    }
    const waiting = this.queue;
    this.queue = [];
    for (const item of waiting) {
      item.reject(new Error('sidecar 连接已关闭'));
    }
  }

  request(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    if (this.sock.destroyed) {
      return Promise.reject(new Error('sidecar 连接已断开'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ path, body, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /** 只发出一个在途请求；响应/超时后取队列下一个。请求并发安全：排队而非失败。 */
  private pump(): void {
    if (this.active !== null || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    const timer = setTimeout(() => {
      // 超时：当前请求失败；销毁连接会让 onClosed 连带拒绝排队的后续请求
      this.sock.destroy();
      if (this.active !== null) {
        const p = this.active;
        this.active = null;
        clearTimeout(p.timer);
        p.reject(new SidecarTimeoutError(item.path));
      }
    }, item.timeoutMs);
    this.active = { resolve: item.resolve, reject: item.reject, timer };
    this.sock.write(`${JSON.stringify({ path: item.path, body: item.body })}\n`);
  }

  close(): void {
    this.sock.destroy();
  }
}
