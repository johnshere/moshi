import { mkdtempSync, readFileSync, writeFileSync, utimesSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asMoshiError,
  ERROR_CODES,
  ERROR_META,
  isDegradable,
  isMoshiError,
  MoshiError,
} from '../../src/domain/errors.js';
import { buildLogger, logFileName, pruneLogs, REQUIRED_EVENTS } from '../../src/infra/log/logger.js';

describe('错误码映射（详设 §1.5）', () => {
  /** 详设表格的逐行抄录，测试就是防止代码与文档漂移 */
  const expected: Record<string, [number, number | null, boolean]> = {
    E_INPUT: [400, -32602, false],
    E_NOT_FOUND: [404, -32602, false],
    E_IMMUTABLE: [409, -32603, false],
    E_CONFLICT_IDENTITY: [409, -32603, false],
    E_BUSY: [503, -32603, true],
    E_DB: [500, -32603, true],
    E_SIDECAR: [200, null, false],
    E_TIMEOUT: [200, null, false],
    E_SCHEMA: [422, -32602, false],
    E_QUARANTINED: [202, null, false],
    E_CONFIG: [500, null, false],
    E_ACCESS: [403, null, false],
    E_DIRECT_WRITE_DISABLED: [403, -32602, false],
    E_QUOTA: [429, -32603, true],
    /** 详设 §1.5 原表没有 410（P2-07 批量撤销窗口新增），此处按代码实际补一行 */
    E_OP_EXPIRED: [410, -32602, false],
    /** V-03B 自动更新新增；不经过 MCP 层 */
    E_UPDATE: [502, null, true],
  };

  it('错误码集合与详设表一致', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(expected).sort());
  });

  for (const code of ERROR_CODES) {
    it(`${code} 映射正确`, () => {
      const [status, mcp, retryable] = expected[code] as [number, number | null, boolean];
      expect(ERROR_META[code].httpStatus).toBe(status);
      expect(ERROR_META[code].mcpCode).toBe(mcp);
      expect(ERROR_META[code].retryable).toBe(retryable);
    });
  }

  it('可降级判定：只有不该抛到协议层的才可降级', () => {
    expect(isDegradable('E_SIDECAR')).toBe(true);
    expect(isDegradable('E_TIMEOUT')).toBe(true);
    expect(isDegradable('E_QUARANTINED')).toBe(true);
    expect(isDegradable('E_INPUT')).toBe(false);
    expect(isDegradable('E_CONFIG')).toBe(false);
  });

  it('MoshiError 携带 code / detail / retryAfter', () => {
    const err = new MoshiError('E_BUSY', 'busy', { table: 'fact' }, 500);
    expect(err.code).toBe('E_BUSY');
    expect(err.detail).toEqual({ table: 'fact' });
    expect(err.retryAfterMs).toBe(500);
    expect(err.toJSON()).toEqual({
      code: 'E_BUSY',
      message: 'busy',
      detail: { table: 'fact' },
      retry_after_ms: 500,
    });
  });

  it('asMoshiError 保留原错误并保留堆栈', () => {
    const raw = new Error('boom');
    const wrapped = asMoshiError(raw);
    expect(isMoshiError(wrapped)).toBe(true);
    expect(wrapped.code).toBe('E_DB');
    expect(wrapped.stack).toBe(raw.stack);
    expect(asMoshiError(new MoshiError('E_INPUT', 'x')).code).toBe('E_INPUT');
  });
});

describe('日志（详设 §11.1）', () => {
  const dirs: string[] = [];

  const tmp = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'moshi-log-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        for (const f of readdirSync(d)) {
          try {
            writeFileSync(path.join(d, f), '');
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
  });

  it('写 JSONL 且含固定字段', async () => {
    const dir = tmp();
    const built = buildLogger({ level: 'info', dir, stderr: false });
    built.logger.info({ event: 'harvest.done', scanned: 812, created: 47 }, 'harvest done');
    await built.close();

    expect(built.filePath).not.toBeNull();
    const line = readFileSync(built.filePath as string, 'utf8').trim();
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec['event']).toBe('harvest.done');
    expect(rec['scanned']).toBe(812);
    expect(rec['level']).toBe('info');
    expect(typeof rec['ts']).toBe('string');
  });

  it('敏感字段被脱敏', async () => {
    const dir = tmp();
    const built = buildLogger({ level: 'info', dir, stderr: false });
    built.logger.info({ event: 'x', token: 'sk-abcdefghijklmnopqrstuvwxyz' }, 'm');
    await built.close();
    const line = readFileSync(built.filePath as string, 'utf8');
    expect(line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(line).toContain('<REDACTED>');
  });

  it('必须记录的事件清单包含概设 §10.1 的全部事件', () => {
    expect(REQUIRED_EVENTS).toContain('invariant.violation');
    expect(REQUIRED_EVENTS.length).toBe(14);
  });

  it('日志文件名按天', () => {
    expect(logFileName(new Date(2026, 10, 1))).toBe('moshi-2026-11-01.jsonl');
  });

  it('pruneLogs 只删过期文件', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, 'moshi-2026-01-01.jsonl');
    const newFile = path.join(dir, 'moshi-2026-11-01.jsonl');
    writeFileSync(oldFile, '{}\n');
    writeFileSync(newFile, '{}\n');
    const longAgo = new Date('2026-01-05').getTime() / 1000;
    utimesSync(oldFile, longAgo, longAgo);

    const removed = pruneLogs(dir, 7, new Date('2026-11-01T12:00:00'));
    expect(removed).toBe(1);
    expect(readdirSync(dir)).toEqual(['moshi-2026-11-01.jsonl']);
  });
});
