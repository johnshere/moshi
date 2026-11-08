/**
 * 构建与测试结果类解析器（详设 §5.3.1 #18–#21）。
 *
 * 这一组的价值不在"结果是什么"，而在**否定信号**：`Found 3 errors` / `Tests 12 passed | 2 failed`
 * 是最便宜的可信负面证据。所以哪怕 `build.npm` 只有 0.85，也要留——
 * 它存在的意义是让"我刚改完这行代码，构建过了吗"这类问题有据可查。
 */
import { buildContent } from '../content.js';
import type { Parser, RawTurn } from '../types.js';
import { argvOf, excerpt, group, projectName } from '../util.js';

const NPM_BUILT_IN = /built in ([\d.]+)\s*s/m;
const NPM_SUCCESS = /Successfully compiled/m;
const TSC_FOUND = /Found (\d+) errors?/m;
const VITEST_SUMMARY = /Tests\s+(\d+) passed(?:\s*\|\s*(\d+) failed)?/m;
const PYTEST_SUMMARY = /^=+ ([\d]+) passed(?:, ([\d]+) failed)?/m;

const BUILD_COMMAND = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bvite\s+build\b/;
const TSC_COMMAND = /(?:^|[\s;&|])tsc\b|typecheck/;
const TEST_COMMAND = /(?:^|[\s;&|])(?:vitest|jest|pytest)\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/;
const PYTEST_COMMAND = /(?:^|[\s;&|])pytest\b/;

function projectSubject(turn: RawTurn): { name: string; type: 'path' } {
  return { name: projectName(turn), type: 'path' };
}

const buildParser: Parser = {
  id: 'build.npm',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) =>
    BUILD_COMMAND.test(turn.cmd) && (NPM_BUILT_IN.test(turn.output) || NPM_SUCCESS.test(turn.output)),
  extract: (turn) => {
    const m = NPM_BUILT_IN.exec(turn.output);
    const value = { ok: true, duration_s: m === null ? null : Number(group(m, 1)) };
    const subject = projectSubject(turn);
    return [
      {
        content: buildContent(subject, 'build_result', value),
        subject,
        predicate: 'build_result',
        value,
        confidence: 0.85,
        ftype: 'episodic',
        retentionClass: 'event',
        volatility: 'historical',
        admissionReason: 'expensive',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'build', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m?.[0] ?? 'Successfully compiled') },
      },
    ];
  },
};

const tscParser: Parser = {
  id: 'build.tsc',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => TSC_COMMAND.test(turn.cmd) && TSC_FOUND.test(turn.output),
  extract: (turn) => {
    const m = TSC_FOUND.exec(turn.output);
    if (m === null) return [];
    const errors = Number(group(m, 1));
    const value = { errors, ok: errors === 0 };
    const subject = projectSubject(turn);
    return [
      {
        content: buildContent(subject, 'typecheck_result', value),
        subject,
        predicate: 'typecheck_result',
        value,
        confidence: 0.95,
        ftype: 'episodic',
        retentionClass: 'event',
        volatility: 'historical',
        admissionReason: 'expensive',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'tsc', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

const vitestParser: Parser = {
  id: 'test.vitest',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => TEST_COMMAND.test(turn.cmd) && VITEST_SUMMARY.test(turn.output),
  extract: (turn) => {
    const m = VITEST_SUMMARY.exec(turn.output);
    if (m === null) return [];
    const value = { passed: Number(group(m, 1)), failed: m[2] === undefined ? 0 : Number(group(m, 2)) };
    const subject = projectSubject(turn);
    return [
      {
        content: buildContent(subject, 'test_result', value),
        subject,
        predicate: 'test_result',
        value,
        confidence: 0.95,
        ftype: 'episodic',
        retentionClass: 'event',
        volatility: 'historical',
        admissionReason: 'expensive',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'vitest', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

const pytestParser: Parser = {
  id: 'test.pytest',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => PYTEST_COMMAND.test(turn.cmd) && PYTEST_SUMMARY.test(turn.output),
  extract: (turn) => {
    const m = PYTEST_SUMMARY.exec(turn.output);
    if (m === null) return [];
    const value = { passed: Number(group(m, 1)), failed: m[2] === undefined ? 0 : Number(group(m, 2)) };
    const subject = projectSubject(turn);
    return [
      {
        content: buildContent(subject, 'test_result', value),
        subject,
        predicate: 'test_result',
        value,
        confidence: 0.95,
        ftype: 'episodic',
        retentionClass: 'event',
        volatility: 'historical',
        admissionReason: 'expensive',
        sourceKind: 'observation',
        recheckKind: 'command',
        ext: { tool: 'pytest', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

export const BUILD_PARSERS: readonly Parser[] = [
  buildParser,
  tscParser,
  vitestParser,
  pytestParser,
];
