/**
 * 文件系统类解析器（详设 §5.3.1 #17）。
 *
 * V-05：删除 `fs.ls`。目录清单是典型的可现场重查数据，逐目录项落 `exists`
 * 事实只会污染长期记忆；项目标记用显式 `test -f` / `test -d` 观测即可。
 * `fs.test` 的置信度 0.98 来自结构化证据——退出码是 0 就是存在，没有解析歧义。
 */
import { buildContent } from '../content.js';
import type { Parser } from '../types.js';
import { argvOf, excerpt, group, joinPath } from '../util.js';

/** `test -f x` / `[ -f x ]`；`-e` 存在、`-d` 目录、`-s` 非空、`-f` 普通文件 */
const TEST_CMD = /(?:^|[\s;&|(])(?:test|\[)\s+-([edfs])\s+(\S+?)(?:\s*\]|\s|$)/;

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
        retentionClass: 'cache',
        volatility: 'volatile',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'test', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

export const FS_PARSERS: readonly Parser[] = [testParser];
