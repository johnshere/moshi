/**
 * 归档反模式检查（详设 §9.7 / 概设 §9.8；P2-19A）。
 *
 * 静态扫描 `src/core/archive/*`，钉住三条红线：
 *   1. `ingest`：读归档 `.md` 后把内容写回 DB 的 fact/entity/ontology（禁止回灌；
 *      archive_meta 的 content_hash 基线不在此列，那是 §9.4 的设计口径）。
 *   2. `content_full`：把原始来源字段（payload / rawText / sourceText / episode 正文）
 *      写进归档正文（原文不出境；fact.content 是已提炼结论，允许摘要引用）。
 *   3. `delete`：`rm` / `unlink` / `safeRemove*` 删除归档文件（合并/分裂只标记不删）。
 *
 * 用 TypeScript AST 而不是正则，避免注释/字符串里的假阳性；行内或上一行写
 * `check-archive-ignore` 可白名单该行。
 *
 * 用法：`pnpm exec tsx tools/check-archive.ts [--json]`；有违规退出码 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARCHIVE_DIR = path.join(ROOT, 'src', 'core', 'archive');

export type ArchiveRule = 'ingest' | 'content_full' | 'delete';

export interface ArchiveViolation {
  file: string;
  line: number;
  rule: ArchiveRule;
  text: string;
}

/** 读归档文件的入口（archive 层里的 readFileSync 只用于 .md） */
const READ_SYMBOLS = new Set(['readFileSync', 'readFile', 'readTextFile']);

/** 写回结构化内容的仓储函数名（archive_meta 记账不在此列） */
const DB_WRITE_PATTERN = /^(?:insert|upsert|update|delete|recreate|write)(?:Fact|Entity|Ontology)(?:Row|Record)?$/;

/** 原始来源字段：出现在归档层即视为"原文出境"风险 */
const RAW_SOURCE_FIELDS = new Set([
  'rawText',
  'sourceText',
  'originalText',
  'payloadJson',
  'payload',
  'episodeText',
  'transcriptText',
  'messageText',
]);

/** 物理删除符号；safeRemove* 也是删除，归档只允许标记不删文件 */
const DELETE_SYMBOLS = new Set(['rm', 'rmSync', 'unlink', 'unlinkSync', 'safeRemoveFile', 'safeRemoveDir']);

const DB_CONTENT_SQL =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:fact|entity|ontology)\b/i;

function calleeName(node: ts.CallExpression): string | null {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function literalText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function isIgnored(lines: readonly string[], line: number): boolean {
  const current = lines[line - 1] ?? '';
  const previous = lines[line - 2] ?? '';
  return current.includes('check-archive-ignore') || previous.includes('check-archive-ignore');
}

/**
 * 扫描单个源文件（导出给单测；CLI 只负责遍历目录）。
 * `file` 用相对/绝对路径均可，只进入违规项做展示。
 */
export function scanArchiveSource(code: string, file: string): ArchiveViolation[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = code.split('\n');
  const found = new Map<string, ArchiveViolation>();

  const push = (node: ts.Node, rule: ArchiveRule, text: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const lineNo = line + 1;
    if (isIgnored(lines, lineNo)) return;
    const key = `${lineNo}:${rule}`;
    if (found.has(key)) return;
    found.set(key, { file, line: lineNo, rule, text: `[${rule}] ${text}` });
  };

  let readsArchiveMarkdown = false;
  let writesDbContent = false;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null && READ_SYMBOLS.has(name)) readsArchiveMarkdown = true;
      if (name !== null && DB_WRITE_PATTERN.test(name)) {
        writesDbContent = true;
        push(node, 'ingest', `归档层调用「${name}」写回事实/实体/登记表`);
      }
      if (name === 'prepare' && ts.isPropertyAccessExpression(node.expression)) {
        const sql = node.arguments[0];
        const text = sql === undefined ? null : literalText(sql);
        if (text !== null && DB_CONTENT_SQL.test(text)) {
          writesDbContent = true;
          push(node, 'ingest', '归档层执行写 fact/entity/ontology 的 SQL（禁止回灌）');
        }
      }
      if (name !== null && DELETE_SYMBOLS.has(name)) {
        push(node, 'delete', `归档层调用「${name}」删除文件（合并/分裂只标记不删）`);
      }
    }

    if (ts.isIdentifier(node) && RAW_SOURCE_FIELDS.has(node.text)) {
      // 属性名声明（interface/type 字面量）不算引用
      const parent = node.parent;
      const isDeclarationName =
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node);
      if (!isDeclarationName) {
        push(node, 'content_full', `归档层引用原始来源字段「${node.text}」（原文不出境）`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  // 回灌需要"读归档"与"写结构化内容"同时出现（archive_meta 的 hash 基线是允许的）
  if (readsArchiveMarkdown && writesDbContent) {
    const first = [...found.values()].find((v) => v.rule === 'ingest');
    if (first === undefined) {
      found.set('ingest:file', {
        file,
        line: 1,
        rule: 'ingest',
        text: '[ingest] 同文件既读归档 Markdown 又写 fact/entity/ontology（禁止回灌）',
      });
    }
  }

  return [...found.values()].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

export interface ArchiveScanResult {
  files: string[];
  violations: ArchiveViolation[];
}

export function scanArchiveDir(dir = ARCHIVE_DIR): ArchiveScanResult {
  const files: string[] = [];
  walk(dir, files);
  files.sort();
  const violations: ArchiveViolation[] = [];
  for (const file of files) {
    violations.push(...scanArchiveSource(readFileSync(file, 'utf8'), rel(file)));
  }
  return { files: files.map(rel), violations };
}

const USAGE = 'usage: tsx tools/check-archive.ts [--json]';

function main(argv: readonly string[]): number {
  const json = argv.includes('--json');
  const unknown = argv.filter((a) => a !== '--json');
  if (unknown.length > 0) {
    console.error(`${USAGE}\nunknown args: ${unknown.join(' ')}`);
    return 2;
  }

  const { files, violations } = scanArchiveDir();
  if (json) {
    console.log(JSON.stringify({ ok: violations.length === 0, files, violations }, null, 2));
  }
  if (violations.length === 0) {
    if (!json) console.log(`check-archive OK — ${files.length} 个文件，无归档反模式`);
    return 0;
  }
  if (!json) {
    console.error(`check-archive 失败 — ${violations.length} 处归档反模式：`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  } else {
    console.error(`check-archive 失败 — ${violations.length} 处归档反模式`);
  }
  return 1;
}

const isCli =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) process.exit(main(process.argv.slice(2)));
