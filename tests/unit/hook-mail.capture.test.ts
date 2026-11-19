/**
 * 注入文本渲染与信号落库（Z-01C / 设计 §3.4、§6）。
 *
 * 这两块是"钩子能不能用"的全部内容：一个是模型看到的最长文本，一个是台账真正
 * 记住的原文。分开测，因为它们的失败方式完全不同——渲染失败是"注入了不该注入的"，
 * 落库失败是"该记的没记住或者记重了"。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { captureSignal, hookRawHash, hookRawPath } from '../../src/core/hook/capture.js';
import { renderHookMail, utf8Bytes } from '../../src/core/hook/mail.js';
import {
  HOOK_MAIL_START,
  HOOK_MAIL_END,
  HOOK_SCHEMA,
  MAGPIE_CAPS,
  type HookEnvelope,
} from '../../src/core/hook/protocol.js';
// 标记常量只有 protocol.ts 一份（mail.ts 不导出它们，误从那里 import 会静默变成 undefined）
const START = HOOK_MAIL_START;
const END = HOOK_MAIL_END;

function envelope(over: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    schema: HOOK_SCHEMA,
    host: 'magpie',
    turn: 'user_prompt',
    ts: '2026-11-10T00:00:00.000Z',
    identity: { moshi_id: 'a'.repeat(32), project_id: null, identity_source: 'unknown' },
    caps: MAGPIE_CAPS,
    budget: { deadlineMs: 800, phaseTimeoutMs: 1000 },
    session: { id: 'sess-1', source: 'magpie' },
    project: { cwd: null, identitySource: 'unknown' },
    payload: { text: '什么是范围模型' },
    ...over,
  };
}

describe('renderHookMail', () => {
  it('没有证据就不注入（返回空文本，而不是只有标题的空块）', () => {
    const mail = renderHookMail([], { projectId: null });
    expect(mail.text).toBe('');
    expect(mail.evidence).toEqual([]);
  });

  it('有证据时带起止标记与 [Mm_id] 前缀', () => {
    const mail = renderHookMail([{ m_id: 1, content: '范围模型分用户/工程/会话三层', confidence: 0.9 }], {
      projectId: 'b'.repeat(32),
    });
    expect(START.length).toBeGreaterThan(0);
    expect(mail.text).toContain(START);
    expect(mail.text).toContain(END);
    expect(mail.text).toContain('[M1] 范围模型分用户/工程/会话三层');
    expect(mail.text).toContain('记忆台账（moshi · 工程 bbbbbbbb）');
    expect(mail.evidence[0]?.m_id).toBe(1);
  });

  it('unknown 工程不带工程标签（不假装知道是哪个工程）', () => {
    const mail = renderHookMail([{ m_id: 2, content: 'x', confidence: 0.5 }], { projectId: null });
    expect(mail.text).toContain('记忆台账（moshi）');
    expect(mail.text).not.toContain('工程');
  });

  it('超字节预算丢最长的那些，但绝不超预算', () => {
    const long = 'x'.repeat(500);
    const entries = [
      { m_id: 1, content: long, confidence: 0.9 },
      { m_id: 2, content: long, confidence: 0.9 },
      { m_id: 3, content: '短', confidence: 0.9 },
    ];
    const mail = renderHookMail(entries, { projectId: null, maxBytes: 300 });
    expect(utf8Bytes(mail.text)).toBeLessThanOrEqual(300);
    expect(mail.dropped).toBeGreaterThan(0);
  });

  it('单条内容按码位截断（不切坏中文）', () => {
    const mail = renderHookMail([{ m_id: 7, content: '中'.repeat(500), confidence: 0.9 }], {
      projectId: null,
    });
    expect(mail.evidence[0]?.content).not.toContain('\uFFFD');
    expect(mail.evidence[0]?.content.length).toBeLessThanOrEqual(200);
  });
});

describe('captureSignal（信号落库）', () => {
  let dir: string;
  let db: Db;

  afterEach(() => {
    if (db !== undefined) closeDb(db);
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  function open(): Db {
    dir = mkdtempSync(path.join(os.tmpdir(), 'moshi-hook-capture-'));
    const opened = openDb({ file: path.join(dir, 'moshi.db') });
    migrate(opened.db);
    db = opened.db;
    return db;
  }

  it('用户消息落 episode，且 raw_path 用 moshi-hook:// URI', () => {
    const d = open();
    const out = captureSignal(d, envelope(), {
      redact: { enabled: true, privateIp: false },
      projectRoot: null,
    });
    expect(out.captured).toBe(true);
    expect(out.result?.episodeCreated).toBe(true);
    expect(out.rawPath).toBe(`moshi-hook://magpie/${'a'.repeat(32)}/user_prompt`);
  });

  it('同一个信号重发是幂等的（raw_hash 不含时间戳）', () => {
    const d = open();
    const opts = { redact: { enabled: true, privateIp: false }, projectRoot: null };
    const first = captureSignal(d, envelope(), opts);
    // 时间戳换了，正文没换 → 仍然算同一条
    const second = captureSignal(d, envelope({ ts: '2026-11-10T09:00:00.000Z' }), opts);
    expect(first.result?.episodeId).toBe(second.result?.episodeId);
    expect(second.result?.duplicate).toBe(true);
  });

  it('正文不同就是两条', () => {
    const d = open();
    const opts = { redact: { enabled: true, privateIp: false }, projectRoot: null };
    const a = captureSignal(d, envelope(), opts);
    const b = captureSignal(d, envelope({ payload: { text: '另一个问题' } }), opts);
    expect(a.result?.episodeId).not.toBe(b.result?.episodeId);
  });

  it('脱敏先于落盘：token 不进 episode 正文', () => {
    const d = open();
    const out = captureSignal(
      d,
      envelope({ payload: { text: 'token=sk-abcdefghijklmnopqrstuvwxyz012345 帮我看看' } }),
      { redact: { enabled: true, privateIp: false }, projectRoot: null },
    );
    expect(out.captured).toBe(true);
    const row = d.prepare('SELECT summary FROM episode WHERE id = ?').get(out.result?.episodeId) as {
      summary: string;
    };
    expect(row.summary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('空正文不落库（captured=false，带原因）', () => {
    const d = open();
    const out = captureSignal(d, envelope({ payload: { text: '   ' } }), {
      redact: { enabled: true, privateIp: false },
      projectRoot: null,
    });
    expect(out.captured).toBe(false);
    expect(out.reason).toBeDefined();
  });

  it('没有会话身份时用稳定占位符，不让幂等键互相打架', () => {
    expect(hookRawPath('magpie', null, 'response')).toBe('moshi-hook://magpie/unknown/response');
    const a = hookRawHash('magpie', null, 'response', 'assistant', '同一句');
    const b = hookRawHash('magpie', null, 'response', 'assistant', '同一句');
    expect(a).toBe(b);
  });

  it('post_tool 带 tool 落 tool_parse annotation，重试不重复', () => {
    const d = open();
    const opts = {
      redact: { enabled: true, privateIp: false },
      projectRoot: null,
      captureToolOutput: true,
    };
    const env = (output: string): HookEnvelope =>
      envelope({
        turn: 'post_tool',
        payload: { tool: { name: 'Bash', input: { command: 'node -v' }, output } },
      });

    const first = captureSignal(d, env('v22.9.0'), opts);
    expect(first.captured).toBe(true);
    expect(first.result?.annotationCreated).toBe(true);
    const row = d.prepare('SELECT channel, payload_json FROM annotation').get() as {
      channel: string;
      payload_json: string;
    };
    expect(row.channel).toBe('tool_parse');
    const payload = JSON.parse(row.payload_json) as { tool: string; cmd: string; output: string };
    expect(payload.tool).toBe('bash');
    expect(payload.cmd).toBe('node -v');
    expect(payload.output).toBe('v22.9.0');

    // 重试时 ts 与 output 都可能变，但工具身份（name + input）不变 → 仍是同一条
    const retry = captureSignal(d, env('v22.9.1'), opts);
    expect(retry.result?.duplicate).toBe(true);
    expect((d.prepare('SELECT COUNT(*) AS n FROM annotation').get() as { n: number }).n).toBe(1);
    expect((d.prepare('SELECT COUNT(*) AS n FROM episode').get() as { n: number }).n).toBe(1);
  });

  it('同一轮次的不同工具各落一条（幂等键含 name + input）', () => {
    const d = open();
    const opts = {
      redact: { enabled: true, privateIp: false },
      projectRoot: null,
      captureToolOutput: true,
    };
    const call = (command: string): HookEnvelope =>
      envelope({
        turn: 'post_tool',
        payload: { tool: { name: 'Bash', input: { command }, output: 'ok' } },
      });

    const a = captureSignal(d, call('node -v'), opts);
    const b = captureSignal(d, call('pnpm test'), opts);
    expect(a.result?.episodeId).not.toBe(b.result?.episodeId);
    expect((d.prepare('SELECT COUNT(*) AS n FROM annotation').get() as { n: number }).n).toBe(2);
  });

  it('capture_tool_output 关时保留工具身份，但不写输出正文', () => {
    const d = open();
    const out = captureSignal(
      d,
      envelope({
        turn: 'post_tool',
        payload: { tool: { name: 'Bash', input: { command: 'node -v' }, output: 'v22.9.0' } },
      }),
      { redact: { enabled: true, privateIp: false }, projectRoot: null },
    );
    expect(out.captured).toBe(true);
    expect(out.result?.annotationCreated).toBe(true);
    const row = d.prepare('SELECT payload_json FROM annotation').get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { cmd: string; output: string };
    expect(payload.cmd).toBe('node -v');
    expect(payload.output).toBe('');
  });
});
