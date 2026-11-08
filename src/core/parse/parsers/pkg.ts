/**
 * 包与版本类解析器（详设 §5.3.1 #1–#5、#9–#11）。
 *
 * `ver.*` 与 `pkg.*` 放同一个文件：两者回答的是同一个问题——"某个东西是哪个版本"，
 * 只是观测来源不同（包管理器输出 vs 运行时自报）。分成两个文件会让"改版本抽取逻辑
 * 要改两处"变成常态。
 *
 * 全部正则锚定行首（`^` + `m`）：包管理器输出里到处是缩进、进度条、`npm WARN`，
 * 不锚定行首就会把日志里的无关行也匹配进来。
 */
import { buildContent } from '../content.js';
import type { ExtractedFact, Parser, RawTurn } from '../types.js';
import { allMatches, argvOf, excerpt, group, projectName } from '../util.js';

/** npm 7+：`+ react@18.2.0` */
const NPM_ADDED = /^\+ ([@\w/.-]+)@(\d+\.\d+\.\d+[\w.-]*)/gm;
/** pnpm：`+ react 18.2.0`（注意没有 `@`，靠这个区分，两种格式不会互相误匹配） */
const PNPM_ADDED = /^\s*\+ ([@\w/.-]+) (\d+\.\d+\.\d+[\w.-]*)/gm;
/** pip：`Successfully installed requests-2.31.0 charset-normalizer-3.3.2` */
const PIP_INSTALLED = /^Successfully installed (.+)$/gm;
/** cargo：`   Compiling serde v1.0.197` */
const CARGO_COMPILING = /^\s+Compiling (\S+) v(\S+)/gm;

const NODE_VERSION = /^v(\d+\.\d+\.\d+)$/m;
const PYTHON_VERSION = /^Python (\d+\.\d+\.\d+)/m;
const GENERIC_VERSION = /^([A-Za-z][\w-]*) (?:version )?v?(\d+\.\d+\.\d+)/m;

const LOCKFILES: readonly { file: string; manager: string }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'poetry.lock', manager: 'poetry' },
];

function pkgFact(
  turn: RawTurn,
  name: string,
  version: string,
  confidence: number,
  tool: string,
  line: string,
): ExtractedFact {
  const subject = { name, type: 'pkg' as const };
  return {
    content: buildContent(subject, 'installed_version', version),
    subject,
    predicate: 'installed_version',
    value: version,
    confidence,
    ftype: 'semantic',
    retentionClass: 'durable',
    volatility: 'slow',
    admissionReason: 'context_needed',
    sourceKind: 'observation',
    recheckKind: 'command',
    ext: { tool, argv: argvOf(turn.cmd), raw_excerpt: excerpt(line) },
  };
}

/** `charset-normalizer-3.3.2` → `['charset-normalizer', '3.3.2']`；拆不开就跳过 */
export function splitPipRequirement(token: string): [string, string] | null {
  const m = /^(.+?)-(\d[\w.]*)$/.exec(token.trim());
  if (m === null) return null;
  return [group(m, 1), group(m, 2)];
}

const npmParser: Parser = {
  id: 'pkg.npm',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => allMatches(turn.output, NPM_ADDED).length > 0,
  extract: (turn) =>
    allMatches(turn.output, NPM_ADDED).map((m) =>
      pkgFact(turn, group(m, 1), group(m, 2), 0.95, 'npm', m[0]),
    ),
};

const pnpmParser: Parser = {
  id: 'pkg.pnpm',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => allMatches(turn.output, PNPM_ADDED).length > 0,
  extract: (turn) =>
    allMatches(turn.output, PNPM_ADDED).map((m) =>
      pkgFact(turn, group(m, 1), group(m, 2), 0.95, 'pnpm', m[0]),
    ),
};

const pipParser: Parser = {
  id: 'pkg.pip',
  tools: ['bash', 'shell', 'exec'],
  // 不用 `.test()`：PIP_INSTALLED 带 `g`，test 会推进 lastIndex，第二次调用结果就变了
  match: (turn) => allMatches(turn.output, PIP_INSTALLED).length > 0,
  extract: (turn) => {
    const facts: ExtractedFact[] = [];
    for (const m of allMatches(turn.output, PIP_INSTALLED)) {
      for (const token of group(m, 1).trim().split(/\s+/)) {
        const parsed = splitPipRequirement(token);
        if (parsed === null) continue;
        facts.push(pkgFact(turn, parsed[0], parsed[1], 0.95, 'pip', m[0]));
      }
    }
    return facts;
  },
};

const cargoParser: Parser = {
  id: 'pkg.cargo',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => allMatches(turn.output, CARGO_COMPILING).length > 0,
  extract: (turn) =>
    allMatches(turn.output, CARGO_COMPILING).map((m) =>
      pkgFact(turn, group(m, 1), group(m, 2), 0.9, 'cargo', m[0]),
    ),
};

/**
 * 锁文件 → 包管理器。主体是**项目目录**（有 cwd 用 cwd，否则退回锁文件名），
 * 因为"这个项目用 pnpm"才是要记的事实，"pnpm-lock.yaml 存在"只是它的证据。
 */
const lockfileParser: Parser = {
  id: 'pkg.lockfile',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => {
    const hay = `${turn.cmd}\n${turn.output}`;
    return LOCKFILES.some((l) => hay.includes(l.file));
  },
  extract: (turn) => {
    const hay = `${turn.cmd}\n${turn.output}`;
    const facts: ExtractedFact[] = [];
    for (const lock of LOCKFILES) {
      if (!hay.includes(lock.file)) continue;
      const subject = { name: projectName(turn), type: 'path' as const };
      facts.push({
        content: buildContent(subject, 'package_manager', lock.manager),
        subject,
        predicate: 'package_manager',
        value: lock.manager,
        confidence: 0.9,
        ftype: 'semantic',
        retentionClass: 'durable',
        volatility: 'static',
        admissionReason: 'context_needed',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'lockfile', file: lock.file, argv: argvOf(turn.cmd) },
      });
    }
    return facts;
  },
};

const nodeVersionParser: Parser = {
  id: 'ver.node',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) =>
    /(?:^|[\s/])node\s+(?:-v|--version)\b/.test(turn.cmd) && NODE_VERSION.test(turn.output),
  extract: (turn) => {
    const m = NODE_VERSION.exec(turn.output);
    if (m === null) return [];
    const subject = { name: 'node', type: 'pkg' as const };
    return [
      {
        content: buildContent(subject, 'runtime_version', group(m, 1)),
        subject,
        predicate: 'runtime_version',
        value: group(m, 1),
        confidence: 0.98,
        ftype: 'semantic',
        retentionClass: 'durable',
        volatility: 'slow',
        admissionReason: 'context_needed',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'node', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

const pythonVersionParser: Parser = {
  id: 'ver.python',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) =>
    /(?:^|[\s/])python[0-9.]*\s+(?:-V|--version)\b/.test(turn.cmd) &&
    PYTHON_VERSION.test(turn.output),
  extract: (turn) => {
    const m = PYTHON_VERSION.exec(turn.output);
    if (m === null) return [];
    const subject = { name: 'python', type: 'pkg' as const };
    return [
      {
        content: buildContent(subject, 'runtime_version', group(m, 1)),
        subject,
        predicate: 'runtime_version',
        value: group(m, 1),
        confidence: 0.98,
        ftype: 'semantic',
        retentionClass: 'durable',
        volatility: 'slow',
        admissionReason: 'context_needed',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'python', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

/**
 * 兜底版本解析：`git --version` → `git version 2.43.0`。
 *
 * 两个守卫防止它抢戏：
 * - 命令里必须真的在问版本（`-v` / `--version`）；
 * - 输出以 `Python ` 开头时让给 `ver.python`（否则同一行会落两条事实，
 *   `runtime_version` 和 `version` 各一条）。
 */
const genericVersionParser: Parser = {
  id: 'ver.generic',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) =>
    /(?:^|\s)-{1,2}(?:version|V|v)(?:\s|$)/.test(turn.cmd) &&
    !PYTHON_VERSION.test(turn.output) &&
    GENERIC_VERSION.test(turn.output),
  extract: (turn) => {
    const m = GENERIC_VERSION.exec(turn.output);
    if (m === null) return [];
    const subject = { name: group(m, 1), type: 'pkg' as const };
    return [
      {
        content: buildContent(subject, 'version', group(m, 2)),
        subject,
        predicate: 'version',
        value: group(m, 2),
        confidence: 0.9,
        ftype: 'semantic',
        retentionClass: 'durable',
        volatility: 'slow',
        admissionReason: 'context_needed',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: group(m, 1).toLowerCase(), argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

export const PKG_PARSERS: readonly Parser[] = [
  npmParser,
  pnpmParser,
  pipParser,
  cargoParser,
  lockfileParser,
  nodeVersionParser,
  pythonVersionParser,
  genericVersionParser,
];
