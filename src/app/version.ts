/**
 * 版本号单一来源。
 *
 * 单独一个文件是因为 `main.ts` / `lifecycle.ts` / `mcp/server.ts` 都要用它，
 * 而它们之间不允许互相 import（`main` 会组装 `mcp`，反过来就成了环）。
 */
export const VERSION = '0.1.0';
