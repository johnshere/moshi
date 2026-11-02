/**
 * 前端产物托管（详设 §10.3 / §3.1）。
 *
 * `src/ui` 是独立 Vite 工程，`pnpm build:ui` 把产物落到 `src/app/ui/dist`，
 * `pnpm build` 再把它搬进 `dist/app/ui/dist`——两条路径相对本文件的 `__dirname`
 * 都是 `../ui/dist`，所以这里只需要一个 `defaultUiDistDir()`。
 *
 * 路由分工（老 UI 不动）：
 *   /ui        → 仍由 server.ts 吐老的单文件 ui.html
 *   /ui/graph  → 新的 3D 图谱，SPA fallback：非静态资源一律回 index.html
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** 与 `src/ui/index.html` 里的占位行**整句**一致——不能只锚 `window.__MOSHI_TOKEN__ || ''`，
 *  那样会先命中 HTML 注释里的同名字样，真正要换的那行反而留空。 */
const TOKEN_PLACEHOLDER = "window.__MOSHI_TOKEN__ = window.__MOSHI_TOKEN__ || ''";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** `src/app/http` → `src/app/ui/dist`；`dist/app/http` → `dist/app/ui/dist` */
export function defaultUiDistDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'dist');
}

export interface StaticRoutesOpts {
  /** 前端产物目录（测试里传临时目录） */
  dir: string;
  /** 注入进 index.html 的 API token */
  token: string;
}

/** 把请求相对路径解析成 root 内的真实文件；越界/不存在/非文件一律返回 null */
function resolveInside(root: string, relRaw: string): string | null {
  if (relRaw === '') return null;
  let rel: string;
  try {
    rel = decodeURIComponent(relRaw);
  } catch {
    return null; // 非法 % 转义
  }
  if (rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null; // 路径穿越
  if (!existsSync(abs)) return null;
  if (!statSync(abs).isFile()) return null;
  return abs;
}

export async function staticRoutes(app: FastifyInstance, opts: StaticRoutesOpts): Promise<void> {
  const root = path.resolve(opts.dir);
  const indexPath = path.join(root, 'index.html');

  const sendIndex = (reply: FastifyReply): FastifyReply => {
    if (!existsSync(indexPath)) {
      return reply.code(503).send({
        error: 'E_UI_NOT_BUILT',
        message: '前端产物缺失：先跑 pnpm build:ui',
      });
    }
    const html = readFileSync(indexPath, 'utf8').replace(
      TOKEN_PLACEHOLDER,
      `window.__MOSHI_TOKEN__ = '${opts.token}'`,
    );
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(html);
  };

  // 入口：`/ui/graph` 与 `/ui/graph/`（后者靠显式注册，不指望通配符兜空串）
  app.get('/ui/graph', async (_req, reply) => sendIndex(reply));
  app.get('/ui/graph/', async (_req, reply) => sendIndex(reply));

  // 资源 + SPA fallback
  app.get('/ui/graph/*', async (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    const file = resolveInside(root, rel);
    if (file === null) return sendIndex(reply);
    const ext = path.extname(file).toLowerCase();
    // assets/ 下是带 hash 的产物，可以长缓存；其余（如 favicon）走协商
    const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return reply
      .type(MIME[ext] ?? 'application/octet-stream')
      .header('cache-control', cache)
      .send(readFileSync(file));
  });
}
