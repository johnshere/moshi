import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `src/ui` 是独立 Vite 工程（详设 §3.1）：产物落 `src/app/ui/dist`，由
 * `src/app/http/static.ts` 托管在 `/ui/graph` 下（SPA fallback）。
 *
 * base 必须是 `/ui/graph/`：静态资源按绝对路径引用，浏览器直接从 `/ui/graph/assets/...`
 * 取，和 static.ts 的路由前缀对齐。dev 模式 Vite 自己按 base 挂载，同样通。
 *
 * `/api` 反代到 daemon：daemon 端口从 53000 起扫（见 `src/app/config.ts`），
 * 若实际端口不是 53000，用环境变量 `MOSHI_DAEMON` 覆盖（例如 `MOSHI_DAEMON=http://127.0.0.1:53002`）。
 */
const daemon = process.env['MOSHI_DAEMON'] ?? 'http://127.0.0.1:53000';

export default defineConfig({
  plugins: [react()],
  base: '/ui/graph/',
  build: {
    outDir: '../app/ui/dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 53080,
    strictPort: false,
    proxy: {
      '/api': { target: daemon, changeOrigin: false },
    },
  },
});
