/**
 * P2-19-B 浏览器验收：五页截图 + `/ui/graph` draw calls / fps 报告。
 *
 * 用法：
 *   npx tsx tools/accept-ui.ts [--small] [--facts N] [--edges N] [--keep] [--timeout ms]
 *
 * 前置：`pnpm build:ui` 产出 `src/app/ui/dist`（工具不负责构建，缺 dist 时直接报错）。
 *
 * 行为：
 * 1. 在 `temp/accept-ui/<stamp>/` 建临时 home + 种子库（**绝不碰 `~/.moshi`**）；
 * 2. `buildHttpApp` 监听 127.0.0.1 随机端口；
 * 3. 起本机 headless Chrome（或 Edge），独立 `--remote-debugging-port` + user-data-dir，
 *    直连 CDP（不引入新依赖）；
 * 4. 依次访问五个一级页面：等待首屏 → 采 3 轮 fps → 截图 → 记录选择器存在性；
 *    `/ui/graph` 额外读取 `window.__moshiGraph` 并断言 `calls <= 12`；
 * 5. 报告写 `temp/accept-ui/<stamp>/report.json`（schema `moshi-accept-ui/1`），
 *    截图同目录；控制台逐页 PASS/WARN/FAIL，任一项 fail → 退出码 1；
 * 6. 跑完清理临时数据目录与浏览器 profile（`--keep` 保留）。
 *
 * 不做 30fps 硬断言（集显口径差异）：fps 只记录，<30 标 warn。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { loadConfig } from '../src/app/config.js';
import { buildHttpApp } from '../src/app/http/server.js';
import { closeDb, openDb } from '../src/infra/sqlite/db.js';
import { migrate } from '../src/infra/sqlite/migrate.js';
import { seedGraph } from './seed-graph.js';
import {
  ACCEPT_UI_PAGES,
  FPS_SAMPLE_ROUNDS,
  buildReport,
  formatPageLine,
  medianFps,
  type AcceptUiPage,
  type GraphReadout,
  type PageSample,
} from './accept-ui-lib.js';

const TOKEN = 'accept_ui_token';
const DEFAULT_FACTS = 5000;
const DEFAULT_EDGES = 15000;
const DEFAULT_TIMEOUT_MS = 30_000;
const SMALL_FACTS = 3;

interface Args {
  facts: number;
  edges: number;
  keep: boolean;
  timeoutMs: number;
}

function usage(): string {
  return '用法：npx tsx tools/accept-ui.ts [--small] [--facts N] [--edges N] [--keep] [--timeout ms]';
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { facts: DEFAULT_FACTS, edges: DEFAULT_EDGES, keep: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--small') {
      out.facts = SMALL_FACTS;
      out.edges = 0;
    } else if (arg === '--keep') {
      out.keep = true;
    } else if (arg === '--facts' || arg === '--edges' || arg === '--timeout') {
      const raw = argv[i + 1];
      const n = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`参数 ${arg} 需要一个非负数字：${String(raw)}`);
      i += 1;
      if (arg === '--facts') out.facts = Math.floor(n);
      else if (arg === '--edges') out.edges = Math.floor(n);
      else out.timeoutMs = Math.floor(n);
    } else {
      throw new Error(`未知参数：${arg}\n${usage()}`);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等子进程真的退出；Chrome 被杀后还会写一小会儿 profile */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Windows 上 Chrome 退出后 profile 文件可能短暂被占用：重试删除，失败只警告不判失败 */
async function removeWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`[accept-ui] 清理临时目录失败（可手动删除）：${target}：${String((err as Error).message)}`);
        return;
      }
      await sleep(300);
    }
  }
}

/** 本机浏览器候选：环境变量优先，然后 Chrome 常见安装位置，最后 Edge */
function findBrowser(): string {
  const env = process.env['MOSHI_CHROME'] ?? process.env['CHROME_PATH'];
  const local = process.env['LOCALAPPDATA'] ?? 'C:\\Users\\Default\\AppData\\Local';
  const candidates = [
    env,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const hit = candidates.find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`找不到 Chrome/Edge，可用 MOSHI_CHROME 指定可执行文件（试过：${candidates.join(', ')}）`);
  return hit;
}

/** 让内核分配一个空闲端口 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        error?: unknown;
        result?: unknown;
      };
      if (msg.id === undefined) return;
      const waiter = this.pending.get(msg.id);
      if (waiter === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page eval failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value;
  }

  async screenshot(file: string): Promise<number> {
    const started = Date.now();
    const result = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    return Date.now() - started;
  }
}

async function waitFor(
  cdp: Cdp,
  expression: string,
  timeoutMs: number,
  label = expression,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await cdp.evaluate(`Boolean(${expression})`)) === true) return true;
    } catch {
      /* 导航期 evaluate 会失败：继续等 */
    }
    await sleep(120);
  }
  throw new Error(`waitFor 超时：${label}`);
}

/** 在页面里数 1s 的 rAF 次数（返回 fps）；必须 await，否则拿到的是 Promise */
const SAMPLE_FPS_EXPRESSION = `(async () => {
  const samples = [];
  for (let round = 0; round < ${String(FPS_SAMPLE_ROUNDS)}; round += 1) {
    const fps = await new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames += 1;
        const elapsed = performance.now() - t0;
        if (elapsed >= 1000) resolve(Math.round((frames * 1000 / elapsed) * 10) / 10);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    samples.push(fps);
  }
  return samples;
})()`;

const SELECTOR_MAP: Record<string, string> = {
  'shell-nav': '[data-testid="shell-nav"]',
  'global-search': '[data-testid="global-search"]',
  'toast-host': '[data-testid="toast-host"]',
  'status-lights': '[data-testid="status-lights"]',
  'inbox-badge': '[data-testid="inbox-badge"]',
  'nav-graph': '[data-testid="nav-graph"]',
  'nav-memories': '[data-testid="nav-memories"]',
  'nav-inbox': '[data-testid="nav-inbox"]',
  'nav-archive': '[data-testid="nav-archive"]',
  'nav-settings': '[data-testid="nav-settings"]',
  main: 'main',
  canvas: 'canvas',
};

const PAGE_MARKERS: Record<AcceptUiPage, string | null> = {
  graph: 'window.__moshiGraph !== undefined',
  memories: null,
  inbox: null,
  archive: null,
  settings: '[data-testid="settings-page"]',
};

interface PageProbe {
  title: string;
  path: string;
  selectors: Record<string, boolean>;
}

async function probePage(cdp: Cdp): Promise<PageProbe> {
  const selectorSource = JSON.stringify(SELECTOR_MAP);
  const result = (await cdp.evaluate(`(() => {
    const map = ${selectorSource};
    const selectors = {};
    for (const [key, selector] of Object.entries(map)) {
      selectors[key] = document.querySelector(selector) !== null;
    }
    return { title: document.title, path: window.location.pathname, selectors };
  })()`)) as PageProbe;
  return result;
}

function readGraph(cdp: Cdp): Promise<GraphReadout | null> {
  return cdp
    .evaluate(`(() => {
      const g = window.__moshiGraph;
      if (!g) return null;
      return {
        calls: typeof g.calls === 'number' ? g.calls : null,
        nodeCount: typeof g.nodeCount === 'number' ? g.nodeCount : null,
        edgeCount: typeof g.edgeCount === 'number' ? g.edgeCount : null,
        fps: typeof g.fps === 'number' ? g.fps : null,
      };
    })()`)
    .then((value) => (value === null ? null : (value as GraphReadout)));
}

async function waitChromeDebug(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('Chrome remote debugging 未就绪（疑似启动失败）');
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }

  const distIndex = path.resolve('src', 'app', 'ui', 'dist', 'index.html');
  if (!existsSync(distIndex)) {
    console.error(`找不到前端产物：${distIndex}\n请先跑 pnpm build:ui`);
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.resolve('temp', 'accept-ui', stamp);
  const home = path.join(root, 'home');
  const dataDir = path.join(home, '.moshi');
  const profile = path.join(root, 'chrome-profile');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(profile, { recursive: true });

  const reportPath = path.join(root, 'report.json');
  const startedAt = new Date().toISOString();
  const samples: PageSample[] = [];
  let graphReadout: GraphReadout = { calls: null, nodeCount: null, edgeCount: null, fps: null };
  let browser: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  let ws: WebSocket | null = null;
  let app: Awaited<ReturnType<typeof buildHttpApp>>['app'] | null = null;
  let db: ReturnType<typeof openDb>['db'] | null = null;
  let baseUrl = '';

  try {
    // ── 1. 临时库 + 种子 ──────────────────────────────────────────
    const seed = seedGraph({ data: dataDir, facts: args.facts, edges: args.edges, quiet: true });
    console.log(
      `[accept-ui] seed facts=${String(seed.facts)} edges=${String(seed.edges)} seeded_ms=${String(seed.ms)}`,
    );

    const cfg = loadConfig({ home });
    const opened = openDb({ file: path.join(dataDir, 'moshi.db') });
    db = opened.db;
    migrate(db, { backupsDir: path.join(dataDir, 'backups') });

    const built = await buildHttpApp({ db, cfg, token: TOKEN });
    app = built.app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (port === 0) throw new Error('HTTP app 未拿到监听端口');
    baseUrl = `http://127.0.0.1:${String(port)}`;

    // ── 2. headless 浏览器 + CDP ──────────────────────────────────
    const browserPath = findBrowser();
    const debugPort = await freePort();
    const launchArgs = [
      '--headless=new',
      '--remote-debugging-port=' + String(debugPort),
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      'about:blank',
    ];
    browser = spawn(browserPath, launchArgs, { stdio: 'ignore' });
    await waitChromeDebug(debugPort, args.timeoutMs);

    const targetRes = await fetch(
      `http://127.0.0.1:${String(debugPort)}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' },
    );
    if (!targetRes.ok) throw new Error(`新建 CDP target 失败：HTTP ${String(targetRes.status)}`);
    const target = (await targetRes.json()) as { webSocketDebuggerUrl?: string };
    if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('CDP target 缺 webSocketDebuggerUrl');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws?.addEventListener('open', () => resolve(), { once: true });
      ws?.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // ── 3. 逐页采样 ──────────────────────────────────────────────
    // 选择器/标记只用于记录，缺失不判失败，因此等待上限压到 5s，避免拖慢整轮
    const markerTimeoutMs = Math.min(args.timeoutMs, 5_000);
    for (const pageKey of ACCEPT_UI_PAGES) {
      const pageUrl = `${baseUrl}/ui/${pageKey}?token=${TOKEN}`;
      const pageStarted = Date.now();
      await cdp.send('Page.navigate', { url: pageUrl });
      await waitFor(cdp, `document.readyState === 'complete'`, args.timeoutMs, `${pageKey} load`);
      await waitFor(
        cdp,
        `document.querySelector('[data-testid="shell-nav"]') !== null`,
        markerTimeoutMs,
        `${pageKey} shell`,
      ).catch(() => false);
      const marker = PAGE_MARKERS[pageKey];
      if (marker !== null) await waitFor(cdp, marker, markerTimeoutMs, `${pageKey} marker`).catch(() => false);

      // 首屏稳定（固定 500ms 与任务卡口径一致）
      await sleep(500);
      const probed = await probePage(cdp);
      const frameSamples = (await cdp.evaluate(SAMPLE_FPS_EXPRESSION)) as number[];
      const fps = medianFps(frameSamples);

      let calls: number | null = null;
      if (pageKey === 'graph') {
        const read = await readGraph(cdp);
        if (read !== null) {
          graphReadout = read;
          calls = read.calls;
        }
      }

      const shotFile = path.join(root, `${pageKey}.png`);
      let screenshot = '';
      let screenshotMs = 0;
      try {
        screenshotMs = await cdp.screenshot(shotFile);
        screenshot = path.relative(process.cwd(), shotFile);
      } catch (err) {
        console.error(`[accept-ui] ${pageKey} 截图失败：${String((err as Error).message)}`);
      }

      const sample: PageSample = {
        page: pageKey,
        path: probed.path,
        title: probed.title,
        calls,
        fps,
        frame_samples: frameSamples,
        selectors: probed.selectors,
        screenshot,
        screenshot_ms: screenshotMs,
      };
      samples.push(sample);
      console.log(formatPageLine(sample, graphReadout));
      console.log(`[accept-ui] ${pageKey} 采样完成 ${String(Date.now() - pageStarted)}ms`);
    }

    // graph 页的 fps 用该页中位数回填到 graph 汇总
    const graphSample = samples.find((s) => s.page === 'graph');
    if (graphSample?.fps !== null && graphSample?.fps !== undefined) {
      graphReadout = { ...graphReadout, fps: graphSample.fps };
    }
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    if (browser !== null && browser.exitCode === null) {
      browser.kill();
      await waitExit(browser, 5_000);
      await sleep(200);
    }
    if (app !== null) await app.close().catch(() => undefined);
    if (db !== null) closeDb(db);
  }

  const report = buildReport({
    at: startedAt,
    baseUrl,
    facts: args.facts,
    edges: args.edges,
    pages: samples,
    graph: graphReadout,
  });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `[accept-ui] ${report.verdict.toUpperCase()} · fps_warn=${String(report.warnings.length)} · fail=${String(report.violations.length)}`,
  );
  for (const issue of report.violations) console.log(`[accept-ui] FAIL ${issue.page}: ${issue.reason}`);
  for (const issue of report.warnings) console.log(`[accept-ui] WARN ${issue.page}: ${issue.reason}`);
  console.log(`[accept-ui] report: ${path.relative(process.cwd(), reportPath)}`);
  console.log(`[accept-ui] shots: ${path.relative(process.cwd(), root)}/*.png`);

  if (!args.keep) {
    await removeWithRetry(home);
    await removeWithRetry(profile);
    console.log('[accept-ui] 临时数据/浏览器 profile 已清理（--keep 可保留）');
  } else {
    console.log(`[accept-ui] --keep：数据保留在 ${path.relative(process.cwd(), home)}`);
  }

  return report.verdict === 'fail' ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`[accept-ui] 失败：${String((err as Error).stack ?? (err as Error).message)}`);
    process.exitCode = 2;
  },
);
