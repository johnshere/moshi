/**
 * `/ui/hook` 的页面骨架（Z-01C / 设计 §9）。
 *
 * 为什么是**内联 HTML 而不是 `src/ui` 里的一个新页面**：
 *
 * 1. `src/ui` 是 Vite + React 工程，加一个页面要动 `pnpm build:ui` 的产物、路由与
 *    五处 SPA fallback；而这一页只有三个开关 + 一段接入指引，不值得为它拉一条构建链。
 * 2. 这一页的主要用法是"从 `magpie.cmd` 被拉起来、看一眼状态、按一下连接"——
 *    首屏要在**零额外资源请求**下就能用，内联最省。
 * 3. 视觉上照 Magpie 的网页（深色底 + 卡片 + 强调色），不引组件库存量。
 *
 * 与 React 页面共用的东西只有一个：`window.__MOSHI_TOKEN__`（由首屏替换注入）。
 * 所有 `/hook/api/*` 请求都带 `x-moshi-token`。
 */

/** fastify 的 `reply.header('cache-control')` 值：内联页跟着 daemon 走，不缓存 */
export const HOOK_PAGE_PATH = '/ui/hook';

export interface HookPageOpts {
  token: string;
  /** `?from=magpie` —— 由 magpie.cmd 拉起，视为"连接 Magpie" */
  fromMagpie: boolean;
  /** 用户显式断开过（`hook.magpie_enabled=false` 且不是从 magpie 拉起） */
  needsConnect: boolean;
  port: number;
  /** 钩子脚本（plugin-host 用）所在文件路径，显示给用户复制 */
  hookEntry: string;
}

const STYLE = `
:root{
  --bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--line:#2a2f3a;--fg:#e6e9ef;
  --dim:#9aa4b2;--accent:#7aa2f7;--ok:#3fb950;--warn:#d29922;--bad:#f85149;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:20px;margin:0 0 4px;letter-spacing:.3px}
.sub{color:var(--dim);font-size:13px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:18px 20px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 14px;color:var(--dim);font-weight:600;letter-spacing:.4px}
.row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  padding:10px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row .label{font-weight:500}
.row .desc{color:var(--dim);font-size:12px;margin-top:2px;max-width:520px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;
  border:1px solid var(--line);color:var(--dim)}
.pill.ok{color:var(--ok);border-color:rgba(63,185,80,.4);background:rgba(63,185,80,.08)}
.pill.warn{color:var(--warn);border-color:rgba(210,153,34,.4);background:rgba(210,153,34,.08)}
.pill.bad{color:var(--bad);border-color:rgba(248,81,73,.4);background:rgba(248,81,73,.08)}
button{font:inherit;color:var(--fg);background:var(--panel2);border:1px solid var(--line);
  border-radius:8px;padding:7px 14px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#0b0d11;font-weight:600}
button:disabled{opacity:.5;cursor:not-allowed}
.toggle{position:relative;width:44px;height:24px;border-radius:999px;background:var(--line);
  cursor:pointer;transition:background .15s;flex:none;border:0;padding:0}
.toggle::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;
  border-radius:50%;background:#fff;transition:transform .15s}
.toggle[aria-checked="true"]{background:var(--accent)}
.toggle[aria-checked="true"]::after{transform:translateX(20px)}
.mask{position:fixed;inset:0;background:rgba(8,9,12,.6);backdrop-filter:blur(2px);
  display:flex;align-items:center;justify-content:center;padding:20px}
.mask[hidden]{display:none}
.dialog{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:24px;max-width:420px;width:100%}
.dialog p{color:var(--dim);margin:8px 0 20px;font-size:13px}
.dialog .actions{display:flex;gap:10px;justify-content:flex-end}
code{background:var(--panel2);border:1px solid var(--line);border-radius:6px;
  padding:1px 6px;font-size:12px;word-break:break-all}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:8px;
  padding:12px;overflow:auto;font-size:12px;margin:8px 0 0}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);color:var(--dim)}
th{color:var(--fg);font-weight:500}
td.num{font-variant-numeric:tabular-nums}
`;

export function renderHookPage(opts: HookPageOpts): string {
  const boot = {
    token: opts.token,
    fromMagpie: opts.fromMagpie,
    port: opts.port,
    hookEntry: opts.hookEntry,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>moshi · Magpie 接入</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>moshi 记忆台账 · Magpie 接入</h1>
  <div class="sub">通过 Magpie 网关钩子，在你每轮对话前注入既有事实，并把回复写成信号。</div>

  <div id="banner" class="card" hidden></div>

  <div class="card">
    <h2>连接</h2>
    <div class="row">
      <div>
        <div class="label">Magpie 连接态 <span id="conn-pill" class="pill">未知</span></div>
        <div class="desc">断开后记忆注入会整体停掉；再打开本页需要先重新连接。</div>
      </div>
      <button id="conn-btn" class="primary">连接 Magpie</button>
    </div>
    <div class="row">
      <div>
        <div class="label">工程身份</div>
        <div class="desc" id="project-desc">—</div>
      </div>
      <span id="project-pill" class="pill">—</span>
    </div>
  </div>

  <div class="card">
    <h2>开关</h2>
    <div class="row">
      <div>
        <div class="label">功能总开关</div>
        <div class="desc">关闭后钩子原样放行请求，不注入、不落库。</div>
      </div>
      <button class="toggle" role="switch" aria-checked="false" data-key="enabled"></button>
    </div>
    <div class="row">
      <div>
        <div class="label">用户对话注入</div>
        <div class="desc">在每轮用户消息前插入既有事实（记忆台账块）。</div>
      </div>
      <button class="toggle" role="switch" aria-checked="false" data-key="inject_existing"></button>
    </div>
    <div class="row">
      <div>
        <div class="label">注入已有事实</div>
        <div class="desc">勾选时注入的条目来自本工程已沉淀的事实；取消则只保留工程标签。</div>
      </div>
      <button class="toggle" role="switch" aria-checked="false" data-key="inject_facts"></button>
    </div>
    <div class="row">
      <div>
        <div class="label">输出记忆</div>
        <div class="desc">把模型回复原文写成信号，供后台抽取事实。</div>
      </div>
      <button class="toggle" role="switch" aria-checked="false" data-key="capture_reply"></button>
    </div>
  </div>

  <div class="card">
    <h2>接入指引</h2>
    <div class="desc">Magpie 的插件声明 <code>magpie.hooks</code> 入口，钩子脚本已随 moshi 安装：</div>
    <pre id="hook-entry"></pre>
    <div class="desc" style="margin-top:12px">Magpie 只兑现两个时机：<b>user_prompt</b>（可注入）与 <b>response</b>（只读）。    工具调用后（post_tool）等其余五个时机，如实标记为 <span class="pill warn">absent</span>。</div>
  </div>

  <div class="card">
    <h2>注入台账（最近 20 条）</h2>
    <table>
      <thead><tr><th>时间</th><th>时机</th><th>结果</th><th class="num">证据</th><th class="num">字节</th><th class="num">耗时</th></tr></thead>
      <tbody id="trace"><tr><td colspan="6">加载中…</td></tr></tbody>
    </table>
  </div>
</div>

<div id="mask" class="mask" hidden>
  <div class="dialog" role="dialog" aria-modal="true">
    <h2 style="margin:0 0 4px;font-size:16px">连接 Magpie 才能使用</h2>
    <p>本页面上的开关只在 Magpie 连接生效期间生效。你之前主动断开了连接。</p>
    <div class="actions">
      <button id="dialog-cancel">取消</button>
      <button id="dialog-ok" class="primary">连接 Magpie</button>
    </div>
  </div>
</div>

<script>
var BOOT = ${JSON.stringify(boot)};
(function () {
  var state = { switches: {}, needsConnect: false, connected: false };

  function api(path, init) {
    var opts = init || {};
    opts.headers = Object.assign({ 'x-moshi-token': BOOT.token, 'content-type': 'application/json' },
      opts.headers || {});
    return fetch('/hook/api' + path, opts).then(function (r) {
      if (!r.ok) throw new Error(path + ' -> ' + r.status);
      return r.json();
    });
  }

  function setPill(el, text, cls) {
    el.textContent = text;
    el.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function paint() {
    var pill = document.getElementById('conn-pill');
    if (state.connected) setPill(pill, '已连接', 'ok');
    else setPill(pill, '未连接', 'bad');
    document.getElementById('conn-btn').textContent = state.connected ? '断开连接' : '连接 Magpie';
    var t = document.querySelectorAll('.toggle');
    for (var i = 0; i < t.length; i++) {
      var key = t[i].getAttribute('data-key');
      // "注入已有事实"与"用户对话注入"是同一开关（F7 里两条并列，配置里是 inject_existing）
      var on = key === 'inject_facts' ? state.switches.inject_existing === true
                                       : state.switches[key] === true;
      t[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function banner(html) {
    var el = document.getElementById('banner');
    if (!html) { el.hidden = true; return; }
    el.innerHTML = html;
    el.hidden = false;
  }

  function loadStatus() {
    return api('/status').then(function (s) {
      state.switches = s.switches || {};
      state.connected = s.connected === true;
      state.needsConnect = s.needs_connect === true;
      paint();
      if (!state.connected && state.needsConnect && !BOOT.fromMagpie) {
        document.getElementById('mask').hidden = false;
      }
      return s;
    });
  }

  function loadTrace() {
    return api('/trace?limit=20').then(function (snap) {
      var rows = (snap.items || []).map(function (it) {
        return '<tr><td>' + (it.ts || '').replace('T', ' ').slice(0, 19) + '</td><td>' +
          it.turn + '</td><td>' + it.status + '</td><td class="num">' + it.evidence +
          '</td><td class="num">' + it.inject_bytes + '</td><td class="num">' +
          it.latency_ms + 'ms</td></tr>';
      });
      document.getElementById('trace').innerHTML =
        rows.length ? rows.join('') : '<tr><td colspan="6">还没有注入记录</td></tr>';
    });
  }

  function loadIdentity() {
    // 只有从 magpie.cmd 拉起时才建立身份（写 .moshi/project.yaml 属于副作用，不擅自做）
    if (!BOOT.fromMagpie) {
      setPill(document.getElementById('project-pill'), '只读展示', 'warn');
      document.getElementById('project-desc').textContent = '工程身份在从 Magpie 启动软件时建立。';
      return Promise.resolve();
    }
    return api('/identity', { method: 'POST', body: '{}' }).then(function (r) {
      var p = r.project || {};
      var id = p.project_id || '';
      setPill(document.getElementById('project-pill'),
        p.identity_source === 'unknown' ? '未知' : (p.identity_source === 'vcs' ? '版本库' : '本地标志'),
        p.identity_source === 'unknown' ? 'warn' : 'ok');
      document.getElementById('project-desc').textContent =
        (id ? 'project_id ' + id.slice(0, 12) + '…' : '未识别') +
        (p.root ? ' · ' + p.root : '') + ' · ' + (p.reason || '');
    });
  }

  function save(patch) {
    return api('/config', { method: 'POST', body: JSON.stringify(patch) }).then(function (r) {
      state.switches = r.switches || {};
      state.connected = r.connected === true;
      paint();
    });
  }

  document.getElementById('hook-entry').textContent = BOOT.hookEntry;

  var toggles = document.querySelectorAll('.toggle');
  for (var i = 0; i < toggles.length; i++) {
    toggles[i].addEventListener('click', function () {
      var key = this.getAttribute('data-key');
      if (key === 'inject_facts') key = 'inject_existing';
      var patch = {};
      patch[key] = this.getAttribute('aria-checked') !== 'true';
      save(patch);
    });
  }

  document.getElementById('conn-btn').addEventListener('click', function () {
    save({ action: state.connected ? 'disconnect' : 'connect' });
  });
  document.getElementById('dialog-ok').addEventListener('click', function () {
    document.getElementById('mask').hidden = true;
    save({ action: 'connect' }).then(loadIdentity);
  });
  document.getElementById('dialog-cancel').addEventListener('click', function () {
    document.getElementById('mask').hidden = true;
  });

  loadStatus().then(loadIdentity).catch(function (e) {
    banner('<b>无法读取状态</b><div class="desc">' + e.message + '</div>');
  });
  loadTrace();
  setInterval(loadTrace, 5000);
})();
</script>
</body>
</html>`;
}
