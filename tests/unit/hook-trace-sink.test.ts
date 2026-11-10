/**
 * 台账落盘（Z-01C-e）：三档裁剪、按日轮转、保留期清理。
 *
 * 这里不碰 daemon，直接对着临时目录测 TraceSink——落盘是纯 IO 行为，
 * 用一个真实的 tmpdir 比 mock fs 更能证明"文件名、字节上限、清理"这三件事。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceSink, dateOf, trimTrace } from '../../src/core/hook/traceSink.js';
import type { HookTraceItem } from '../../src/core/hook/trace.js';

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'moshi-trace-sink-'));
  dirs.push(dir);
  return dir;
}

function item(overrides: Partial<HookTraceItem> = {}): HookTraceItem {
  return {
    ts: '2026-11-10T12:00:00.000Z',
    host: 'magpie',
    turn: 'user_prompt',
    status: 'ready',
    inject_bytes: 640,
    evidence: 5,
    degraded: [],
    identity_source: 'vcs',
    latency_ms: 88,
    evidence_ids: [11, 12],
    evidence_scores: [0.9, 0.8],
    inject_sha256: 'a1b2c3d4e5f60718',
    query_text: '用户原话-秘密',
    inject_text: '## 记忆台账（moshi）',
    reply_text: '模型回复',
    ...overrides,
  };
}

function lines(dir: string, name: string): Record<string, unknown>[] {
  return readFileSync(path.join(dir, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('trimTrace', () => {
  it('off 不落盘；summary 去正文保留 id/哈希；full 原样', () => {
    expect(trimTrace(item(), 'off')).toBeNull();
    const summary = trimTrace(item(), 'summary');
    expect(summary).not.toBeNull();
    expect(summary?.query_text).toBeUndefined();
    expect(summary?.inject_text).toBeUndefined();
    expect(summary?.reply_text).toBeUndefined();
    expect(summary?.evidence_ids).toEqual([11, 12]);
    expect(summary?.inject_sha256).toBe('a1b2c3d4e5f60718');
    expect(trimTrace(item(), 'full')?.query_text).toBe('用户原话-秘密');
  });
});

describe('TraceSink', () => {
  it('off 档一条都不写', async () => {
    const dir = tmp();
    const sink = new TraceSink({ dir, level: 'off', maxBytes: 1024, keepDays: 7 });
    sink.append(item());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('summary 档按日写文件，且不含正文', async () => {
    const dir = tmp();
    const sink = new TraceSink({ dir, level: 'summary', maxBytes: 1024, keepDays: 7 });
    sink.append(item({ ts: '2026-11-10T12:00:00.000Z' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const name = `trace-${dateOf(new Date())}.jsonl`;
    expect(readdirSync(dir)).toEqual([name]);
    const record = lines(dir, name)[0] as Record<string, unknown>;
    expect(record['status']).toBe('ready');
    expect(record['evidence_ids']).toEqual([11, 12]);
    expect(JSON.stringify(record)).not.toContain('用户原话-秘密');
  });

  it('full 档保留正文', async () => {
    const dir = tmp();
    const sink = new TraceSink({ dir, level: 'full', maxBytes: 4096, keepDays: 7 });
    sink.append(item());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const record = lines(dir, `trace-${dateOf(new Date())}.jsonl`)[0] as Record<string, unknown>;
    expect(record['query_text']).toBe('用户原话-秘密');
  });

  it('超过字节上限切下一个序号文件', async () => {
    const dir = tmp();
    const sink = new TraceSink({ dir, level: 'summary', maxBytes: 260, keepDays: 7 });
    for (let i = 0; i < 6; i += 1) sink.append(item({ evidence_ids: [i] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const names = readdirSync(dir).filter((name) => name.startsWith('trace-'));
    expect(names.length).toBeGreaterThan(1);
    expect(names.some((name) => /^trace-\d{4}-\d{2}-\d{2}\.2\.jsonl$/.test(name))).toBe(true);
  });

  it('保留期清理只删自己的旧文件', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'trace-2020-01-01.jsonl'), '{}\n', 'utf8');
    writeFileSync(path.join(dir, 'other.jsonl'), '{}\n', 'utf8');
    const sink = new TraceSink({ dir, level: 'summary', maxBytes: 1024, keepDays: 7 });
    sink.cleanup(new Date('2026-11-10T12:00:00.000Z'));
    const names = readdirSync(dir);
    expect(names).not.toContain('trace-2020-01-01.jsonl');
    expect(names).toContain('other.jsonl');
  });

  it('clearDisk 只清台账文件', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'trace-2026-11-10.jsonl'), '{}\n', 'utf8');
    writeFileSync(path.join(dir, 'trace-2026-11-10.2.jsonl'), '{}\n', 'utf8');
    writeFileSync(path.join(dir, 'keep.txt'), 'x', 'utf8');
    const sink = new TraceSink({ dir, level: 'summary', maxBytes: 1024, keepDays: 7 });
    expect(sink.clearDisk()).toBe(2);
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });
});
