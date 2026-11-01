/**
 * 依赖方向检查（概设 §1.6 四条硬规矩 / 详设 §3.2）。
 *
 * 为什么不用 dependency-cruiser：它解析不了 NodeNext 下 `./x.js` → `./x.ts`
 * 的扩展名替换（v16 / v18 的 options schema 都不接受 extensionAlias），
 * 相对导入全部 couldNotResolve，五条 forbid 规则会变成空转——规则"通过"但没有检查任何东西。
 * 这里直接用 TypeScript 自己的模块解析，与 `tsc` 的分辨结果必然一致。
 *
 * 用法：`pnpm lint:deps`；有违规退出码 1。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Rule {
  name: string;
  comment: string;
  from: RegExp;
  to: RegExp;
}

/** 与详设 §3.2 一一对应 */
const RULES: readonly Rule[] = [
  {
    name: 'core-no-app',
    comment: 'core 不得依赖 app（组装层）。方向只能是 app → core → domain。',
    from: /^src\/core\//,
    to: /^src\/app\//,
  },
  {
    name: 'core-no-mcp',
    comment: 'core 不得依赖 mcp/http：core 不该知道自己是「被谁调用」的。',
    from: /^src\/core\//,
    to: /^src\/app\/(mcp|http)\//,
  },
  {
    name: 'domain-pure',
    comment: 'domain 是纯类型与纯函数，不得依赖 infra/core/app。',
    from: /^src\/domain\//,
    to: /^src\/(infra|core|app)\//,
  },
  {
    name: 'read-write-orthogonal',
    comment: 'K2 正交化：读通路不得依赖写通路。',
    from: /^src\/core\/read\//,
    to: /^src\/core\/write\//,
  },
  {
    name: 'write-read-orthogonal',
    comment: 'K2 正交化：写通路不得依赖读通路。',
    from: /^src\/core\/write\//,
    to: /^src\/core\/read\//,
  },
];

interface Edge {
  from: string;
  to: string;
  spec: string;
}

function loadProgram(): { files: string[]; options: ts.CompilerOptions } {
  const configPath = path.join(ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8'));
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, configPath);
  return { files: parsed.fileNames, options: parsed.options };
}

const toRel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

function collectEdges(files: readonly string[], options: ts.CompilerOptions): Edge[] {
  const moduleCache = ts.createModuleResolutionCache(ROOT, (s) => s, options);
  const edges: Edge[] = [];

  for (const file of files) {
    const rel = toRel(file);
    if (!rel.startsWith('src/') || rel.startsWith('src/ui/')) continue;

    const text = readFileSync(file, 'utf8');
    const info = ts.preProcessFile(text, true, true);

    for (const imp of info.importedFiles) {
      if (!imp.fileName.startsWith('.')) continue; // 只看内部相对导入
      const resolved = ts.resolveModuleName(imp.fileName, file, options, ts.sys, moduleCache)
        .resolvedModule;
      if (resolved === undefined) continue;
      const target = toRel(resolved.resolvedFileName);
      if (!target.startsWith('src/')) continue;
      edges.push({ from: rel, to: target, spec: imp.fileName });
    }
  }
  return edges;
}

function findCycles(edges: readonly Edge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list === undefined) adj.set(e.from, [e.to]);
    else list.push(e.to);
  }

  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 在栈上 2 已完成
  const stack: string[] = [];

  const visit = (node: string): void => {
    const s = state.get(node) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      const start = stack.indexOf(node);
      if (start >= 0) cycles.push([...stack.slice(start), node]);
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 2);
  };

  for (const node of adj.keys()) visit(node);
  return cycles;
}

function main(): number {
  const { files, options } = loadProgram();
  const edges = collectEdges(files, options);

  const violations: string[] = [];
  for (const e of edges) {
    for (const rule of RULES) {
      if (rule.from.test(e.from) && rule.to.test(e.to)) {
        violations.push(`${e.from} -> ${e.to}\n    违反 ${rule.name}：${rule.comment}`);
      }
    }
  }

  for (const cycle of findCycles(edges)) {
    violations.push(`循环依赖：${cycle.join(' -> ')}`);
  }

  const internal = new Set(edges.map((e) => e.from));
  if (violations.length > 0) {
    process.stderr.write(`\n✖ ${violations.length} 处依赖违规\n\n`);
    for (const v of violations) process.stderr.write(`  ${v}\n`);
    process.stderr.write('\n');
    return 1;
  }

  process.stdout.write(
    `✔ 依赖方向检查通过（${internal.size} 个模块，${edges.length} 条内部依赖，${RULES.length} 条规则）\n`,
  );
  return 0;
}

process.exitCode = main();
