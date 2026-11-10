/**
 * Magpie 插件安装器（Z-01C-i / 设计 §16.6）。
 *
 * **实测到的 Magpie 插件形态**（2026-11-10，`~/.config/magpie/`）：
 * - `plugins/` 是一个 bun 工程：`package.json` + `bun.lock` + `node_modules/`；
 * - `plugins.json` 是"要装哪些"的清单，形如 `{"plugins":[{"spec":"@scope/name@latest"}]}`；
 * - 宿主从这份清单解析出包目录，再按 `package.json` 的 main/exports 加载模块、读 `magpie.hooks`。
 *
 * 所以本地包安装 = **把包放进 `plugins/node_modules/<name>/` + 往 `plugins.json` 追加 spec**。
 * 不依赖网络、不调 bun（调 bun 会改 `bun.lock`，卸载时更难还原）。
 *
 * 三条硬约束：
 * 1. **写盘只走例外通道**：白名单只加"这一个目标根 + 数据目录"，绝不复用 `dataRootsOf()`；
 * 2. **plan 与 apply 必须同源**：`plan()` 产出的 `steps` 就是 `apply()` 逐条执行的那份清单
 *    （验收 AC-11 断言"清单路径集合 === 实际写入集合"）；
 * 3. **失败可回滚**：`plugins.json` 改动前原文存进 `installs[].backup`，卸载按记录反推。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeEnsureDir,
  safeRemoveDir,
  safeRemoveFile,
  safeWriteFile,
  type WriteRoots,
} from '../../infra/fs/safeWrite.js';
import { MoshiError } from '../../domain/errors.js';
import type { HookHost } from '../../core/hook/index.js';
import {
  INSTALL_KEYS,
  patchOnboarding,
  readOnboarding,
  type InstallRecord,
} from './state.js';

/** 插件包在 moshi 工程里的目录名（`packages/magpie-moshi` → `dist/magpie-moshi`） */
export const PLUGIN_PACKAGE_NAME = 'magpie-moshi';
/** 装进 Magpie 后用的包名（目录名；plugins.json 的 spec 也用这个） */
export const PLUGIN_INSTALL_NAME = 'magpie-moshi';
/** 需要拷贝的文件（清单固定：多拷少拷都会让宿主加载失败） */
export const PLUGIN_FILES = ['hook.cjs', 'identity.cjs', 'index.cjs', 'package.json'] as const;
/** 环境变量覆盖目标根（测试与非常规安装位置用） */
export const PLUGIN_DIR_ENV = 'MOSHI_MAGPIE_PLUGIN_DIR';

/** Magpie 插件工程目录的候选（按顺序取第一个存在的） */
export function pluginRootCandidates(home: string, env: NodeJS.ProcessEnv): readonly string[] {
  const override = env[PLUGIN_DIR_ENV];
  if (override !== undefined && override.trim() !== '') return [path.resolve(override.trim())];
  return [
    path.join(home, '.config', 'magpie', 'plugins'),
    ...(env['LOCALAPPDATA'] === undefined ? [] : [path.join(env['LOCALAPPDATA'], 'magpie', 'plugins')]),
    path.join(home, '.cache', 'magpie', 'plugins'),
  ];
}

/** 计划里的一条动作：`路径` + `动作`，两列都要显示给用户（二次确认弹窗原样渲染） */
export interface InstallStep {
  action: '新增' | '修改' | '删除';
  path: string;
  note?: string;
}

export interface InstallPlan {
  host: HookHost;
  kind: 'hook' | 'mcp';
  /** false = 这条路本轮不支持/没找到目标（不是失败） */
  supported: boolean;
  /** 不支持或不可安装的原因，直接显示 */
  reason: string | null;
  root: string | null;
  version: string | null;
  steps: readonly InstallStep[];
  /** 已知不确定性（设计 §16.10 K7）：显示在确认弹窗底部，不隐藏 */
  risk: string | null;
}

export interface InstallOptions {
  dataDir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 注入源目录（测试用）；不传则自动找 dist/magpie-moshi → packages/magpie-moshi */
  sourceDir?: string;
  now?: () => Date;
}

export interface InstallOutcome {
  plan: InstallPlan;
  record: InstallRecord;
  /** 实际写/删的路径（与 plan.steps 的 path 集合逐一对应） */
  written: readonly string[];
}

const RISK_NOTE =
  'Magpie 以 npm spec 管理插件；本地包是否被宿主直接加载尚未端到端验证（需重启 Magpie 看 host 日志）。';

/** 从当前文件位置向上找工程根（含 packages/magpie-moshi 的那一层） */
function findSourceDir(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const candidates = [
      path.join(dir, 'dist', PLUGIN_PACKAGE_NAME),
      path.join(dir, 'packages', PLUGIN_PACKAGE_NAME),
      path.join(dir, PLUGIN_PACKAGE_NAME),
    ];
    for (const candidate of candidates) {
      if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveSourceDir(opts: InstallOptions): string | null {
  if (opts.sourceDir !== undefined) return opts.sourceDir;
  return findSourceDir(import.meta.dirname);
}

function resolveRoot(opts: InstallOptions): string | null {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  for (const candidate of pluginRootCandidates(home, env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 读 `plugins.json`，坏掉返回空清单（不抛：安装器不能因为一份 JSON 崩掉） */
function readPluginsJson(root: string): { raw: string | null; specs: readonly string[] } {
  const file = path.join(root, 'plugins.json');
  if (!existsSync(file)) return { raw: null, specs: [] };
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { plugins?: unknown }).plugins;
    const specs = Array.isArray(list)
      ? list
          .map((item) => (typeof item === 'object' && item !== null ? (item as { spec?: unknown }).spec : undefined))
          .filter((spec): spec is string => typeof spec === 'string' && spec !== '')
      : [];
    return { raw, specs };
  } catch {
    return { raw: null, specs: [] };
  }
}

function renderPluginsJson(existing: string | null, specs: readonly string[]): string {
  // 保留原有结构（用户可能手写了别的键），只替换 plugins 数组
  let base: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }
  base['plugins'] = specs.map((spec) => ({ spec }));
  return `${JSON.stringify(base, null, 2)}\n`;
}

/** 目标文件清单：一次算全，plan 与 apply 共用 */
function targetFiles(root: string): readonly { file: string; name: string }[] {
  const dest = path.join(root, 'node_modules', PLUGIN_INSTALL_NAME);
  return PLUGIN_FILES.map((name) => ({ file: path.join(dest, name), name }));
}

function readVersion(sourceDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

/** Hook 类安装计划（本轮唯一真实装项） */
export function planMagpieHook(opts: InstallOptions): InstallPlan {
  const base: Omit<InstallPlan, 'supported' | 'reason' | 'steps'> = {
    host: 'magpie',
    kind: 'hook',
    root: null,
    version: null,
    risk: RISK_NOTE,
  };
  const root = resolveRoot(opts);
  if (root === null) {
    return {
      ...base,
      supported: false,
      reason: '没找到 Magpie 插件目录（~/.config/magpie/plugins、%LOCALAPPDATA%/magpie/plugins 均不存在）',
      steps: [],
    };
  }
  const sourceDir = resolveSourceDir(opts);
  if (sourceDir === null) {
    return {
      ...base,
      root,
      supported: false,
      reason: '安装包没打包进当前版本（dist/magpie-moshi 与 packages/magpie-moshi 都不存在）',
      steps: [],
    };
  }
  const version = readVersion(sourceDir);
  const spec = version === null ? PLUGIN_INSTALL_NAME : `${PLUGIN_INSTALL_NAME}@${version}`;
  const pluginsFile = path.join(root, 'plugins.json');
  const { specs } = readPluginsJson(root);
  const specsNext = specs.includes(spec) ? specs : [...specs, spec];
  const files = targetFiles(root);

  const steps: InstallStep[] = files.map((item) => ({
    action: existsSync(item.file) ? '修改' : '新增',
    path: item.file,
    note: `来自 ${path.join(sourceDir, item.name)}`,
  }));
  const pluginsAction: InstallStep['action'] =
    specs.length === specsNext.length ? '修改' : existsSync(pluginsFile) ? '修改' : '新增';
  steps.push({
    action: pluginsAction,
    path: pluginsFile,
    note: specs.length === specsNext.length ? '已在清单中，仅确保可加载' : `追加 spec：${spec}`,
  });

  return { ...base, root, version, supported: true, reason: null, steps };
}

/** MCP 类本轮只显示（设计 §16.7），计划恒为 unsupported */
export function planMcp(host: HookHost): InstallPlan {
  return {
    host,
    kind: 'mcp',
    supported: false,
    reason: 'MCP 安装本轮未实现（设计 §16.7：只显示不处理）',
    root: null,
    version: null,
    steps: [],
    risk: null,
  };
}

/** 安装记录键：hook 类按客户端 */
export function installKey(host: HookHost, kind: 'hook' | 'mcp'): string {
  if (kind === 'mcp') {
    if (host === 'magpie') return INSTALL_KEYS.magpieMcp;
    return host === 'claude-code' ? INSTALL_KEYS.claudeMcp : INSTALL_KEYS.dshMcp;
  }
  if (host === 'magpie') return INSTALL_KEYS.magpieHook;
  return host === 'claude-code' ? INSTALL_KEYS.claudeHook : INSTALL_KEYS.dshHook;
}

/**
 * 真装。**调用前提**：用户在二次确认里点了"确认安装"（`confirm: true`）。
 * 白名单 = 数据目录 + 本机这一个插件根：这是唯一的例外通道，不得再扩大。
 */
export function applyMagpieHook(opts: InstallOptions & { confirm: boolean }): InstallOutcome {
  const plan = planMagpieHook(opts);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const key = installKey('magpie', 'hook');
  if (!plan.supported || plan.root === null) {
    const record: InstallRecord = {
      state: 'unsupported',
      at: now,
      path: null,
      version: null,
      reason: plan.reason,
      files: [],
      backup: null,
    };
    patchOnboarding(opts.dataDir, { installs: { ...readOnboarding(opts.dataDir).installs, [key]: record } }, [
      opts.dataDir,
    ]);
    return { plan, record, written: [] };
  }
  if (!opts.confirm) {
    // 未确认不写盘：返回计划本身，由界面继续显示确认弹窗
    return {
      plan,
      record: {
        state: 'absent',
        at: null,
        path: plan.root,
        version: plan.version,
        reason: '未确认',
        files: [],
        backup: null,
      },
      written: [],
    };
  }

  const sourceDir = resolveSourceDir(opts);
  if (sourceDir === null) {
    throw new MoshiError('E_NOT_FOUND', '安装源目录不存在');
  }
  const roots: WriteRoots = [opts.dataDir, plan.root];
  const pluginsFile = path.join(plan.root, 'plugins.json');
  const backup = existsSync(pluginsFile) ? readFileSync(pluginsFile, 'utf8') : null;
  const { specs } = readPluginsJson(plan.root);
  const spec = plan.version === null ? PLUGIN_INSTALL_NAME : `${PLUGIN_INSTALL_NAME}@${plan.version}`;
  const specsNext = specs.includes(spec) ? specs : [...specs, spec];
  const written: string[] = [];

  try {
    for (const item of targetFiles(plan.root)) {
      const source = path.join(sourceDir, item.name);
      if (!existsSync(source)) throw new MoshiError('E_NOT_FOUND', `安装源文件缺失：${source}`);
      safeEnsureDir(path.dirname(item.file), roots);
      safeWriteFile(item.file, readFileSync(source, 'utf8'), roots);
      written.push(item.file);
    }
    safeWriteFile(pluginsFile, renderPluginsJson(backup, specsNext), roots);
    written.push(pluginsFile);
  } catch (err) {
    const record: InstallRecord = {
      state: 'failed',
      at: now,
      path: plan.root,
      version: plan.version,
      reason: err instanceof Error ? err.message : String(err),
      files: written,
      backup,
    };
    patchOnboarding(
      opts.dataDir,
      { installs: { ...readOnboarding(opts.dataDir).installs, [key]: record } },
      [opts.dataDir],
    );
    return { plan, record, written };
  }

  const record: InstallRecord = {
    state: 'installed',
    at: now,
    path: plan.root,
    version: plan.version,
    reason: null,
    files: written,
    backup,
  };
  patchOnboarding(
    opts.dataDir,
    { installs: { ...readOnboarding(opts.dataDir).installs, [key]: record } },
    [opts.dataDir],
  );
  return { plan, record, written };
}

/**
 * 卸载：按记录删除文件 + 还原 `plugins.json`。
 * 记录里 `files` 为空（例如 state=unsupported/absent）时什么也不做，只把状态标回 absent。
 */
export function uninstallMagpieHook(opts: InstallOptions): InstallOutcome {
  const key = installKey('magpie', 'hook');
  const state = readOnboarding(opts.dataDir);
  const record = state.installs[key];
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const plan: InstallPlan = {
    host: 'magpie',
    kind: 'hook',
    supported: record !== undefined && record.state === 'installed',
    reason: record !== undefined && record.state === 'installed' ? null : '没有可卸载的安装记录',
    root: record?.path ?? null,
    version: record?.version ?? null,
    steps: [],
    risk: null,
  };
  if (record === undefined || record.state !== 'installed' || record.path === null) {
    return { plan, record: record ?? { state: 'absent', at: null, path: null, version: null, reason: null, files: [], backup: null }, written: [] };
  }
  const roots: WriteRoots = [opts.dataDir, record.path];
  const written: string[] = [];
  for (const file of record.files) {
    safeRemoveFile(file, roots);
    written.push(file);
  }
  // 包目录空了就一并删（只在它确实位于 node_modules/magpie-moshi 时）
  const destDir = path.join(record.path, 'node_modules', PLUGIN_INSTALL_NAME);
  if (existsSync(destDir) && readdirSync(destDir).length === 0) {
    safeRemoveDir(destDir, roots);
  }
  // 还原 plugins.json：有备份就写回原文，没备份就剔除我们的 spec
  const pluginsFile = path.join(record.path, 'plugins.json');
  if (record.backup !== null) {
    safeWriteFile(pluginsFile, record.backup, roots);
    written.push(pluginsFile);
  } else {
    const { specs } = readPluginsJson(record.path);
    const filtered = specs.filter((spec) => !spec.startsWith(`${PLUGIN_INSTALL_NAME}@`) && spec !== PLUGIN_INSTALL_NAME);
    if (filtered.length !== specs.length) {
      safeWriteFile(pluginsFile, renderPluginsJson(null, filtered), roots);
      written.push(pluginsFile);
    }
  }
  const nextRecord: InstallRecord = {
    state: 'absent',
    at: now,
    path: record.path,
    version: record.version,
    reason: null,
    files: [],
    backup: null,
  };
  patchOnboarding(
    opts.dataDir,
    { installs: { ...state.installs, [key]: nextRecord } },
    [opts.dataDir],
  );
  return { plan, record: nextRecord, written };
}
