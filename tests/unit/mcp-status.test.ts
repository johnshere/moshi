/**
 * MCP 工具调用时间戳（P2-19A-08）单测。
 *
 * 成交口径：`callTool` 是 MCP 所有工具的公共入口，进入即记 `mcp.last_call_at/tool`，
 * 未知工具/参数错误也算「宿主尝试过」；埋点失败不能反过来阻断工具。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import type { McpDeps } from '../../src/app/mcp/deps.js';
import { callTool } from '../../src/app/mcp/tools.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { getMeta } from '../../src/infra/sqlite/metaRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';

let db: Db | null = null;
let dir: string | null = null;

function freshDeps(): McpDeps {
  dir = mkdtempSync(join(tmpdir(), 'moshi-mcp-status-'));
  const opened = openDb({ file: join(dir, 'moshi.db') });
  migrate(opened.db, { backupsDir: join(dir, 'backups') });
  db = opened.db;
  return { db: opened.db, cfg: loadConfig({ home: dir }) };
}

afterEach(() => {
  if (db !== null) closeDb(db);
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  db = null;
  dir = null;
});

describe('callTool 写入 mcp 调用时间戳', () => {
  it('未知工具也记一次调用，同时仍返回 E_INPUT 错误', async () => {
    const deps = freshDeps();
    const result = await callTool(deps, 'definitely_not_a_tool', {});
    expect(result.isError).toBe(true);

    const at = getMeta(deps.db, 'mcp.last_call_at');
    expect(at).not.toBeNull();
    expect(Number.isFinite(Date.parse(at as string))).toBe(true);
    expect(getMeta(deps.db, 'mcp.last_call_tool')).toBe('definitely_not_a_tool');
  });

  it('工具执行失败（参数错误）也会留下最近调用记录', async () => {
    const deps = freshDeps();
    const result = await callTool(deps, 'list_facts', { limit: 'not-a-number' });
    expect(result.isError).toBe(true);

    expect(getMeta(deps.db, 'mcp.last_call_tool')).toBe('list_facts');
    expect(getMeta(deps.db, 'mcp.last_call_at')).not.toBeNull();
  });
});
