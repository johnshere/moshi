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

const crypto = require('node:crypto');
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

/**
 * 从 ctx 里尽力拿信息；拿不到就是 null（**绝不拿 process.cwd() 充数**）。
 *
 * ctx 是**扁平**的（Magpie 的 `GatewayContext`）：`session / cwd / agent / model /
 * protocol / origin`。宿主不会把它们再包一层 `context`。
 */
function contextOf(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  return {
    sessionId: str(c.session),
    cwd: cleanCwd(str(c.cwd)),
    agent: str(c.agent) || HOST,
    model: str(c.model),
  };
}

/**
 * 宿主给的 cwd 可能带引号、转义和句末点——DSH 的目录上下文是
 * `Current working directory: "E:\\Workspace\\x".`，而 Magpie 的 `workDirIn`
 * 只做 TrimSpace 不剥这些。清不干净就当没有（宁可退化，也不给 daemon 一个假路径）。
 */
function cleanCwd(raw) {
  if (typeof raw !== 'string') return null;
  let v = raw.trim();
  if (v === '') return null;
  v = v.replace(/\s+\(was\s+.*\)$/i, '').trim();
  if (v.endsWith('".') || v.endsWith("'.")) v = v.slice(0, -1);
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === 'string') v = parsed;
    } catch {
      v = v.slice(1, -1);
    }
  } else if (v.endsWith('.')) {
    v = v.slice(0, -1);
  }
  v = v.trim();
  return v === '' ? null : v;
}

/** 一条消息的纯文本（content 可以是字符串，也可以是 parts 数组） */
function messageText(m) {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return null;
  const parts = [];
  for (const part of m.content) {
    if (part && typeof part.text === 'string' && part.text !== '') parts.push(part.text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/** cwd 的候选句式（与 Magpie `workdir.go` 的 callerForms 一致，多认一档 Working directory） */
const CWD_PATTERNS = [
  /^[ \t]*(?:-[ \t]+)?(?:Current working directory|Primary working directory|CWD|Working directory)[ \t]*:[ \t]*(.+)$/gm,
  /<cwd>[ \t]*([^<\n]+?)[ \t]*<\/cwd>/g,
];

/**
 * 从请求 body 里解析 cwd。`ctx.cwd` 对 DSH 恒为空——Magpie 只在 system 层认
 * `Current working directory:`，而 DSH 把它放在一条 user 消息里，故自解析兜底。
 */
function cwdFromBody(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  let found = null;
  for (const m of messages) {
    const text = messageText(m);
    if (text === null) continue;
    for (const re of CWD_PATTERNS) {
      re.lastIndex = 0;
      let hit;
      while ((hit = re.exec(text)) !== null) {
        const v = cleanCwd(hit[1]);
        if (v !== null) found = v; // 取最后一次出现（与 Magpie 的 workDirIn 口径一致）
      }
    }
  }
  return found;
}

/**
 * 会话开头：跳过 DSH 每轮都会替换的 runtime-context 快照，取第一条真实用户消息。
 * 快照的文本以 `Current runtime context` 开头（清空时是 `Current runtime context: none.`）。
 */
function openingUserText(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    const text = messageText(m);
    if (text === null) continue;
    const t = text.trim();
    if (t.startsWith('Current runtime context')) continue;
    return t.replace(/\s+/g, ' ').slice(0, 400);
  }
  return null;
}

/**
 * 会话标志：宿主给了 session 就用；没给（DSH 走 pi-ai，不发任何 session 头，
 * 而 Magpie 只转发 header、不自己生成）就用「cwd + 会话开头」哈希。
 * 这是 Magpie 社区记忆插件（nowledge-mem / respire-memory / powercontext）的通行做法：
 * 会话开头整段会话不变，而 query 每轮都变。
 */
function sessionOf(body, info, ctxCwd) {
  if (info.sessionId !== null) return { id: info.sessionId, source: HOST };
  const opening = openingUserText(body);
  if (opening === null) return { id: null, source: 'none' };
  // 只用宿主**明确给出**的 ctx.cwd 参与指纹：body 里解析出的目录来自 DSH 可被替换的
  // runtime-context 快照，拿它当熵会让同一会话在快照清空时中途漂移。
  const cwd = ctxCwd === null ? '' : ctxCwd;
  const id = crypto
    .createHash('sha256')
    .update(`moshi-magpie-conv/1\n${cwd}\n${opening}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return { id, source: 'conversation-opening' };
}

/** `ctx.state` 是宿主给的**请求级**共享容器：把 onRequest 算出的身份留给 onResponse */
function rememberIdentity(ctx, info) {
  try {
    if (ctx && ctx.state && typeof ctx.state === 'object') {
      ctx.state.moshiSessionId = info.sessionId;
      ctx.state.moshiSessionSource = info.sessionSource;
      ctx.state.moshiCwd = info.cwd;
    }
  } catch {
    // 宿主的 state 不可写就不留，onResponse 退回"没有身份"
  }
}

function recalledIdentity(ctx) {
  const s = ctx && ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
  const id = str(s.moshiSessionId);
  return {
    sessionId: id,
    sessionSource: id === null ? null : str(s.moshiSessionSource),
    cwd: cleanCwd(str(s.moshiCwd)),
  };
}

/** 注入回执号（Z-01C-e）：daemon 在 recall 回包里给，response 时原样带回，便于对账 */
function rememberCorr(ctx, corr) {
  try {
    if (typeof corr !== 'string' || corr === '') return;
    if (ctx && ctx.state && typeof ctx.state === 'object') ctx.state.moshiCorrId = corr;
  } catch {
    // 存不下就不带，signal 仍可正常落库，只是对不上 recall
  }
}

function recalledCorr(ctx) {
  const s = ctx && ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
  return str(s.moshiCorrId);
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

/** 信封：project_id 由 daemon 侧按 cwd 解析；moshi_id 也由 daemon 从会话标志重算 */
function envelopeOf(turn, info, payload, budgetMs, phaseMs, corr) {
  return {
    schema: SCHEMA,
    host: HOST,
    turn,
    ts: new Date().toISOString(),
    identity: { moshi_id: null, project_id: null, identity_source: 'unknown' },
    caps: {
      turns: ['user_prompt', 'response'],
      inject: true,
      injectModes: ['system-append'],
      replyBody: true,
      configWrite: true,
      budget: { phaseMs: phaseMs, deadlineMs: budgetMs },
    },
    budget: { deadlineMs: budgetMs, phaseTimeoutMs: phaseMs },
    session: { id: info.sessionId, source: info.sessionSource || HOST },
    project: { cwd: info.cwd, identitySource: 'unknown' },
    ...(typeof corr === 'string' && corr !== '' ? { corr: corr } : {}),
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
  const ctxCwd = info.cwd;
  if (info.cwd === null) info.cwd = cwdFromBody(body);
  const session = sessionOf(body, info, ctxCwd);
  info.sessionId = session.id;
  info.sessionSource = session.source;
  rememberIdentity(ctx, info);
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
  rememberCorr(ctx, result.corr_id);
  if (!result.inject || typeof result.text !== 'string' || result.text === '') {
    report(ctx, Array.isArray(result.degraded) && result.degraded.length > 0 ? 'empty' : 'skipped', 0);
    return undefined;
  }
  // 宿主把第二个参数当**注入字节数**记账（面板上的「已注入 N 字节」），不是证据条数
  report(ctx, 'ready', Math.min(new TextEncoder().encode(result.text).length, 32768));
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
  const memo = recalledIdentity(ctx);
  if (memo.sessionId !== null) {
    info.sessionId = memo.sessionId;
    info.sessionSource = memo.sessionSource;
  }
  if (info.cwd === null && memo.cwd !== null) info.cwd = memo.cwd;
  const text = replyText(reply);
  if (!text) {
    report(ctx, 'skipped', 0);
    return undefined;
  }
  const env = envelopeOf('response', info, { reply: text }, SIGNAL_BUDGET_MS, 1000, recalledCorr(ctx));
  void post(ctx, '/hook/api/signal', env, SIGNAL_BUDGET_MS).then((r) => {
    if (!r) report(ctx, 'unavailable', 0);
    else report(ctx, r.captured === true ? 'ready' : 'skipped', 0);
  });
  report(ctx, 'ready', 0);
  return undefined;
}

module.exports = { onRequest, onResponse };
