/**
 * 写盘白名单（台账 P0-20）。
 *
 * 验收对应：白名单内写 → 成功；白名单外写 → 抛 E_ACCESS（三种写面全覆盖：
 * writeFile / appendFile / createWriteStream，漏一种就白做）。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MoshiError } from '../../src/domain/errors.js';
import {
  assertWritablePath,
  safeAppendFile,
  safeCreateExclusive,
  safeCreateWriteStream,
  safeEnsureDir,
  safeRemoveFile,
  safeWriteFile,
} from '../../src/infra/fs/safeWrite.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 白名单根；根自身允许写，根外（tmpdir 其余处）不允许 */
function setup(): { root: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'moshi-safe-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moshi-safe-out-'));
  dirs.push(root, outside);
  return { root, outside };
}

describe('assertWritablePath（白名单判定）', () => {
  it('根目录自身与根内任意深度都放行', () => {
    const { root } = setup();
    expect(() => assertWritablePath(root, [root])).not.toThrow();
    expect(() => assertWritablePath(path.join(root, 'a', 'b', 'c.json'), [root])).not.toThrow();
  });

  it('白名单外路径抛 E_ACCESS，即使路径前缀相似', () => {
    const { root, outside } = setup();
    const evil = path.join(root + '-fake', 'x.json'); // 前缀相似但不是根内
    for (const p of [outside, path.join(outside, 'x.json'), evil]) {
      try {
        assertWritablePath(p, [root]);
        expect.unreachable(`应当抛错：${p}`);
      } catch (err) {
        expect(err).toBeInstanceOf(MoshiError);
        expect((err as MoshiError).code).toBe('E_ACCESS');
      }
    }
  });
});

describe('safeWriteFile / safeAppendFile / safeCreateWriteStream（三种写面）', () => {
  it('白名单内：writeFile 成功且内容正确', () => {
    const { root } = setup();
    const f = path.join(root, 'sub', 'a.json');
    safeWriteFile(f, 'hello', [root]);
    expect(readFileSync(f, 'utf8')).toBe('hello');
  });

  it('白名单内：appendFile 追加不覆盖', () => {
    const { root } = setup();
    const f = path.join(root, 'log.txt');
    safeAppendFile(f, 'one\n', [root]);
    safeAppendFile(f, 'two\n', [root]);
    expect(readFileSync(f, 'utf8')).toBe('one\ntwo\n');
  });

  it('白名单内：createWriteStream 可写且 flush 落盘', async () => {
    const { root } = setup();
    const f = path.join(root, 's.log');
    const stream = safeCreateWriteStream(f, [root]);
    stream.write('line\n');
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    expect(readFileSync(f, 'utf8')).toBe('line\n');
  });

  it('白名单外：三种写面全部抛 E_ACCESS（漏一种就白做）', () => {
    const { root, outside } = setup();
    const f = path.join(outside, 'x.txt');
    for (const attempt of [
      () => safeWriteFile(f, 'x', [root]),
      () => safeAppendFile(f, 'x', [root]),
      () => safeCreateWriteStream(f, [root]),
    ]) {
      try {
        attempt();
        expect.unreachable('应当抛 E_ACCESS');
      } catch (err) {
        expect((err as MoshiError).code).toBe('E_ACCESS');
      }
    }
    // 白名单外不得产生任何文件
    expect(() => statSync(f)).toThrow();
  });
});

describe('safeEnsureDir / safeCreateExclusive / safeRemoveFile', () => {
  it('safeEnsureDir：根内建目录，根外抛 E_ACCESS', () => {
    const { root, outside } = setup();
    safeEnsureDir(path.join(root, 'd1', 'd2'), [root]);
    expect(statSync(path.join(root, 'd1', 'd2')).isDirectory()).toBe(true);
    try {
      safeEnsureDir(path.join(outside, 'd'), [root]);
      expect.unreachable('应当抛 E_ACCESS');
    } catch (err) {
      expect((err as MoshiError).code).toBe('E_ACCESS');
    }
  });

  it('safeCreateExclusive：首次创建成功，再次返回 false 不覆盖', () => {
    const { root } = setup();
    const f = path.join(root, 'lock');
    expect(safeCreateExclusive(f, 'v1', [root])).toBe(true);
    expect(safeCreateExclusive(f, 'v2', [root])).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('v1'); // 未被覆盖
  });

  it('safeCreateExclusive：白名单外抛 E_ACCESS', () => {
    const { root, outside } = setup();
    try {
      safeCreateExclusive(path.join(outside, 'lock'), 'x', [root]);
      expect.unreachable('应当抛 E_ACCESS');
    } catch (err) {
      expect((err as MoshiError).code).toBe('E_ACCESS');
    }
  });

  it('safeRemoveFile：删除成功；不存在静默通过；白名单外抛 E_ACCESS', () => {
    const { root, outside } = setup();
    const f = path.join(root, 'gone.txt');
    writeFileSync(f, 'x');
    safeRemoveFile(f, [root]);
    expect(() => statSync(f)).toThrow();
    expect(() => safeRemoveFile(f, [root])).not.toThrow(); // 不存在即已达成
    try {
      safeRemoveFile(path.join(outside, 'x'), [root]);
      expect.unreachable('应当抛 E_ACCESS');
    } catch (err) {
      expect((err as MoshiError).code).toBe('E_ACCESS');
    }
  });
});
