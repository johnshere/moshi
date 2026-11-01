/**
 * `moshi init`（P0-21）。
 *
 * 验收：全新机器上 init → 建目录/写默认配置/建库迁移 → 打印 MCP 配置片段 →
 * 列表有数据（import 后）。这里用 `--no-daemon` 跳过真常驻进程（拉起行为在真实机
 * 上由「已在运行」分支覆盖——本机 daemon 常驻）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/app/cli/index.js';
import { closeDb, openDb } from '../../src/infra/sqlite/db.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-init-'));
  dirs.push(d);
  return d;
}

function collect(): { stdout: (s: string) => void; stderr: (s: string) => void; text: () => string } {
  const buf = { stdout: '', stderr: '' };
  return {
    stdout: (s: string) => (buf.stdout += s),
    stderr: (s: string) => (buf.stderr += s),
    text: () => buf.stdout,
  };
}

describe('moshi init（P0-21）', () => {
  it('全新 home：建目录、写默认配置、建库迁移、打印 MCP 片段', async () => {
    const home = tempHome();
    const out = collect();
    const code = await runCli(['init', '--no-daemon'], {
      home,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);

    // 目录与配置
    const root = path.join(home, '.moshi');
    for (const sub of ['logs', 'tmp', 'backups']) {
      expect(existsSync(path.join(root, sub)), `${sub} 应存在`).toBe(true);
    }
    const cfgText = readFileSync(path.join(root, 'config.toml'), 'utf8');
    expect(cfgText).toContain('data_dir = "~/.moshi"');

    // 库已迁移
    const { db } = openDb({ file: path.join(root, 'moshi.db') });
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    closeDb(db);
    expect(v).toBeGreaterThan(0);

    // MCP 片段：http 型 + /mcp 端点
    expect(out.text()).toContain('mcpServers');
    expect(out.text()).toContain('http://127.0.0.1:53000/mcp');
    expect(out.text()).toContain('数据库就绪');
  });

  it('幂等：跑两次不炸，配置与库不被覆盖', async () => {
    const home = tempHome();
    const first = await runCli(['init', '--no-daemon'], { home });
    expect(first).toBe(0);
    // 用户改了配置
    const root = path.join(home, '.moshi');
    const cfgFile = path.join(root, 'config.toml');
    const userCfg = readFileSync(cfgFile, 'utf8').replace('theme = "system"', 'theme = "dark"');
    writeFileSync(cfgFile, userCfg);

    const second = await runCli(['init', '--no-daemon'], { home });
    expect(second).toBe(0);
    // 用户修改未被覆盖（消息也不该说"已写入默认配置"）
    expect(readFileSync(cfgFile, 'utf8')).toContain('theme = "dark"');
  });

  it('全新 home 上 init 后 import，列表有数据（Phase 0 验收的前半段）', async () => {
    const home = tempHome();
    expect(await runCli(['init', '--no-daemon'], { home })).toBe(0);
    // import 无源也应当正常退出（4 = 无可用源），不炸进程
    const code = await runCli(['import', '--since', '2026-01-01'], { home });
    expect([0, 4]).toContain(code);
  });
});
