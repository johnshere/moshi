/**
 * 入驻状态文件（Z-01C-h / 设计 §16.3）：`<data_dir>/onboarding.json`。
 *
 * 这份文件是**唯一**的入驻事实源，三件事都靠它：
 * 1. 首启弹窗"只弹一次"要有持久标记（`dialog_shown`）；
 * 2. 卸载/回滚只能按记录的 `path` + `version` + `files` 反推（安装器不猜路径）；
 * 3. 诊断页可读：客户报障时直接看这份文件。
 *
 * **容错优先**：文件缺失、JSON 坏掉、字段类型不对，一律当"首次"处理并补全默认值。
 * 安装状态读错最坏是再装一次，弹窗读错最坏是再引导一次；两者都比白屏好。
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { safeWriteFile, type WriteRoots } from '../../infra/fs/safeWrite.js';
import type { HookHost } from '../../core/hook/index.js';

/** 状态文件 schema（单独一个版本号：协议是 `moshi-hook/1`，这份是 UI 侧状态） */
export const ONBOARD_SCHEMA = 'moshi-onboarding/1';
/** 文件名（落在数据目录根，与 `config.toml` 并列） */
export const ONBOARD_FILE = 'onboarding.json';

/** 命中的探测手段 */
export type DetectVia = 'dir' | 'port' | 'process';

/** 单个宿主的探测结果：`via` 是"凭什么判定它在"的证据，空数组即未检测到 */
export interface HostDetection {
  hit: boolean;
  via: readonly DetectVia[];
  /** 命中的目录（第一种手段），没有就是 null */
  dir: string | null;
  /** 命中的端口，没有就是 null */
  port: number | null;
  /** 命中的进程名，没有就是 null */
  process: string | null;
}

/** 一次探测的整体结果 */
export interface OnboardDetected {
  at: string;
  hosts: Record<HookHost, HostDetection>;
}

/** 安装状态：`unsupported` 是"这条路本轮不支持"（不是失败），`failed` 才是真失败 */
export type InstallState = 'absent' | 'installed' | 'failed' | 'unsupported';

/** 一条安装记录（`installs[<key>]`），卸载按 `files` 反推 */
export interface InstallRecord {
  state: InstallState;
  at: string | null;
  /** 安装目标目录（失败时可能是 null） */
  path: string | null;
  version: string | null;
  /** `failed` / `unsupported` 的原因，直接显示在界面上 */
  reason: string | null;
  /** 实际写过的文件绝对路径；卸载逐个删（删不存在的路径不算错） */
  files: readonly string[];
  /** 改动前的原文（本轮 Magpie 只新增文件、不改配置，先留 null，将来改配置再用） */
  backup: string | null;
}

export interface OnboardState {
  schema: string;
  /** 第一次打开界面的时刻；null = 还没打开过 */
  first_open_at: string | null;
  /** 首启弹窗已经弹过（关掉也置 true：用户已见过，不再自动弹） */
  dialog_shown: boolean;
  dialog_closed_at: string | null;
  /** 最近一次探测结果（缓存；`null` = 还没探测过） */
  detected: OnboardDetected | null;
  installs: Record<string, InstallRecord>;
}

/** 安装记录的键：一处定义，界面/路由/测试都用它 */
export const INSTALL_KEYS = {
  magpieHook: 'magpie-hook',
  magpieMcp: 'magpie-mcp',
  claudeHook: 'claude-code-hook',
  claudeMcp: 'claude-code-mcp',
  dshHook: 'dsh-hook',
  dshMcp: 'dsh-mcp',
} as const;

/** 空探测结果；`_host` 只为让 Record 的三个键在调用处自解释，值本身与宿主无关 */
export function emptyDetection(_host: HookHost): HostDetection {
  return { hit: false, via: [], dir: null, port: null, process: null };
}

export function emptyOnboarding(): OnboardState {
  return {
    schema: ONBOARD_SCHEMA,
    first_open_at: null,
    dialog_shown: false,
    dialog_closed_at: null,
    detected: null,
    installs: {},
  };
}

export function onboardingPath(dataDir: string): string {
  return path.join(dataDir, ONBOARD_FILE);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function viaOf(value: unknown): readonly DetectVia[] {
  if (!Array.isArray(value)) return [];
  const out: DetectVia[] = [];
  for (const item of value) {
    if (item === 'dir' || item === 'port' || item === 'process') out.push(item);
  }
  return out;
}

function detectionOf(value: unknown): HostDetection | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const port = typeof raw['port'] === 'number' && Number.isFinite(raw['port']) ? raw['port'] : null;
  return {
    hit: bool(raw['hit']),
    via: viaOf(raw['via']),
    dir: str(raw['dir']),
    port,
    process: str(raw['process']),
  };
}

function recordOf(value: unknown): InstallRecord | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const state = raw['state'];
  const normalized: InstallState =
    state === 'installed' || state === 'failed' || state === 'unsupported' ? state : 'absent';
  const files = Array.isArray(raw['files'])
    ? raw['files'].filter((f): f is string => typeof f === 'string')
    : [];
  return {
    state: normalized,
    at: str(raw['at']),
    path: str(raw['path']),
    version: str(raw['version']),
    reason: str(raw['reason']),
    files,
    backup: str(raw['backup']),
  };
}

/** 解析成完整状态；任何异常都退回空状态（见文件头"容错优先"） */
export function parseOnboarding(value: unknown): OnboardState {
  const base = emptyOnboarding();
  const raw = asRecord(value);
  if (raw === null) return base;
  const detectedRaw = asRecord(raw['detected']);
  let detected: OnboardDetected | null = null;
  if (detectedRaw !== null) {
    const hosts = asRecord(detectedRaw['hosts']);
    const at = str(detectedRaw['at']);
    if (hosts !== null && at !== null) {
      detected = {
        at,
        hosts: {
          magpie: detectionOf(hosts['magpie']) ?? emptyDetection('magpie'),
          'claude-code': detectionOf(hosts['claude-code']) ?? emptyDetection('claude-code'),
          dsh: detectionOf(hosts['dsh']) ?? emptyDetection('dsh'),
        },
      };
    }
  }
  const installs: Record<string, InstallRecord> = {};
  const installsRaw = asRecord(raw['installs']);
  if (installsRaw !== null) {
    for (const [key, item] of Object.entries(installsRaw)) {
      const parsed = recordOf(item);
      if (parsed !== null) installs[key] = parsed;
    }
  }
  return {
    schema: ONBOARD_SCHEMA,
    first_open_at: str(raw['first_open_at']),
    dialog_shown: bool(raw['dialog_shown']),
    dialog_closed_at: str(raw['dialog_closed_at']),
    detected,
    installs,
  };
}

/** 读状态文件；不存在/坏掉 → 空状态（调用方不需要 try/catch） */
export function readOnboarding(dataDir: string): OnboardState {
  const file = onboardingPath(dataDir);
  if (!existsSync(file)) return emptyOnboarding();
  try {
    return parseOnboarding(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch {
    return emptyOnboarding();
  }
}

/** 原子写回；白名单默认只有数据目录自己（安装目标另走安装器的例外通道） */
export function writeOnboarding(
  dataDir: string,
  state: OnboardState,
  roots: WriteRoots = [dataDir],
): void {
  safeWriteFile(onboardingPath(dataDir), `${JSON.stringify(state, null, 2)}\n`, roots);
}

/** 读 → 改 → 写（只做浅合并，够用；深层合并交给调用方自己拼完整对象） */
export function patchOnboarding(
  dataDir: string,
  patch: Partial<OnboardState>,
  roots?: WriteRoots,
): OnboardState {
  const next: OnboardState = { ...readOnboarding(dataDir), ...patch, schema: ONBOARD_SCHEMA };
  writeOnboarding(dataDir, next, roots);
  return next;
}

/** 默认数据目录（daemon 未配置 storage.data_dir 时与 `loadConfig` 同口径） */
export function defaultDataDir(home: string = os.homedir()): string {
  return path.join(home, '.moshi');
}
