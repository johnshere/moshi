/**
 * 解析器 fixture（详设 §5.3.1）。
 *
 * 每条 parser 两个用例：**命中**（真实输出样本）与**近似但不该命中**（`miss`）。
 * 后者比前者重要——正则写宽了，命中用例照样绿，只有"近似样本不该命中"才能挡住
 * 把 `Finished dev ... in 1.2s` 误当成 `Compiling serde v1.0.198` 这类错误。
 */
import type { RawTurn } from '../../src/core/parse/types.js';

export interface TurnCase {
  parser: string;
  turn: RawTurn;
  /** 期望抽出的事实（只比对这些字段，其余不比） */
  expected: { predicate: string; subject: string; value?: unknown }[];
}

const bash = (cmd: string, output: string, extra: Partial<RawTurn> = {}): RawTurn => ({
  tool: 'Bash',
  cmd,
  output,
  exitCode: 0,
  ...extra,
});

export const TURN_CASES: readonly TurnCase[] = [
  {
    parser: 'pkg.npm',
    turn: bash('npm install react', 'added 1 package in 2s\n\n+ react@18.2.0\n'),
    expected: [{ predicate: 'installed_version', subject: 'react', value: '18.2.0' }],
  },
  {
    parser: 'pkg.pnpm',
    turn: bash('pnpm add react', 'dependencies:\n+ react 18.2.0\n+ react-dom 18.2.0\n'),
    expected: [
      { predicate: 'installed_version', subject: 'react', value: '18.2.0' },
      { predicate: 'installed_version', subject: 'react-dom', value: '18.2.0' },
    ],
  },
  {
    parser: 'pkg.pip',
    turn: bash(
      'pip install requests',
      'Successfully installed requests-2.31.0 charset-normalizer-3.3.2\n',
    ),
    expected: [
      { predicate: 'installed_version', subject: 'requests', value: '2.31.0' },
      { predicate: 'installed_version', subject: 'charset-normalizer', value: '3.3.2' },
    ],
  },
  {
    parser: 'pkg.cargo',
    turn: bash('cargo build', '   Compiling serde v1.0.197\n    Finished dev in 1.2s\n'),
    expected: [{ predicate: 'installed_version', subject: 'serde', value: '1.0.197' }],
  },
  {
    parser: 'pkg.lockfile',
    turn: bash('cat pnpm-lock.yaml', 'lockfileVersion: 9.0\n', { cwd: '/home/u/proj' }),
    expected: [{ predicate: 'package_manager', subject: '/home/u/proj', value: 'pnpm' }],
  },
  {
    parser: 'ver.node',
    turn: bash('node -v', 'v22.9.0\n'),
    expected: [{ predicate: 'runtime_version', subject: 'node', value: '22.9.0' }],
  },
  {
    parser: 'ver.python',
    turn: bash('python3 --version', 'Python 3.12.1\n'),
    expected: [{ predicate: 'runtime_version', subject: 'python', value: '3.12.1' }],
  },
  {
    parser: 'ver.generic',
    turn: bash('git --version', 'git version 2.43.0\n'),
    expected: [{ predicate: 'version', subject: 'git', value: '2.43.0' }],
  },
  {
    parser: 'git.branch',
    turn: bash('git status', "On branch main\nYour branch is up to date with 'origin/main'.\n", {
      cwd: '/home/u/proj',
    }),
    expected: [{ predicate: 'git_branch', subject: '/home/u/proj', value: 'main' }],
  },
  {
    parser: 'git.ahead',
    turn: bash('git status', "On branch main\nYour branch is ahead of 'origin/main' by 2 commits.\n", {
      cwd: '/home/u/proj',
    }),
    // 同一条 `git status` 里既有分支也有同步状态——两条事实都要，别只留一条
    expected: [
      { predicate: 'git_branch', subject: '/home/u/proj', value: 'main' },
      {
        predicate: 'git_sync_state',
        subject: '/home/u/proj',
        value: { state: 'ahead', upstream: 'origin/main', commits: 2 },
      },
    ],
  },
  {
    parser: 'git.commit',
    turn: bash('git log --oneline -1', 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0 fix: thing\n', {
      cwd: '/home/u/proj',
    }),
    expected: [
      {
        predicate: 'git_head',
        subject: '/home/u/proj',
        value: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
      },
    ],
  },
  {
    parser: 'proc.lsof',
    turn: bash(
      'lsof -i:8080',
      [
        'COMMAND   PID USER   FD   TYPE     DEVICE SIZE/OFF NODE NAME',
        'node    48213 john   23u  IPv4 0x7f8a1c2d      0t0  TCP *:8080 (LISTEN)',
      ].join('\n'),
    ),
    expected: [
      { predicate: 'occupied_by', subject: '8080', value: { process: 'node', pid: 48213, port: 8080 } },
    ],
  },
  {
    parser: 'proc.netstat',
    turn: bash(
      'netstat -tlnp',
      [
        'Active Internet connections (only servers)',
        'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
        'tcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN      48213/node',
      ].join('\n'),
    ),
    expected: [
      { predicate: 'occupied_by', subject: '8080', value: { process: 'node', pid: 48213, port: 8080 } },
    ],
  },
  {
    parser: 'proc.ps',
    turn: bash(
      'ps aux',
      [
        'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
        'john     48213  1.2  3.4 1234567 89012 ?        Sl   10:00   0:05 node server.js',
      ].join('\n'),
    ),
    expected: [
      {
        predicate: 'running',
        subject: 'node',
        value: { process: 'node', pid: 48213, command: 'node server.js' },
      },
    ],
  },
  {
    parser: 'proc.ps',
    turn: bash(
      'ps -ef',
      [
        'UID        PID  PPID  C STIME TTY          TIME CMD',
        'root         1     0  0 09:00 ?        00:00:01 /sbin/init',
      ].join('\n'),
    ),
    expected: [
      {
        predicate: 'running',
        subject: 'init',
        value: { process: 'init', pid: 1, command: '/sbin/init' },
      },
    ],
  },
  {
    parser: 'err.eaddrinuse',
    turn: bash('node server.js', 'Error: listen EADDRINUSE: address already in use :::3000\n', {
      exitCode: 1,
    }),
    expected: [{ predicate: 'port_conflict', subject: '3000', value: { port: 3000 } }],
  },
  {
    parser: 'fs.test',
    turn: bash('test -f /home/u/proj/package.json', ''),
    expected: [
      { predicate: 'exists', subject: '/home/u/proj/package.json', value: { exists: true, kind: 'file' } },
    ],
  },
  {
    parser: 'build.npm',
    turn: bash('npm run build', '\n> tsc -p tsconfig.build.json\n\nbuilt in 1.23s\n', {
      cwd: '/home/u/proj',
    }),
    expected: [
      { predicate: 'build_result', subject: '/home/u/proj', value: { ok: true, duration_s: 1.23 } },
    ],
  },
  {
    parser: 'build.tsc',
    turn: bash('npx tsc --noEmit', 'src/a.ts(1,2): error TS2322\nFound 3 errors in 2 files.\n', {
      cwd: '/home/u/proj',
    }),
    expected: [
      { predicate: 'typecheck_result', subject: '/home/u/proj', value: { errors: 3, ok: false } },
    ],
  },
  {
    parser: 'test.vitest',
    turn: bash('npx vitest run', '\n Test Files  13 passed (13)\n      Tests  255 passed (255)\n', {
      cwd: '/home/u/proj',
    }),
    expected: [
      { predicate: 'test_result', subject: '/home/u/proj', value: { passed: 255, failed: 0 } },
    ],
  },
  {
    parser: 'test.pytest',
    turn: bash('pytest -q', '====== 12 passed, 2 failed in 3.4s ======\n', { cwd: '/home/u/proj' }),
    expected: [
      { predicate: 'test_result', subject: '/home/u/proj', value: { passed: 12, failed: 2 } },
    ],
  },
];

/** 近似但不该命中的样本：正则写宽了只会在这些用例上暴露 */
export const MISS_CASES: readonly { parser: string; turn: RawTurn; why: string }[] = [
  { parser: 'pkg.npm', turn: bash('npm install', 'added 0 packages in 1s\n'), why: '没有 + 行' },
  { parser: 'pkg.pnpm', turn: bash('pnpm i', 'Already up to date\n'), why: '无变更' },
  {
    parser: 'pkg.pip',
    turn: bash('pip install -r x.txt', 'Requirement already satisfied: requests\n'),
    why: '已装过',
  },
  {
    parser: 'pkg.cargo',
    turn: bash('cargo build', '    Finished dev [unoptimized] target(s) in 1.2s\n'),
    why: '只有 Finished，没有 Compiling',
  },
  { parser: 'pkg.lockfile', turn: bash('ls', 'src\n'), why: '没有锁文件' },
  { parser: 'ver.node', turn: bash('node -v', 'bash: node: command not found\n'), why: '没装' },
  { parser: 'ver.python', turn: bash('python3 --version', 'python3: command not found\n'), why: '没装' },
  { parser: 'ver.generic', turn: bash('git --version', 'git: command not found\n'), why: '没装' },
  {
    parser: 'git.branch',
    turn: bash('git status', 'fatal: not a git repository\n'),
    why: '不是仓库',
  },
  {
    parser: 'git.ahead',
    turn: bash('git status', "On branch main\nnothing to commit, working tree clean\n"),
    why: '没有 ahead/behind',
  },
  {
    parser: 'git.commit',
    turn: bash('git log --oneline', 'fatal: not a git repository\n'),
    why: '不是仓库',
  },
  { parser: 'proc.lsof', turn: bash('lsof -i:8080', ''), why: '端口没人占' },
  {
    parser: 'proc.netstat',
    turn: bash('netstat -tlnp', 'Active Internet connections (only servers)\n'),
    why: '只有表头',
  },
  { parser: 'proc.ps', turn: bash('ps aux', ''), why: '空输出' },
  { parser: 'err.eaddrinuse', turn: bash('node server.js', 'Error: listen EACCES\n'), why: '别的错' },
  { parser: 'fs.test', turn: bash('test -f /nope', '', { exitCode: 1 }), why: '退出码非 0' },
  { parser: 'build.npm', turn: bash('npm run build', 'Build failed with 3 errors\n'), why: '构建失败' },
  {
    parser: 'build.tsc',
    turn: bash('npx tsc --noEmit', 'src/a.ts(1,2): error TS2322\n'),
    why: '没有 Found N errors 汇总行',
  },
  { parser: 'test.vitest', turn: bash('npx vitest run', 'No test files found\n'), why: '没测' },
  { parser: 'test.pytest', turn: bash('pytest -q', 'no tests ran in 0.01s\n'), why: '没测' },
];
