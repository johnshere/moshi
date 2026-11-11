/**
 * `moshi hook` 子命令（Z-01C / 设计 §12.2）。
 *
 * 四个动作：
 *
 * - `status`  只看不写：daemon 起没起、钩子开没开、工程身份是哪一档（`create=false`，
 *             绝不因为看一眼就在别人仓库里落下 `.moshi/`）；
 * - `diagnose`（别名 `doctor`）：与入口 caps 表对照，报告"哪些时机兑现、哪些是 absent"；
 * - `recall`  手动跑一次召回，打印会被注入的原文（调 `hook.cjs` 的同一套 HTTP 面）；
 * - `launch`  由 `magpie.cmd` 调用：必要时起 daemon、置连接态、建立工程身份、开界面。
 *
 * 纪律：除 `launch` 外**不写任何文件**；`launch` 的写操作全部走 HTTP（daemon 侧）或
 * 显式的 safeWrite，`.moshi/project.yaml` 的创建在 daemon 那边做。
 */
import type { Command, CommandContext } from '../types.js';
import {
  LAUNCH_USAGE,
  daemonBaseUrl,
  hookPageUrl,
  parseLaunchArgs,
} from '../launch.js';
import { inspectLock, readLock } from '../../lock.js';
import { dataPaths } from '../../config.js';
import { resolveProjectIdentity } from '../../hook/projectIdentity.js';

const USAGE = [
  '用法：moshi hook <status|diagnose|recall|trace|launch> [args]',
  '',
  '  status            看当前钩子状态（只读）',
  '  diagnose          与入口能力表对照，报告哪些时机兑现（只读）',
  '  recall <text>     跑一次召回，打印会注入的文本',
  '  trace [条数]      看插件运行日志（默认 20 条；档位由 hook_plugin_trace.level 决定）',
  '  launch [--from=magpie] [--cwd=<dir>] [--open]   由 magpie.cmd 调用',
].join('\n');

/** daemon 的当前地址：优先用 lock 文件（真实的端口/token），其次用配置 */
async function daemonTarget(ctx: CommandContext): Promise<{ base: string; token: string | null; live: boolean }> {
  const lockFile = dataPaths(ctx.cfg).lock;
  const info = readLock(lockFile);
  if (info !== null) {
    return {
      base: daemonBaseUrl(ctx.cfg.server.host, info.port),
      token: info.token,
      live: (await inspectLock(lockFile, ctx.cfg.server.host)).kind === 'live',
    };
  }
  return {
    base: daemonBaseUrl(ctx.cfg.server.host, ctx.cfg.server.port),
    token: null,
    live: false,
  };
}

async function getJson(url: string, token: string | null, budgetMs = 2000): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token !== null) headers['x-moshi-token'] = token;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(budgetMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function postJson(url: string, token: string | null, body: unknown, budgetMs = 3000): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['x-moshi-token'] = token;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(budgetMs),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function runStatus(ctx: CommandContext): Promise<number> {
  const target = await daemonTarget(ctx);
  ctx.stdout(`daemon: ${target.live ? `运行中 ${target.base}` : `未运行（期望 ${target.base}）`}\n`);
  // 只读识别：create=false，看一眼不会往目录里落文件
  const project = resolveProjectIdentity(process.cwd(), { create: false });
  ctx.stdout(
    `工程: ${project.projectId ?? '(未知)'} · \ · ${project.reason}\n`,
  );
  if (!target.live) return 3;
  try {
    const status = (await getJson(`${target.base}/hook/api/status`, target.token)) as Record<string, unknown>;
    const sw = (status['switches'] ?? {}) as Record<string, unknown>;
    ctx.stdout(
      [
        `连接: ${status['connected'] === true ? '已连接' : '未连接'}`,
        `开关: 总 ${bool(sw['enabled'])} / 注入 ${bool(sw['inject_existing'])} / 输出记忆 ${bool(sw['capture_reply'])}`,
        `插件日志: ${String(status['trace_size'] ?? 0)} 条`,
      ].join('\n') + '\n',
    );
    return 0;
  } catch (err) {
    ctx.stderr(`读状态失败：${messageOf(err)}\n`);
    return 1;
  }
}

async function runDiagnose(ctx: CommandContext): Promise<number> {
  const target = await daemonTarget(ctx);
  if (!target.live) {
    ctx.stderr(`daemon 未运行，先 \`moshi start\`（期望 ${target.base}）\n`);
    return 3;
  }
  try {
    const caps = (await getJson(`${target.base}/hook/api/caps`, target.token)) as {
      hosts?: Record<string, { turns?: string[]; inject?: boolean; replyBody?: boolean }>;
    };
    const magpie = caps.hosts?.['magpie'];
    const turns = magpie?.turns ?? [];
    const all = ['session_start', 'user_prompt', 'post_tool', 'response', 'stop', 'pre_compact', 'session_end'];
    ctx.stdout('Magpie 入口能力：\n');
    for (const t of all) {
      ctx.stdout(`  ${turns.includes(t) ? '✔' : '✘(absent)'}  ${t}\n`);
    }
    ctx.stdout(
      `  inject=${magpie?.inject === true ? 'yes' : 'no'} replyBody=${magpie?.replyBody === true ? 'yes' : 'no'}\n`,
    );
    const identity = resolveProjectIdentity(process.cwd(), { create: false });
    ctx.stdout(`工程身份: ${identity.source} · ${identity.reason}\n`);
    return 0;
  } catch (err) {
    ctx.stderr(`诊断失败：${messageOf(err)}\n`);
    return 1;
  }
}

async function runRecall(ctx: CommandContext): Promise<number> {
  const text = ctx.args.join(' ').trim();
  if (text === '') {
    ctx.stderr('要一个查询文本：moshi hook recall "..."\n');
    return 2;
  }
  const target = await daemonTarget(ctx);
  if (!target.live) {
    ctx.stderr(`daemon 未运行（期望 ${target.base}）\n`);
    return 3;
  }
  try {
    const result = (await postJson(
      `${target.base}/hook/api/recall`,
      target.token,
      {
        schema: 'moshi-hook/1',
        host: 'magpie',
        turn: 'user_prompt',
        ts: new Date().toISOString(),
        identity: { moshi_id: null, project_id: null, identity_source: 'unknown' },
        caps: {
          turns: ['user_prompt', 'response'],
          inject: true,
          injectModes: ['system-append'],
          replyBody: true,
          configWrite: true,
          budget: { phaseMs: 1000, deadlineMs: 800 },
        },
        budget: { deadlineMs: 800, phaseTimeoutMs: 1000 },
        session: { id: null, source: 'magpie' },
        project: { cwd: process.cwd(), identitySource: 'unknown' },
        payload: { text },
      },
    )) as { inject?: boolean; text?: string; degraded?: string[] };
    ctx.stdout(`inject=${result.inject === true ? 'yes' : 'no'} degraded=${(result.degraded ?? []).join(',') || '-'}\n`);
    if (typeof result.text === 'string' && result.text !== '') ctx.stdout(`${result.text}\n`);
    return 0;
  } catch (err) {
    ctx.stderr(`召回失败：${messageOf(err)}\n`);
    return 1;
  }
}

async function runTrace(ctx: CommandContext): Promise<number> {
  const maybe = ctx.args[0] ?? '20';
  const limit = Number.parseInt(maybe, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    ctx.stderr('用法：moshi hook trace [条数]\n');
    return 2;
  }
  const target = await daemonTarget(ctx);
  if (!target.live) {
    ctx.stderr(`daemon 未运行（期望 ${target.base}）\n`);
    return 3;
  }
  try {
    const snap = (await getJson(`${target.base}/hook/api/trace?limit=${limit}`, target.token)) as {
      items?: Record<string, unknown>[];
    };
    const items = snap.items ?? [];
    if (items.length === 0) {
      ctx.stdout('插件日志为空（还没发生过召回或落库）\n');
      return 0;
    }
    for (const item of items) {
      const corr = item['corr_id'] === undefined ? '' : `  corr ${String(item['corr_id']).slice(0, 8)}`;
      ctx.stdout(
        `${String(item['ts'])}  ${String(item['turn'])}  ${String(item['status'])}  ` +
          `证据 ${String(item['evidence'] ?? 0)}  ${String(item['inject_bytes'] ?? 0)}B  ` +
          `${String(item['latency_ms'] ?? 0)}ms  ${String(item['identity_source'] ?? '-')}${corr}\n`,
      );
      // summary 档起才有下面这些：证据 id/分数、分阶段耗时
      if (Array.isArray(item['evidence_ids'])) {
        const ids = item['evidence_ids'] as number[];
        const scores = Array.isArray(item['evidence_scores']) ? (item['evidence_scores'] as number[]) : [];
        ctx.stdout(`  ${ids.map((id, i) => `M${id}${scores[i] === undefined ? '' : `(${scores[i]})`}`).join(' ')}\n`);
      }
      if (item['stage_ms'] !== undefined && typeof item['stage_ms'] === 'object') {
        const stage = item['stage_ms'] as Record<string, number>;
        ctx.stdout(
          `  耗时 检索 ${stage['search'] ?? '-'}ms / 渲染 ${stage['render'] ?? '-'}ms / 总 ${stage['total'] ?? '-'}ms\n`,
        );
      }
      if (item['captured'] !== undefined) {
        ctx.stdout(`  落库 ${item['captured'] === true ? 'yes' : 'no'}${item['duplicate'] === true ? '（重复）' : ''}\n`);
      }
      // full 档才落正文；打出来时压成一行并截断，避免刷屏
      for (const key of ['query_text', 'inject_text', 'reply_text'] as const) {
        const value = item[key];
        if (typeof value === 'string' && value !== '') {
          ctx.stdout(`  ${key}: ${value.replace(/\s+/g, ' ').slice(0, 200)}\n`);
        }
      }
    }
    return 0;
  } catch (err) {
    ctx.stderr(`读插件日志失败：${messageOf(err)}\n`);
    return 1;
  }
}

async function runLaunch(ctx: CommandContext): Promise<number> {
  const options = parseLaunchArgs(ctx.args);
  if (options === null) {
    ctx.stderr(`${LAUNCH_USAGE}\n`);
    return 2;
  }
  const target = await daemonTarget(ctx);
  if (!target.live) {
    // 不起 daemon：那是一个长驻进程，起它的时机应在安装器/用户手上。
    // 这里如实说不通，让用户知道要先 start，而不是假装成功。
    ctx.stderr(`daemon 未运行：先执行 \`moshi start\`（期望 ${target.base}）\n`);
    return 3;
  }
  try {
    if (options.fromMagpie) {
      await postJson(`${target.base}/hook/api/config`, target.token, { action: 'connect' });
      if (options.cwd !== null) {
        await postJson(`${target.base}/hook/api/identity`, target.token, { cwd: options.cwd });
      }
    }
    const url = hookPageUrl(target.base, options.fromMagpie);
    ctx.stdout(`${url}\n`);
    if (options.open) {
      ctx.stdout('（请手动打开上面的地址；本命令不代开浏览器）\n');
    }
    return 0;
  } catch (err) {
    ctx.stderr(`启动失败：${messageOf(err)}\n`);
    return 1;
  }
}

function bool(v: unknown): string {
  return v === true ? '开' : '关';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const hookCommand: Command = {
  name: 'hook',
  summary: '钩子入口：状态/诊断/召回/插件运行日志/拉起界面（Z-01C）',
  async run(ctx: CommandContext): Promise<number> {
    const sub = ctx.args[0];
    if (sub === undefined || sub === 'help' || sub === '--help') {
      ctx.stdout(`${USAGE}\n`);
      return sub === undefined ? 2 : 0;
    }
    const rest: CommandContext = { ...ctx, args: ctx.args.slice(1) };
    switch (sub) {
      case 'status':
        return runStatus(rest);
      case 'diagnose':
      case 'doctor':
        return runDiagnose(rest);
      case 'recall':
        return runRecall(rest);
      case 'trace':
        return runTrace(rest);
      case 'launch':
        return runLaunch(rest);
      default:
        ctx.stderr(`未知子命令：${sub}\n${USAGE}\n`);
        return 2;
    }
  },
};
