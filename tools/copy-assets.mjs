// 构建时复制非 TS 资产到 dist（tsc 不复制 .html 等文件）
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
