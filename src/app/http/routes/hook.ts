/**
 * 钩子服务面路由（Z-01C / 设计 §8）。
 *
 * 前缀是 `/hook/api/*`（不是 `/api/*`）：鉴权口径相同，但前缀分开是因为
 * Magpie 的 hook.js 只认这一个前缀，免得和其它 API 混在一起写错。
 *
 * 端点清单：
 *   POST /hook/api/recall   → 注入指令（唯一会改请求的端点）
 *   POST /hook/api/signal   → 信号落库回执
 *   GET  /hook/api/status   → 连接态 + 三个开关 + 本机 caps
 *   POST /hook/api/config   → 三个开关 + 连接态（界面写，走 YAML 白名单）
 *   GET  /hook/api/trace    → 注入台账 ring buffer
 *   POST /hook/api/trace    → 清台账
 *   GET  /hook/api/caps     → 各入口能力（`moshi hook doctor` 用它对照实测）
 *
 * **失败姿态**：`recall` 永远 200。降级体现在 `inject:false` + `degraded` 里，
 * 而不是 HTTP 状态码——hook.js 收到 4xx/5xx 会整轮放弃，连"这轮为什么没注入"
 * 的台账都留不下来。
 */
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  HOOK_HOSTS,
  HOOK_SCHEMA,
  HOOK_TURN_NAMES,
  MAGPIE_CAPS,
  isHookTurn,
  type HookCaps,
  type HookEnvelope,
  type HookHost,
  type HookReportCode,
  type HookTraceItem,
  type TraceSink,
} from '../../../core/hook/index.js';
import { redactText } from '../../../core/write/redact.js';
import type { HookTraceStore } from '../../../core/hook/trace.js';
import type { Config } from '../../config.js';
import { mergeConfigDocument, readConfigDocument, writeConfigDocument } from '../../config.js';
import type { HookDeps } from '../../hook/service.js';
import { resolveProjectIdentity } from '../../hook/projectIdentity.js';
import { recallForHook, signalForHook } from '../../hook/service.js';

export interface HookRoutesOpts {
  deps: HookDeps;
  trace: HookTraceStore;
  /** 台账落盘（`<data_dir>/hook/trace-YYYY-MM-DD.jsonl`，三档裁剪在 core 里做） */
  sink: TraceSink;
  /** 配置文件路径（`/hook/api/config` 写这里） */
  configFile: string;
  token: string;
  /** 会话连接态（内存）与"已提示"标记；由 server.ts 注入 */
  connection: HookConnection;
}

/**
 * F8 的连接态。
 *
 * 两处状态要分开：
 * - `connected`：内存标志，`magpie.cmd` 拉起界面时置 true，界面点「断开」置 false；
 * - `prefs.magpie_enabled`：落盘标志，是"下次启动时是否自动连"的意图。
 *
 * 为什么不合并成一个：用户点过「断开」之后，下次 magpie.cmd 要能**区分**
 * "从没连过"与"明确断开过"——前者可以直接连，后者必须先提示
 * 「连接 Magpie 才能使用」。这个区分只能靠落盘的意图位。
 */
export interface HookConnection {
  connected: boolean;
  /** 用户明确点过「断开」；不落盘，进程重启即回到未断开 */
  explicitlyDisconnected: boolean;
  /** `magpie.cmd` 带 `?from=magpie` 打开界面时调用 */
  markConnected(): void;
  markDisconnected(): void;
}

export function createHookConnection(initial = false): HookConnection {
  let connected = initial;
  let disconnected = false;
  return {
    get connected() {
      return connected;
    },
    get explicitlyDisconnected() {
      return disconnected;
    },
    markConnected() {
      connected = true;
      disconnected = false;
    },
    markDisconnected() {
      connected = false;
      disconnected = true;
    },
  };
}

/** 各入口 caps 表（`moshi hook doctor` 与界面共用一份，不各自维护） */export const HOOK_HOST_CAPS: Record<HookHost, HookCaps> = {
  magpie: MAGPIE_CAPS,
  // Claude Code / DSH 本轮只设计不实现（用户 m00153），caps 先按设计写死，
  // 标 `design` 让界面能显示"未实现"，不用假数据骗人
  'claude-code': {
    turns: [...HOOK_TURN_NAMES],
    inject: true,
    injectModes: ['system-append', 'user-prefix'],
    replyBody: true,
    configWrite: true,
    budget: { phaseMs: 30000, deadlineMs: 8000 },
  },
  dsh: {
    turns: [...HOOK_TURN_NAMES],
    inject: true,
    injectModes: ['system-append'],
    replyBody: true,
    configWrite: true,
    budget: { phaseMs: 5000, deadlineMs: 2000 },
  },
};

/** 信封的最小校验：字段类型不对就不进管线（**不抛 400**，见文件头） */
function badEnvelope(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'body 不是对象';
  const e = body as Record<string, unknown>;
  if (e['schema'] !== HOOK_SCHEMA) return `schema 必须是 ${HOOK_SCHEMA}`;
  if (typeof e['host'] !== 'string' || !(HOOK_HOSTS as readonly string[]).includes(e['host'])) {
    return 'host 不认识';
  }
  if (!isHookTurn(e['turn'])) return 'turn 不认识';
  if (typeof e['ts'] !== 'string') return 'ts 必须是 ISO8601 字符串';
  return null;
}

export async function hookRoutes(app: FastifyInstance, opts: HookRoutesOpts): Promise<void> {
  const { deps, trace, connection } = opts;
  const cfg = (): Config => deps.cfg;

  // ── recall：唯一会改请求的端点 ──
  app.post('/recall', async (req, reply) => {
    const body = req.body;
    const problem = badEnvelope(body);
    if (problem !== null) {
      // 参数不对也不能让入口崩：回一个"不注入"，把原因写进台账
      const invalid: HookTraceItem = {
        ts: new Date().toISOString(),
        host: 'magpie',
        turn: 'user_prompt',
        status: 'invalid',
        inject_bytes: 0,
        evidence: 0,
        degraded: [problem],
        identity_source: 'unknown',
        latency_ms: 0,
      };
      trace.push(invalid);
      opts.sink.append(invalid);
      return reply.send({
        schema: HOOK_SCHEMA,
        inject: false,
        mode: 'system-append',
        text: '',
        evidence: [],
        degraded: ['invalid_envelope', problem],
        identity: { moshi_id: null, project_id: null, identity_source: 'unknown' },
        deadline_ms: 0,
      });
    }

    const started = Date.now();
    const outcome = await recallForHook(deps, body as HookEnvelope);
    const latency = Date.now() - started;
    // 回执号：入口存进请求级 state，response 时回带，把注入与落库对上（Z-01C-e）
    const corrId = randomBytes(8).toString('hex');
    const item: HookTraceItem = redactTrace(
      {
        ...outcome.trace,
        ts: new Date(started).toISOString(),
        latency_ms: latency,
        corr_id: corrId,
      },
      cfg(),
    );
    // 内存 ring 与落盘各一份；落盘档位/轮转/清理在 TraceSink 里（off 档不写盘）
    trace.push(item);
    opts.sink.append(item);
    // 诊断回包多带一个服务端算定的身份：moshi hook recall 与页面要看这个
    return reply.send({ ...outcome.injection, identity: outcome.identity, corr_id: corrId });
  });

  // ── signal：落 episode（幂等） ──
  app.post('/signal', async (req, reply) => {
    const body = req.body;
    const problem = badEnvelope(body);
    if (problem !== null) {
      return reply.code(400).send({ error: 'E_INPUT', message: problem });
    }
    const envelope = body as HookEnvelope;
    const started = Date.now();
    const result = signalForHook(deps, envelope);
    const replyText = envelope.payload.reply;
    const item: HookTraceItem = redactTrace(
      {
        ts: new Date(started).toISOString(),
        host: envelope.host,
        turn: envelope.turn,
        status: signalStatus(result),
        inject_bytes: 0,
        evidence: 0,
        degraded: result.reason === undefined ? [] : [result.reason],
        identity_source: envelope.identity.identity_source,
        latency_ms: Date.now() - started,
        captured: result.captured,
        duplicate: result.duplicate,
        ...(envelope.corr === undefined ? {} : { corr_id: envelope.corr }),
        ...(typeof replyText === 'string'
          ? {
              reply_sha256: sha16(replyText),
              ...(cfg().debug.trace_level === 'full' ? { reply_text: replyText } : {}),
            }
          : {}),
      },
      cfg(),
    );
    trace.push(item);
    opts.sink.append(item);
    return reply.send(result);
  });

  // ── status：界面首屏要的全部状态 ──
  app.get('/status', async (_req, reply) => {
    return reply.send({
      schema: HOOK_SCHEMA,
      connected: connection.connected,
      /** F8：断开过的情况下，界面先显示"连接 Magpie 才能使用" */
      needs_connect: !connection.connected && (connection.explicitlyDisconnected || !cfg().hook.magpie_enabled),
      host: 'magpie',
      caps: HOOK_HOST_CAPS.magpie,
      switches: {
        enabled: cfg().hook.enabled,
        inject_existing: cfg().hook.inject_existing,
        capture_reply: cfg().hook.capture_reply,
        magpie_enabled: cfg().hook.magpie_enabled,
      },
      trace_size: trace.size,
    });
  });

  // ── identity：`magpie.cmd` 拉起软件时建立工程身份（唯一会写宿主目录的端点） ──
  //
  // 这里做 `create='establish'` 而不是 `create=true`：见 `projectIdentity.ts` 的注释——
  // 界面先打开、钩子后触发的顺序下，只有这一档能让两边的 project_id 一致。
  app.post('/identity', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cwd = typeof body['cwd'] === 'string' ? body['cwd'] : null;
    const identity = resolveProjectIdentity(cwd, {
      create: 'establish',
      roots: [...new Set([deps.dataRoot, deps.hookDir, ...(deps.markerRoots ?? [])])],
    });
    return reply.send({
      schema: HOOK_SCHEMA,
      project: {
        project_id: identity.projectId,
        identity_source: identity.source,
        root: identity.root,
        remote: identity.remote,
        reason: identity.reason,
      },
    });
  });

  // ── caps：`moshi hook doctor` 与界面共用的能力表 ──
  app.get('/caps', async (_req, reply) => {
    return reply.send({ schema: HOOK_SCHEMA, hosts: HOOK_HOST_CAPS, trace_capacity: traceSize(trace) });
  });

  // ── config：三个开关 + 连接态（走 YAML 白名单，不当场改内存配置） ──
  app.post('/config', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of ['enabled', 'inject_existing', 'capture_reply', 'magpie_enabled'] as const) {
      const v = body[key];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') {
        return reply.code(400).send({ error: 'E_INPUT', message: `${key} 必须是布尔值` });
      }
      patch[key] = v;
    }
    if (body['action'] === 'disconnect') {
      patch['magpie_enabled'] = false;
      connection.markDisconnected();
    }
    if (body['action'] === 'connect') {
      patch['magpie_enabled'] = true;
      connection.markConnected();
    }
    if (Object.keys(patch).length > 0) {
      // 白名单 = 数据目录 + 配置文件所在目录。后者必须在：配置文件本来就归这里写，
      // 换了 data_dir 的话数据目录未必覆盖配置文件所在处（测试的临时 home 就是这样）。
      const roots = [
        ...new Set([...dataRootsOf(cfg()), path.dirname(opts.configFile)]),
      ];
      const doc = readConfigDocument(opts.configFile);
      writeConfigDocument(opts.configFile, mergeConfigDocument(doc, { hook: patch }), roots);
      // 内存配置同步改：否则要重启 daemon 才生效（用户点开关是当场的事）
      Object.assign(cfg().hook as Record<string, unknown>, patch);
    }
    return reply.send({
      schema: HOOK_SCHEMA,
      connected: connection.connected,
      switches: {
        enabled: cfg().hook.enabled,
        inject_existing: cfg().hook.inject_existing,
        capture_reply: cfg().hook.capture_reply,
        magpie_enabled: cfg().hook.magpie_enabled,
      },
    });
  });

  // ── trace：注入台账（内存 ring buffer，界面与 doctor 共用） ──
  app.get('/trace', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const limit = Number.parseInt(q['limit'] ?? '20', 10);
    return reply.send(trace.snapshot(Number.isFinite(limit) ? limit : 20));
  });

  app.post('/trace', async (req, reply) => {
    trace.clear();
    // 默认只清内存；要连磁盘一起清必须显式带 disk（`?disk=1` 或 body {disk:true}）
    const q = (req.query ?? {}) as Record<string, string>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const disk = q['disk'] === '1' || body['disk'] === true;
    const removed = disk ? opts.sink.clearDisk() : 0;
    return reply.send({ schema: HOOK_SCHEMA, cleared: true, disk_removed: removed });
  });
}

/** 数据目录根（写配置时用作白名单）；与 `dataPaths()` 同口径但只取必要的两项 */
function dataRootsOf(cfg: Config): string[] {
  const root = cfg.storage.data_dir;
  return [root];
}

function traceSize(trace: HookTraceStore): number {
  return trace.size;
}

/**
 * 台账落盘已迁到 `core/hook/traceSink.ts`（Z-01C-e：按日轮转 + 保留期清理，
 * 写盘异步补写，不占 recall 的 800ms 预算）。这里只剩两个纯函数：
 */

/** 台账用的短哈希（前 16 hex） */
function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** signal 结果 → 回执枚举（供界面统计"注入了但没落库"这类断点） */
function signalStatus(result: { captured: boolean; reason?: string }): HookReportCode {
  if (result.captured) return 'ready';
  if (result.reason === 'disabled' || result.reason === 'capture_reply_disabled') return 'skipped';
  return 'empty';
}

/** full 档的正文落盘前必过脱敏（summary/off 没有正文，原样返回） */
function redactTrace(item: HookTraceItem, cfg: Config): HookTraceItem {
  if (item.query_text === undefined && item.inject_text === undefined && item.reply_text === undefined) {
    return item;
  }
  const opts = { enabled: cfg.redact.enabled, privateIp: cfg.redact.private_ip };
  return {
    ...item,
    ...(item.query_text === undefined ? {} : { query_text: redactText(item.query_text, opts).text }),
    ...(item.inject_text === undefined ? {} : { inject_text: redactText(item.inject_text, opts).text }),
    ...(item.reply_text === undefined ? {} : { reply_text: redactText(item.reply_text, opts).text }),
    ...(item.evidence_text === undefined
      ? {}
      : { evidence_text: item.evidence_text.map((text) => redactText(text, opts).text) }),
  };
}

