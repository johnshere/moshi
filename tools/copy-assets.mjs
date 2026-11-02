// 构建时复制非 TS 资产到 dist（tsc 不复制 .html / 前端产物）
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  ['src/app/http/ui.html', 'dist/app/http/ui.html'],
];

for (const [src, dest] of ASSETS) {
  const s = join(root, src);
  const d = join(root, dest);
  if (!existsSync(s)) throw new Error(`缺少源文件: ${s}`);
  mkdirSync(dirname(d), { recursive: true });
  copyFileSync(s, d);
  console.log(`copied ${src} -> ${dest}`);
}

/**
 * 前端产物：`src/ui` 是独立 Vite 工程（详设 §3.1），`vite build` 落到 `src/app/ui/dist`。
 * 但 tsc 只搬 .ts，所以这里把整棵 dist 树搬到编译产物目录——`static.ts` 用
 * `__dirname/../ui/dist` 定位，源码态指向 `src/app/ui/dist`，跑起来的 dist 指向
 * `dist/app/ui/dist`，两边同一套相对路径。
 */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

const UI_DIST_SRC = 'src/app/ui/dist';
const UI_DIST_DEST = 'dist/app/ui/dist';
if (existsSync(join(root, UI_DIST_SRC))) {
  // 先清空目标目录（P2-02 返工 H7）：Vite 产物是带内容哈希的文件名，只增不删会让
  // 上一轮构建的 `assets/index-<oldhash>.js` 一直留在 dist 里，包越滚越大、也无法判断
  // 线上到底加载的是哪一版。只清 `dist/app/ui/dist` 这一棵子树，`dist/app` 下 tsc
  // 编译出来的 .js 和 `dist/app/http/ui.html` 都不碰。
  rmSync(join(root, UI_DIST_DEST), { recursive: true, force: true });
  copyTree(join(root, UI_DIST_SRC), join(root, UI_DIST_DEST));
  console.log(`copied ${UI_DIST_SRC}/ -> ${UI_DIST_DEST}/`);
} else {
  console.warn(`[copy-assets] 未找到 ${UI_DIST_SRC}/，/ui/graph 会返回 503；先跑 pnpm build:ui`);
}
