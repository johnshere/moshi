/**
 * 写盘白名单 lint（概设 §1.5 纪律 3 / 详设 §12.4 / 台账 P0-20）。
 *
 * 规则：`core` / `app` 层**不得** import 'node:fs' / 'node:fs/promises' 的任何写类 API
 * （writeFile/appendFile/createWriteStream/mkdir/rm/rename/unlink/…），只能经由
 * `infra/fs/safeWrite`（带白名单校验）。`infra/fs` 自身是实现封装点，豁免。
 *
 * 用 TypeScript AST（createSourceFile）而不是正则，避免注释/字符串里的假阳性。
 *
 * 用法：`pnpm lint:writes`；有违例退出码 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['src/core', 'src/app'];
const EXEMPT_DIR = path.join(ROOT, 'src', 'infra', 'fs');

/** node:fs 写类成员（同步 + promise 两套面）；openSync/closeSync 是双用途原语，单独按 mode 判定 */
const WRITE_SYMBOLS = new Set([
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'rmSync',
  'copyFileSync',
  'renameSync',
  'unlinkSync',
  'truncateSync',
  'chmodSync',
  'chownSync',
  'utimesSync',
  'writeSync',
  'createWriteStream',
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'copyFile',
  'rename',
  'unlink',
  'truncate',
  'chmod',
  'chown',
  'utimes',
  'write',
  'createWriteStream',
]);

const FS_MODULES = new Set(['node:fs', 'node:fs/promises']);

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
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

function rel(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

/** 扫描单个文件：命中的写类成员名 → 位置 */
function scanFile(file: string, violations: Violation[]): void {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const checkLine = (node: ts.Node, sym: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({
      file: rel(file),
      line: line + 1,
      rule: 'safe_write',
      text: `直接 import/使用 node:fs 写类 API「${sym}」——必须经由 infra/fs/safeWrite`,
    });
  };

  const visit = (node: ts.Node): void => {
    // named import：import { writeFileSync } from 'node:fs'
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec) && FS_MODULES.has(spec.text)) {
        const nb = node.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const name = el.propertyName?.text ?? el.name.text;
            if (WRITE_SYMBOLS.has(name)) checkLine(el, name);
          }
        }
      }
      return; // import 节点内部不需要继续下沉（default import 无写面）
    }
    // namespace 用法：fs.writeFileSync(...)（import * as fs）
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'fs' &&
        WRITE_SYMBOLS.has(node.name.text)
      ) {
        checkLine(node.name, node.name.text);
      }
    }
    // openSync 是双用途原语：只在**非只读模式**（'r'/'rs' 之外）时算写
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isOpenSync =
        (ts.isIdentifier(callee) && callee.text === 'openSync') ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'fs' &&
          callee.name.text === 'openSync');
      if (isOpenSync) {
        const mode = node.arguments[1];
        if (mode && ts.isStringLiteral(mode) && !/^r/.test(mode.text)) {
          checkLine(node, `openSync('${mode.text}')`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

function main(): number {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);

  const violations: Violation[] = [];
  for (const file of files) {
    if (path.dirname(file).startsWith(EXEMPT_DIR)) continue; // infra/fs 是封装点
    scanFile(file, violations);
  }

  if (violations.length === 0) {
    console.log(`lint:writes OK — ${files.length} 个文件，无白名单外写调用`);
    return 0;
  }

  console.error(`lint:writes 失败 — ${violations.length} 处白名单外写调用：`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}] ${v.text}`);
  }
  return 1;
}

process.exit(main());
