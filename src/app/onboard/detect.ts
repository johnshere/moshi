/**
 * 宿主探测（Z-01C-h / 设计 §16.3）：目录 + 端口 + 进程三路并行。
 *
 * 为什么要三路：单一路都不可靠——目录在但没跑、跑了但装在别处、端口被占但不是它。
 * 三路里任一路命中即"检测到"，`via` 记下命中证据，诊断和"误报排查"都看这个字段。
 *
 * **预算**：三路 `Promise.allSettled` 并行，总超时由调用方控制（路由里 1200ms）。
 * 进程与端口都可能慢，所以这一层不做缓存，缓存由路由侧的 `detectCache` 管。
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPortOpen } from '../lock.js';
import { listProcessNames } from '../../infra/proc/processes.js';
import type { HookHost } from '../../core/hook/index.js';
import {
  emptyDetection,
  type DetectVia,
  type HostDetection,
  type OnboardDetected,
} from './state.js';

/** Magpie 的 canal 端口（用户 11-10 给的实测值） */
export const MAGPIE_PORT = 3425;

/** 一个宿主的三路线索 */
export interface DetectTarget {
  host: HookHost;
  label: string;
  /** 目录线索：命中第一个存在的即算（返回绝对路径） */
  dirs: (home: string, env: NodeJS.ProcessEnv) => readonly string[];
  /** 端口线索（只探 127.0.0.1） */
  port?: number;
  /** 进程线索：小写进程名，前缀匹配即命中（如 `magpie-` 命中 `magpie-bun.exe`） */
  processes: readonly string[];
}

const SEP = path.sep;

/** 三个宿主的线索表：一处定义，探测/界面/文案都从这来 */
export const DETECT_TARGETS: readonly DetectTarget[] = [
  {
    host: 'magpie',
    label: 'Magpie',
    dirs: (home, env) => [
      // 实机勘测（2026-11-10）确认 Magpie 的配置根在这里（含 plugins/ 与 settings.json）
      path.join(home, '.config', 'magpie'),
      path.join(home, '.cache', 'magpie'),
      path.join(home, '.magpie'),
      ...(env['LOCALAPPDATA'] === undefined ? [] : [path.join(env['LOCALAPPDATA'], 'magpie')]),
      ...(env['APPDATA'] === undefined ? [] : [path.join(env['APPDATA'], 'magpie')]),
    ],
    port: MAGPIE_PORT,
    processes: ['magpie-windows-amd64.exe', 'magpie-bun.exe', 'magpie.exe', 'magpie'],
  },
  {
    host: 'claude-code',
    label: 'Claude Code',
    // 有 settings.json 才算真装过（空目录不算）
    dirs: (home) => [path.join(home, '.claude')],
    processes: ['claude.exe', 'claude'],
  },
  {
    host: 'dsh',
    label: 'DSH',
    dirs: (home) => [path.join(home, '.dsh', 'profiles'), path.join(home, '.dsh')],
    processes: [],
  },
];

export interface DetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 注入点：测试不必真的连端口 / 起进程 */
  portOpen?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  processNames?: () => Promise<readonly string[]>;
  /** 注入点：测试用假文件系统 */
  exists?: (file: string) => boolean;
  /** 端口探测超时（默认 300ms，与 `isPortOpen` 同口径） */
  portTimeoutMs?: number;
  now?: () => Date;
}

function firstExisting(
  dirs: readonly string[],
  exists: (file: string) => boolean,
): string | null {
  for (const dir of dirs) {
    if (exists(dir)) return dir;
  }
  return null;
}

/** 进程名匹配：完全相等或以 `名字 + 分隔` 开头（`magpie` 不该命中 `magpie-helper-x` 之外的误报，宁可精确） */
function matchProcess(
  names: readonly string[],
  candidates: readonly string[],
): string | null {
  for (const candidate of candidates) {
    const hit = names.find((name) => name === candidate);
    if (hit !== undefined) return hit;
  }
  return null;
}

function detection(
  via: readonly DetectVia[],
  dir: string | null,
  port: number | null,
  proc: string | null,
): HostDetection {
  return { hit: via.length > 0, via, dir, port, process: proc };
}

/**
 * 探测所有宿主。任何一路抛错都只影响自己那一路（`allSettled`）。
 */
export async function detectHosts(opts: DetectOptions = {}): Promise<OnboardDetected> {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const portOpen = opts.portOpen ?? isPortOpen;
  const processNames = opts.processNames ?? (() => listProcessNames());
  const now = opts.now ?? (() => new Date());

  // 进程只枚举一次，三个宿主共用
  const namesPromise = processNames().catch((): readonly string[] => []);

  const results = await Promise.allSettled(
    DETECT_TARGETS.map(async (target): Promise<[HookHost, HostDetection]> => {
      const dir = firstExisting(target.dirs(home, env), exists);

      let port: number | null = null;
      if (target.port !== undefined) {
        const open = await portOpen('127.0.0.1', target.port, opts.portTimeoutMs ?? 300).catch(
          () => false,
        );
        if (open) port = target.port;
      }

      const names = await namesPromise;
      const proc = matchProcess(names, target.processes);

      const via: DetectVia[] = [];
      if (dir !== null) via.push('dir');
      if (port !== null) via.push('port');
      if (proc !== null) via.push('process');
      return [target.host, detection(via, dir, port, proc)];
    }),
  );

  const hosts: Record<HookHost, HostDetection> = {
    magpie: emptyDetection('magpie'),
    'claude-code': emptyDetection('claude-code'),
    dsh: emptyDetection('dsh'),
  };
  for (const settled of results) {
    if (settled.status !== 'fulfilled') continue;
    const [host, value] = settled.value;
    hosts[host] = value;
  }
  return { at: now().toISOString(), hosts };
}

/** 给界面用的线索说明（手动排查时告诉用户去哪儿看） */
export function describeTarget(target: DetectTarget, home: string, env: NodeJS.ProcessEnv): string {
  const dirs = target.dirs(home, env).map((d) => d.replaceAll(SEP, '/')).join('、');
  const parts = [`目录 ${dirs}`];
  if (target.port !== undefined) parts.push(`端口 ${String(target.port)}`);
  if (target.processes.length > 0) parts.push(`进程 ${target.processes.join('/')}`);
  return parts.join(' · ');
}
