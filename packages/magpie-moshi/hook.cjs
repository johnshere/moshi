/**
 * Magpie 入口的协议胶水（Z-01C / 设计 §7）。
 *
 * **零依赖、无副作用**：这个文件被 Magpie 的 plugin-host 直接 import，跑在它的
 * 进程里（默认单钩子预算 1000ms）。所以：
 *
 * - 不 require 任何 npm 包（包括 moshi 自己的）——宿主那边的 `node_modules` 里没有
 *   我们的东西；
 * - 不启动子进程、不写本地文件（除了在 store 目录写一份"上次失败"的标记，供诊断），
 *   所有网络 I/O 都是 `fetch` 到本机 daemon；
 * - **任何异常都吞掉并放行原请求**：插件坏了是 moshi 的问题，不是用户的请求的问题。
 *
 * Magpie 的约定（`plugin-host` 的加载器）：
 * - `package.json` 里声明 `magpie.hooks` 指向本文件；
 * - 导出 `onRequest(body, ctx)` 与 `onResponse(reply, ctx)`；
 * - `onRequest` 返回值若非空会**替换**请求 body，且 `tools / tool_choice / model /
 *   stream` 等字段必须和原来完全一致，否则整次改写被丢弃 → 这里只改 `messages`；
 * - `ctx.report(code, count)` 只接受 ready/empty/unbound/unauthorized/unavailable/
 *   invalid/skipped 这几个固定值，且不能带出任何正文。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 'moshi-hook/1';
const HOST = 'magpie';
const MAIL_START = '<!-- moshi-hook:begin -->';

/** Magpie 单钩子默认超时 1000ms，留 400ms 给序列化与改写 */
const DEFAULT_DAEMON = 'http://127.0.0.1:9836';
const RECALL_BUDGET_MS = 800;
const SIGNAL_BUDGET_MS = 500;

/** daemon 把端口与 token 写在数据目录的锁文件里（token 每次启动都换，写死进插件必过期） */
function dataDir() {
  return process.env.MOSHI_DATA_DIR || path.join(os.homedir(), '.moshi');
}

function lockPath() {
  return path.join(dataDir(), 'daemon.lock');
}

/**
 * 读 daemon 锁文件（只读）。每次调用现读，不缓存——缓存会让 daemon 重启后的
 * 新 token 永远读不到。读不到/坏掉返回 null，退回"没有 token 就不注入"。
 */
function daemonLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function str(v) {
  return typeof v === 'string' ? v : null;
}

function optionOf(ctx, name) {
  const o = ctx && ctx.options ? ctx.options[name] : undefined;
  return typeof o === 'string' && o !== '' ? o : null;
}

/** 从 ctx 里尽力拿信息；拿不到就是 null（**绝不拿 process.cwd() 充数**） */
function contextOf(ctx) {
  const c = (ctx && ctx.context) || {};
  const headers = (c.headers && typeof c.headers === 'object') ? c.headers : {};
  const pickHeader = (name) => {
    const v = headers[name] || headers[name.toLowerCase()];
    return typeof v === 'string' && v !== '' ? v : null;
  };
  return {
    sessionId: str(c.sessionID) || str(c.session_id) || pickHeader('x-magpie-session'),
    cwd: str(c.cwd) || str(c.workDir) || pickHeader('x-magpie-work-dir'),
    agent: str(c.agent) || str(c.agentName) || HOST,
    model: str(c.model) || null,
  };
}

function baseUrl(ctx, lock) {
  const explicit = optionOf(ctx, 'daemonUrl') || process.env.MOSHI_DAEMON;
  if (explicit) return explicit;
  const port = lock && typeof lock.port === 'number' ? lock.port : null;
  return port === null ? DEFAULT_DAEMON : `http://127.0.0.1:${port}`;
}

function tokenOf(ctx, lock) {
  const explicit = optionOf(ctx, 'token') || process.env.MOSHI_TOKEN;
  if (explicit) return explicit;
  return lock && typeof lock.token === 'string' && lock.token !== '' ? lock.token : null;
}

/**
 * 调 daemon。超时用 `AbortSignal.timeout`；**任何失败都返回 null**，
 * 调用方据此"原样放行"。
 */
async function post(ctx, path, payload, budgetMs) {
  const lock = daemonLock();
  const token = tokenOf(ctx, lock);
  if (!token) return null;
  const base = baseUrl(ctx, lock).replace(/\/+$/, '');
  try {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-moshi-token': token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(budgetMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // 网络断 / 超时 / daemon 没起：都属于"这轮不注入"，不是错误
    return null;
  }
}

/** 信封：Magpie 拿不到 project，`identity.project_id` 留空，由 daemon 侧统一解析 */
function envelopeOf(turn, info, payload, budgetMs, phaseMs) {
  // moshi_id 在这里算不了（会话 id 是宿主的，哈希口径在 daemon 侧），先原样透传，
  // daemon 会用同一个纯函数在本地重算并回填——两边不一致时以 daemon 为准
  return {
    schema: SCHEMA,
    host: HOST,
    turn,
    ts: new Date().toISOString(),
    identity: { moshi_id: info.sessionId, project_id: null, identity_source: 'unknown' },
    caps: {
      turns: ['user_prompt', 'response'],
      inject: true,
      injectModes: ['system-append'],
      replyBody: true,
      configWrite: true,
      budget: { phaseMs: phaseMs, deadlineMs: budgetMs },
    },
    budget: { deadlineMs: budgetMs, phaseTimeoutMs: phaseMs },
    session: { id: info.sessionId, source: HOST },
    project: { cwd: info.cwd, identitySource: 'unknown' },
    payload: payload,
  };
}

/**
 * 从请求 body 里取最后一条用户消息的文本（作为召回查询）。
 * 只读不写：找不到就返回 null，让上层"不注入"。
 */
function lastUserText(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const part of m.content) {
        if (part && typeof part.text === 'string') parts.push(part.text);
      }
      if (parts.length > 0) return parts.join('\n');
    }
    return null;
  }
  return null;
}

/** 把 `## 记忆台账` 块追加到 system 消息；没有 system 就插一条在最前 */
function injectMail(body, text) {
  const clone = { ...body };
  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'system') continue;
    const existing = typeof m.content === 'string' ? m.content : '';
    if (existing.includes(MAIL_START)) return body; // 已经注过，不重复
    messages[i] = { ...m, content: existing === '' ? text : existing + '\n\n' + text };
    clone.messages = messages;
    return clone;
  }
  clone.messages = [{ role: 'system', content: text }, ...messages];
  return clone;
}

function report(ctx, code, count) {
  try {
    if (ctx && typeof ctx.report === 'function') ctx.report(code, count || 0);
  } catch {
    // 宿主的回执失败不该影响请求
  }
}

/**
 * 请求前：召回既有事实并追加到 system。
 * 返回 `undefined` = 不动请求（Magpie 的原请求原样发出）。
 */
async function onRequest(body, ctx) {
  const info = contextOf(ctx);
  const query = lastUserText(body);
  if (!query) {
    report(ctx, 'skipped', 0);
    return undefined;
  }
  const result = await post(
    ctx,
    '/hook/api/recall',
    envelopeOf('user_prompt', info, { text: query }, RECALL_BUDGET_MS, 1000),
    RECALL_BUDGET_MS,
  );
  if (!result) {
    report(ctx, 'unavailable', 0);
    return undefined;
  }
  if (!result.inject || typeof result.text !== 'string' || result.text === '') {
    report(ctx, Array.isArray(result.degraded) && result.degraded.length > 0 ? 'empty' : 'skipped', 0);
    return undefined;
  }
  report(ctx, 'ready', result.evidence ? result.evidence.length : 0);
  return injectMail(body, result.text);
}

/** 回复里最后一段文本（`onResponse` 的 reply 形状在不同版本里不完全一样） */
function replyText(reply) {
  if (!reply) return null;
  if (typeof reply === 'string') return reply;
  if (typeof reply.text === 'string') return reply.text;
  const choices = Array.isArray(reply.choices) ? reply.choices : null;
  if (choices && choices.length > 0) {
    const c = choices[0];
    const msg = c && c.message ? c.message : null;
    if (msg && typeof msg.content === 'string') return msg.content;
    if (c && typeof c.text === 'string') return c.text;
  }
  if (typeof reply.content === 'string') return reply.content;
  return null;
}

/**
 * 响应后：把回复写成信号（fire-and-forget，**不等**）。
 *
 * 为什么要 fire-and-forget：`onResponse` 的返回值会被丢弃，但调用仍然占用
 * Magpie 的钩子预算结算时间；等它回来会把整次代理调用拖慢。`setTimeout(...).unref()`
 * 让 Node 在本轮结束后再退出，不会卡住 plugin-host。
 */
function onResponse(reply, ctx) {
  const info = contextOf(ctx);
  const text = replyText(reply);
  if (!text) {
    report(ctx, 'skipped', 0);
    return undefined;
  }
  const env = envelopeOf('response', info, { reply: text }, SIGNAL_BUDGET_MS, 1000);
  void post(ctx, '/hook/api/signal', env, SIGNAL_BUDGET_MS).then((r) => {
    if (!r) report(ctx, 'unavailable', 0);
    else report(ctx, r.captured === true ? 'ready' : 'skipped', 0);
  });
  report(ctx, 'ready', 0);
  return undefined;
}

module.exports = { onRequest, onResponse };
