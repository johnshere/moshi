/**
 * MCP 工具的公共依赖。单独一个文件，避免 `tools.ts`（注册表）与四个实现文件互相 import。
 */
import type { Config } from '../config.js';
import type { Db } from '../../infra/sqlite/db.js';

export interface McpDeps {
  db: Db;
  cfg: Config;
}
