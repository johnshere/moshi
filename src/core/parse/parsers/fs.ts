/**
 * 文件系统类解析器（详设 §5.3.1 #16–#17）。
 *
 * `fs.ls` 的置信度只有 0.90 而 `fs.test` 有 0.98，差别在**证据强度**：
 * `ls` 的输出要靠列位解析（权限串 + 链接数 + owner + group + size + 时间 + 名字），
 * 而 `test -f` 只有一件事——退出码是 0 就是存在。退出码是结构化观测，
 * 没有解析歧义，所以它敢给 0.98。
 */
import { buildContent } from '../content.js';
import type { ExtractedFact, Parser } from '../types.js';
import { allMatches, argvOf, excerpt, group, joinPath } from '../util.js';

/** `-rw-r--r--  1 john staff  1234 Oct  1 10:00 file.txt` */
const LS_LONG = /^([-dl])(\S{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.+)$/gm;

const LS_COMMAND = /(?:^|[\s;&|])ls\b/;
/** `test -f x` / `[ -f x ]`；`-e` 存在、`-d` 目录、`-s` 非空、`-f` 普通文件 */
const TEST_CMD = /(?:^|[\s;&|(])(?:test|\[)\s+-([edfs])\s+(\S+?)(?:\s*\]|\s|$)/;

const KIND: Record<string, 'file' | 'dir' | 'link'> = {
  '-': 'file',
  d: 'dir',
  l: 'link',
};

const lsParser: Parser = {
  id: 'fs.ls',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => LS_COMMAND.test(turn.cmd) && allMatches(turn.output, LS_LONG).length > 0,
  extract: (turn) => {
    const facts: ExtractedFact[] = [];
    for (const m of allMatches(turn.output, LS_LONG)) {
      const name = group(m, 5);
      const path = joinPath(turn.cwd, name);
      const value = {
        exists: true,
        kind: KIND[group(m, 1)] ?? 'file',
        size: Number(group(m, 3)),
        mtime: group(m, 4),
      };
      const subject = { name: path, type: 'path' as const };
      facts.push({
        content: buildContent(subject, 'exists', value),
        subject,
        predicate: 'exists',
        value,
        confidence: 0.9,
        ftype: 'semantic',
        ext: { tool: 'ls', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      });
    }
    return facts;
  },
};

const testParser: Parser = {
  id: 'fs.test',
  tools: ['bash', 'shell', 'exec'],
  // 退出码非 0 时是"不存在"——Phase 0 不落负面事实（否定事实的时效性极强，
  // 一条"文件不存在"三个月后会变成错误记忆），等 Phase 2 的 invalidate 通路再做。
  match: (turn) => turn.exitCode === 0 && TEST_CMD.test(turn.cmd),
  extract: (turn) => {
    const m = TEST_CMD.exec(turn.cmd);
    if (m === null) return [];
    const flag = group(m, 1);
    const path = joinPath(turn.cwd, group(m, 2));
    const value = { exists: true, kind: flag === 'd' ? 'dir' : flag === 'f' ? 'file' : 'any' };
    const subject = { name: path, type: 'path' as const };
    return [
      {
        content: buildContent(subject, 'exists', value),
        subject,
        predicate: 'exists',
        value,
        confidence: 0.98,
        ftype: 'semantic',
        ext: { tool: 'test', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

export const FS_PARSERS: readonly Parser[] = [lsParser, testParser];
