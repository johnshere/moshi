/** P2-28 / Z-1：Fastify 与 MCP 共用真实 socket，已解析 body 不得二次读流。 */
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';

const TOKEN = 'mcp_http_test_token';
const opened: { db: Db; app: FastifyInstance; server: Server }[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const item = opened.pop()!;
    await new Promise<void>((resolve, reject) => {
      item.server.close((err) => (err === undefined ? resolve() : reject(err)));
    });
    await item.app.close();
    closeDb(item.db);
  }
});

async function makeEnv(): Promise<{ baseUrl: string; db: Db }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-mcp-http-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  const cfg = loadConfig({ home: dir });
  const { app, server } = await buildHttpApp({ db, cfg, token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  opened.push({ db, app, server });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no port');
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, db };
}

describe('POST /mcp over a real HTTP socket（P2-28）', () => {
  it('initialize 返回 200 与 moshi serverInfo', async () => {
    const { baseUrl } = await makeEnv();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1.0.0' },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe('moshi');
  });

  it('坏 JSON、空 body 与 JSON null 均返回 400', async () => {
    const { baseUrl } = await makeEnv();
    for (const body of ['{"jsonrpc":', '', 'null']) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('MCP 请求后同一实例的 REST privacy dry-run 仍返回 200', async () => {
    const { baseUrl } = await makeEnv();
    await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } },
      }),
    });
    const response = await fetch(`${baseUrl}/api/privacy/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-moshi-token': TOKEN },
      body: JSON.stringify({ scope: 'all', confirm: 'PURGE', dry_run: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, dry_run: true });
  });
});
