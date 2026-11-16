/**
 * 首开五态 + `/api/status` 扩展字段（P2-19A-08）单测。
 *
 * 这里不渲染 React 组件（vitest 跑 node 环境、无 jsdom）：五态判定被抽成纯函数
 * `firstRunState`，扩展字段抽成 `buildStatusExtras`，两者都能直接钉输入输出。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStatusExtras } from '../../src/core/ops/status.js';
import type { SidecarStatus } from '../../src/infra/sidecar/client.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { setMeta } from '../../src/infra/sqlite/metaRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { BANNERS, firstRunState, MCP_IDLE_MS, type FirstRunStatus } from '../../src/ui/shell/first-run.js';

const opened: Db[] = [];
const dirs: string[] = [];

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'moshi-first-run-'));
  dirs.push(dir);
  const { db } = openDb({ file: join(dir, 'moshi.db') });
  migrate(db, { backupsDir: join(dir, 'backups') });
  opened.push(db);
  return db;
}

afterEach(() => {
  while (opened.length > 0) {
    const db = opened.pop();
    if (db !== undefined) closeDb(db);
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function sidecar(overrides: Partial<SidecarStatus> = {}): SidecarStatus {
  return {
    state: 'ready',
    mode: 'on',
    pid: 1234,
    embedModel: 'bge-small-zh-v1.5',
    rssMb: 120,
    restartsThisHour: 0,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

const NOW = Date.parse('2026-01-02T00:00:00.000Z');

function statusWith(overrides: Partial<FirstRunStatus> = {}): FirstRunStatus {
  return {
    daemon: 'ok',
    sidecar: { state: 'ready', mode: 'on' },
    mcp: { last_call_at: new Date(NOW - 60_000).toISOString(), last_call_tool: 'list_facts' },
    ...overrides,
  };
}

describe('firstRunState 五态与优先级', () => {
  it('daemon 取数失败（null）压过「没有数据」：显示 daemon_off', () => {
    expect(firstRunState(null, false, { now: NOW })).toBe('daemon_off');
    expect(firstRunState(null, true, { now: NOW })).toBe('daemon_off');
  });

  it('daemon 在但库里没有 fact：显示 no_data，即使 sidecar 未就绪', () => {
    expect(
      firstRunState(statusWith({ sidecar: { state: 'failed', mode: 'off' } }), false, { now: NOW }),
    ).toBe('no_data');
  });

  it('没有 sidecar / mode off / 状态 stopped 都压过 collect_off，显示 sidecar_off', () => {
    expect(firstRunState(statusWith({ sidecar: undefined }), true, { now: NOW })).toBe('sidecar_off');
    expect(
      firstRunState(statusWith({ sidecar: { state: 'stopped', mode: 'on' } }), true, {
        now: NOW,
        collectEnabled: false,
      }),
    ).toBe('sidecar_off');
    expect(
      firstRunState(statusWith({ sidecar: { state: 'ready', mode: 'off' } }), true, { now: NOW }),
    ).toBe('sidecar_off');
  });

  it('starting / unloaded 视为语义检索可用，不闪灰条', () => {
    expect(
      firstRunState(statusWith({ sidecar: { state: 'starting', mode: 'on' } }), true, { now: NOW }),
    ).toBe('ready');
    expect(
      firstRunState(statusWith({ sidecar: { state: 'unloaded', mode: 'on' } }), true, { now: NOW }),
    ).toBe('ready');
  });

  it('collect.enabled=false → collect_off（即使 MCP 刚调用过）', () => {
    expect(firstRunState(statusWith(), true, { now: NOW, collectEnabled: false })).toBe('collect_off');
  });

  it('MCP 从未调用 → collect_off；超过 30 分钟 → collect_off；30 分钟内 → ready', () => {
    expect(firstRunState(statusWith({ mcp: undefined }), true, { now: NOW })).toBe('collect_off');
    expect(
      firstRunState(
        statusWith({ mcp: { last_call_at: new Date(NOW - MCP_IDLE_MS - 1).toISOString() } }),
        true,
        { now: NOW },
      ),
    ).toBe('collect_off');
    expect(
      firstRunState(
        statusWith({ mcp: { last_call_at: new Date(NOW - MCP_IDLE_MS + 1).toISOString() } }),
        true,
        { now: NOW },
      ),
    ).toBe('ready');
  });

  it('collectEnabled 未知（null/undefined）不据此判态，其余条件满足即 ready', () => {
    expect(firstRunState(statusWith(), true, { now: NOW, collectEnabled: null })).toBe('ready');
    expect(firstRunState(statusWith(), true, { now: NOW })).toBe('ready');
  });

  it('collect_off 不出横幅（用户 m00882：三态暂不提示，判定仍保留）', () => {
    // 判定还在：状态机照旧给出 collect_off
    expect(firstRunState(statusWith(), true, { now: NOW, collectEnabled: false })).toBe('collect_off');
    // 文案没了：组件取不到 banner 就不渲染（不改其它三态）
    expect(Object.keys(BANNERS).sort()).toEqual(['daemon_off', 'no_data', 'sidecar_off']);
    expect(BANNERS.collect_off).toBeUndefined();
    expect(BANNERS.daemon_off?.text).toBe('默识 daemon 未运行');
  });
});

describe('buildStatusExtras', () => {
  it('无 sidecar 注入：model 为 off/null/null，不把 undefined 漏进 JSON', () => {
    const db = freshDb();
    expect(buildStatusExtras(db)).toEqual({
      model: { state: 'off', mode: null, embed_model: null },
      jobs: {
        last_harvest_at: null,
        last_consolidate_at: null,
        last_export_at: null,
        last_eval_at: null,
      },
      mcp: { last_call_at: null, last_call_tool: null },
    });
  });

  it('有 sidecar 时透传 state/mode/embed_model，并读出已写入的 meta 时间戳', () => {
    const db = freshDb();
    setMeta(db, 'last_harvest_at', '2026-01-01T03:00:00.000Z');
    setMeta(db, 'mcp.last_call_at', '2026-01-01T04:00:00.000Z');
    setMeta(db, 'mcp.last_call_tool', 'list_facts');
    setMeta(db, 'last_export_at', '2026-01-01T05:00:00.000Z');

    const extras = buildStatusExtras(db, { sidecar: { status: () => sidecar() } });
    expect(extras.model).toEqual({
      state: 'ready',
      mode: 'on',
      embed_model: 'bge-small-zh-v1.5',
    });
    expect(extras.jobs.last_harvest_at).toBe('2026-01-01T03:00:00.000Z');
    expect(extras.jobs.last_export_at).toBe('2026-01-01T05:00:00.000Z');
    // 无写入方的三个字段保持 null，而不是拿别的时间冒充
    expect(extras.jobs.last_consolidate_at).toBeNull();
    expect(extras.jobs.last_eval_at).toBeNull();
    expect(extras.mcp).toEqual({
      last_call_at: '2026-01-01T04:00:00.000Z',
      last_call_tool: 'list_facts',
    });
  });

  it('meta 值为空串按 null 处理（历史脏值不污染 JSON 契约）', () => {
    const db = freshDb();
    setMeta(db, 'last_harvest_at', '');
    const extras = buildStatusExtras(db);
    expect(extras.jobs.last_harvest_at).toBeNull();
  });
});
