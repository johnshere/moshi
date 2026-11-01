/**
 * `moshi init`（P0-21 / 概设 §8.4「装完不用读文档就能跑通」）。
 *
 * 步骤：建 `~/.moshi/` → 写默认 `config.toml` → 建库 → 迁移 → 打印 MCP 配置片段 →
 * 拉起 daemon（若已在运行则打印去向）。`--no-daemon` 用于脚本/测试场景，不拉起常驻进程。
 *
 * 文案纪律（概设 §8.4）：任何"查不到"都写「尚未观测到」，不写「没有」。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../../../infra/fs/safeWrite.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { ensureDataDirs } from '../../lifecycle.js';
import { inspectLock, readLock } from '../../lock.js';
import type { Command } from '../types.js';

/** 默认 config.toml 模板：只写关键可调项，省略项全部走代码里的默认值 */
const DEFAULT_CONFIG = `# 默识（moshi）配置。删掉整节 = 用默认值；未知键会报错。
# 路径里的 ~ 会被展开成家目录。

[server]
host = "127.0.0.1"
port = 53000
port_scan_max = 53020

[storage]
data_dir = "~/.moshi"
archive_dir = "~/Documents/默识归档"

[ingest]
harvest_cron = "0 3 * * *"

[ui]
theme = "system"

[log]
level = "info"
`;

function mcpSnippet(port: number): string {
  return JSON.stringify(
    {
      mcpServers: {
        moshi: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
        },
      },
    },
    null,
    2,
  );
}

export const initCommand: Command = {
  name: 'init',
  summary: '初始化数据目录、建库、打印 MCP 配置并拉起界面',
  async run(ctx) {
    const cfg = ctx.cfg;
    const paths = ensureDataDirs(cfg);

    // 1) 默认配置：只写一次，用户改过的绝不覆盖
    const configFile = path.join(paths.root, 'config.toml');
    if (!existsSync(configFile)) {
      safeWriteFile(configFile, DEFAULT_CONFIG, [paths.root]);
      ctx.stdout(`已写入默认配置：${configFile}\n`);
    } else {
      ctx.stdout(`配置文件已存在，保留：${configFile}\n`);
    }

    // 2) 建库 + 迁移（幂等：已迁移过则 user_version 不变）
    const { db } = openDb({ file: paths.db });
    let migration;
    try {
      migration = migrate(db, { backupsDir: paths.backups });
    } finally {
      closeDb(db);
    }
    ctx.stdout(
      `数据库就绪：${paths.db}（schema v${migration.to}，本次迁移 ${migration.applied.length} 条）\n`,
    );

    // 3) MCP 配置片段——端口以锁文件为准（可能被 port_scan 改过）
    const lock = readLock(paths.lock);
    const port = lock?.port ?? cfg.server.port;
    ctx.stdout(
      `\nMCP 配置片段（复制进宿主的 mcp.json，如 ~/.claude.json 的 mcpServers 或项目 .mcp.json）：\n\n${mcpSnippet(port)}\n`,
    );

    // 4) 拉起 daemon（仅当未运行）；--no-daemon 跳过（脚本/测试场景）
    if (ctx.args.includes('--no-daemon')) {
      ctx.stdout('\n（--no-daemon：不启动 daemon，请自行运行 `moshi daemon`）\n');
      return 0;
    }
    const state = await inspectLock(paths.lock, cfg.server.host);
    if (state.kind === 'live') {
      ctx.stdout(`\ndaemon 已在运行（pid=${state.info.pid}）\n打开界面：http://127.0.0.1:${state.info.port}/ui\n`);
      return 0;
    }

    const entry = process.argv[1]!; // 命令在主逻辑内执行，入口必然存在
    const child = spawn(process.execPath, [entry, 'daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // 等锁写入（最多 ~2s），拿到实际端口
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const now = readLock(paths.lock);
      if (now?.port) {
        ctx.stdout(`\ndaemon 已启动（pid=${now.pid}）\n打开界面：http://127.0.0.1:${now.port}/ui\n`);
        return 0;
      }
    }
    ctx.stdout(`\ndaemon 启动中，稍后打开界面：http://127.0.0.1:${cfg.server.port}/ui\n`);
    return 0;
  },
};
