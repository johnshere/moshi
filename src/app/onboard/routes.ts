/**
 * 入驻路由（Z-01C-h/i / 设计 §16.3~§16.6），前缀 `/hook/api`。
 *
 *   GET  /hook/api/onboard         → 入驻状态（onboarding.json 原样 + 是否该弹窗）
 *   POST /hook/api/onboard         → 记「打开过界面」「弹窗已关」
 *   POST /hook/api/detect          → 三路探测（60s 缓存；`?refresh=1` 强制重探）
 *   GET  /hook/api/install/plan    → 三类客户端 × 两类（插件 / MCP）的安装计划
 *   POST /hook/api/install         → 真装（**必须带 confirm:true**，否则只回计划）
 *   POST /hook/api/uninstall       → 按记录卸载
 *
 * **探测不进轮询**：`/hook/api/status` 5s 一次，若把 300ms 起的端口探测塞进去，
 * 界面会一直卡。探测单独端点 + 内存缓存，由用户点「重新探测」触发刷新（§16.3）。
 */
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { HOOK_HOSTS, type HookHost } from '../../core/hook/index.js';
import { detectHosts } from './detect.js';
import {
  applyMagpieHook,
  installKey,
  planMagpieHook,
  planMcp,
  uninstallMagpieHook,
  type InstallOptions,
  type InstallPlan,
} from './install.js';
import { patchOnboarding, readOnboarding, type OnboardState } from './state.js';

/** 探测缓存时长：60s 内重复调用直接回缓存（界面轮询不会打到进程枚举） */
export const DETECT_TTL_MS = 60_000;

export interface OnboardRoutesOpts {
  /** 数据目录（onboarding.json 落这里） */
  dataDir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 注入：测试不真跑 tasklist/net */
  detect?: typeof detectHosts;
  now?: () => Date;
}

/** 宿主显示名（界面与探测共用一套写法） */
export const HOST_LABELS: Record<HookHost, string> = {
  magpie: 'Magpie',
  'claude-code': 'Claude Code',
  dsh: 'DSH',
};

/**
 * 手动安装文案（设计 §16.6 R12）：**分两类**——插件版 / MCP 版，各客户端各一段。
 * 文案与设计 §7.3 / §11 同源，不另起一套说法。
 */
export const MANUAL_HOOK: Record<HookHost, string> = {
  magpie: [
    '1. 找到 Magpie 配置根：~/.config/magpie（plugins/ 是插件包目录，plugins.json 是注册表）',
    '2. 把安装器产出的包目录整个拷到 <配置根>/plugins/node_modules/moshi/（目录名就是插件名）',
    '3. 编辑 <配置根>/plugins.json（注册表在配置根，不在 plugins/ 里），追加 {"spec":"<该目录的绝对路径>"}',
    '4. 重启 Magpie（或结束 magpie-bun 让宿主重拉），app.log 出现该插件加载记录即生效',
  ].join('\n'),
  'claude-code': [
    '在 ~/.claude/settings.json 加 hooks 段（时机：UserPromptSubmit / PostToolUse / Stop）：',
    '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"moshi hook emit --host claude-code --turn user_prompt","timeout":30}]}]}}',
    '注意：一次性入口 `moshi hook emit` 尚未实现（设计 §12.3：本轮只登记），现在配了也跑不通。',
  ].join('\n'),
  dsh: 'DSH 需要宿主内插件（cordis.patch.yml 挂载），本轮未实现（设计 §11.2）。',
};

export const MANUAL_MCP: Record<HookHost, string> = {
  magpie: [
    '在 Magpie 的 MCP 配置文件里加入 moshi 服务端（MCP 版本轮未实现，仅列出格式）：',
    '{"mcpServers":{"moshi":{"command":"node","args":["<moshi 安装目录>/dist/app/main.js","mcp"]}}}',
  ].join('\n'),
  'claude-code': [
    '在 ~/.claude.json（或项目 .mcp.json）的 mcpServers 段加入：',
    '{"moshi":{"command":"node","args":["<moshi 安装目录>/dist/app/main.js","mcp"]}}',
  ].join('\n'),
  dsh: '在 DSH 的 MCP 配置里加入同样的 stdio 服务端条目（本轮只显示，不做写入）。',
};

export interface OnboardRoutesDeps {
  key(host: HookHost, kind: 'hook' | 'mcp'): string;
}

export async function onboardRoutes(
  app: FastifyInstance,
  opts: OnboardRoutesOpts,
): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const detectFn = opts.detect ?? detectHosts;
  const installOpts: InstallOptions = { dataDir: opts.dataDir, home, env, now };

  let cache: { at: number; value: Awaited<ReturnType<typeof detectHosts>> } | null = null;

  /** 只读状态 + 派生字段（界面一次拿全，不用二次请求） */
  const snapshot = (): Record<string, unknown> => {
    const state = readOnboarding(opts.dataDir);
    const detected = state.detected ?? cache?.value ?? null;
    return {
      schema: state.schema,
      first_open_at: state.first_open_at,
      dialog_shown: state.dialog_shown,
      dialog_closed_at: state.dialog_closed_at,
      detected,
      /** 是否该弹首启弹窗：没弹过 且 探测到至少一个宿主（探测不到就没有可勾的东西） */
      should_prompt: state.dialog_shown !== true && detected !== null && Object.values(detected.hosts).some((h) => h.hit),
      installs: state.installs,
      labels: HOST_LABELS,
      hosts: HOOK_HOSTS,
    };
  };

  const persistDetected = (value: Awaited<ReturnType<typeof detectHosts>>): void => {
    const state: OnboardState = readOnboarding(opts.dataDir);
    patchOnboarding(opts.dataDir, { ...state, detected: value }, [opts.dataDir]);
  };

  app.get('/onboard', async (_req, reply) => reply.send(snapshot()));

  app.post('/onboard', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = readOnboarding(opts.dataDir);
    const patch: Partial<OnboardState> = {};
    // 「打开过界面」只在第一次落：`first_open_at` 一旦有值就不再改
    if (body['open'] === true && state.first_open_at === null) patch.first_open_at = now().toISOString();
    if (body['dialog_shown'] === true) patch.dialog_shown = true;
    if (typeof body['dialog_closed_at'] === 'string') patch.dialog_closed_at = body['dialog_closed_at'];
    if (Object.keys(patch).length > 0) patchOnboarding(opts.dataDir, patch, [opts.dataDir]);
    return reply.send(snapshot());
  });

  app.post('/detect', async (req, reply) => {
    const url = req.url;
    const refresh = url.includes('refresh=1');
    const nowMs = Date.now();
    if (!refresh && cache !== null && nowMs - cache.at < DETECT_TTL_MS) {
      return reply.send({ detected: cache.value, cached: true });
    }
    const value = await detectFn({ home, env });
    cache = { at: nowMs, value };
    persistDetected(value);
    return reply.send({ detected: value, cached: false });
  });

  app.get('/install/plan', async (_req, reply) => {
    const plans: InstallPlan[] = [
      planMagpieHook(installOpts),
      planHookPlaceholder('claude-code'),
      planHookPlaceholder('dsh'),
      planMcp('magpie'),
      planMcp('claude-code'),
      planMcp('dsh'),
    ];
    return reply.send({
      plans,
      manual: { hook: MANUAL_HOOK, mcp: MANUAL_MCP },
      labels: HOST_LABELS,
      /** 界面直接用它渲染按钮文案（一处定义） */
      keys: plans.map((plan) => ({ host: plan.host, kind: plan.kind, key: installKey(plan.host, plan.kind) })),
    });
  });

  app.post('/install', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const host = body['host'];
    const kind = body['kind'];
    if (host !== 'magpie' || kind !== 'hook') {
      return reply.code(400).send({
        error: 'E_INPUT',
        message: '本轮只支持 host=magpie & kind=hook（MCP 类只显示，设计 §16.7）',
      });
    }
    const outcome = applyMagpieHook({ ...installOpts, confirm: body['confirm'] === true });
    return reply.send({
      ok: outcome.record.state === 'installed',
      plan: outcome.plan,
      record: outcome.record,
      written: outcome.written,
    });
  });

  app.post('/uninstall', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body['host'] !== 'magpie' || body['kind'] !== 'hook') {
      return reply.code(400).send({ error: 'E_INPUT', message: '本轮只支持 host=magpie & kind=hook' });
    }
    const outcome = uninstallMagpieHook(installOpts);
    return reply.send({ ok: true, plan: outcome.plan, record: outcome.record, written: outcome.written });
  });
}

/**
 * Claude Code / DSH 的 Hook 类：本轮**没有**一次性入口（`moshi hook emit` 未实现），
 * 所以计划恒为 unsupported——但界面仍要显示这一行（R11：每个客户端都有条目）。
 */
function planHookPlaceholder(host: HookHost): InstallPlan {
  return {
    host,
    kind: 'hook',
    supported: false,
    reason: HOST_LABELS[host] === 'Claude Code' ? '缺少一次性钩子入口（moshi hook emit 未实现）' : '缺少宿主内插件（设计 §11.2 未实现）',
    root: null,
    version: null,
    steps: [],
    risk: null,
  };
}
