/**
 * Git 类解析器（详设 §5.3.1 #6–#8）。
 *
 * 主体统一是**仓库**（`turn.cwd`），不是"git"——同一个 cwd 的分支、同步状态、
 * HEAD 是三条关于同一个仓库的事实，主体一致才能在子图里连成一片。
 *
 * `git.commit` 的正则 `^[0-9a-f]{7,40} ` 天生容易误伤（任何以十六进制开头的行），
 * 所以加了命令守卫：只有 `git log` / `git rev-parse` / `git show` 才启用。
 */
import { buildContent } from '../content.js';
import type { Parser, RawTurn } from '../types.js';
import { argvOf, excerpt, group, projectName } from '../util.js';

const ON_BRANCH = /^On branch (\S+)/m;
const AHEAD_BEHIND = /Your branch is (ahead of|behind) '([^']+)' by (\d+) commits?/m;
const HEX_LINE = /^([0-9a-f]{7,40})(?:\s|$)/m;

const GIT_COMMAND = /(?:^|[\s;&|])git\s+(?:log|rev-parse|show|status|branch)\b/;

function repoSubject(turn: RawTurn): { name: string; type: 'path' } {
  return { name: projectName(turn), type: 'path' };
}

const branchParser: Parser = {
  id: 'git.branch',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => GIT_COMMAND.test(turn.cmd) && ON_BRANCH.test(turn.output),
  extract: (turn) => {
    const m = ON_BRANCH.exec(turn.output);
    if (m === null) return [];
    const subject = repoSubject(turn);
    const branch = group(m, 1);
    return [
      {
        content: buildContent(subject, 'git_branch', branch),
        subject,
        predicate: 'git_branch',
        value: branch,
        confidence: 0.95,
        ftype: 'semantic',
        ext: { tool: 'git', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

const syncParser: Parser = {
  id: 'git.ahead',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => GIT_COMMAND.test(turn.cmd) && AHEAD_BEHIND.test(turn.output),
  extract: (turn) => {
    const m = AHEAD_BEHIND.exec(turn.output);
    if (m === null) return [];
    const subject = repoSubject(turn);
    const value = {
      state: group(m, 1).startsWith('ahead') ? 'ahead' : 'behind',
      upstream: group(m, 2),
      commits: Number(group(m, 3)),
    };
    return [
      {
        content: buildContent(subject, 'git_sync_state', value),
        subject,
        predicate: 'git_sync_state',
        value,
        confidence: 0.9,
        ftype: 'episodic',
        ext: { tool: 'git', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

const headParser: Parser = {
  id: 'git.commit',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => GIT_COMMAND.test(turn.cmd) && HEX_LINE.test(turn.output),
  extract: (turn) => {
    const m = HEX_LINE.exec(turn.output);
    if (m === null) return [];
    const subject = repoSubject(turn);
    const sha = group(m, 1);
    return [
      {
        content: buildContent(subject, 'git_head', sha.slice(0, 7)),
        subject,
        predicate: 'git_head',
        // 存全 sha，content 只显示 7 位：短 sha 给人看，全 sha 给 `git show` 用
        value: sha,
        confidence: 0.9,
        ftype: 'episodic',
        ext: { tool: 'git', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

export const GIT_PARSERS: readonly Parser[] = [branchParser, syncParser, headParser];

/** 供测试断言：git 解析器只在 git 命令下启用 */
export const GIT_COMMAND_GATE = GIT_COMMAND;
