/**
 * 生命周期字段写路径检查（概设 §1.6 第 3 条 / 详设 §3.3）。
 *
 * 规则：业务代码（core / app）**不得**直接碰数据库句柄，也不得自己拼 SQL 改生命周期字段。
 * 违例不会在运行时报错，只会让 K2 正交化在半年后悄悄失守——所以必须静态拦住。
 *
 * **匹配在整篇文件文本上做，不按行切**：`db` 与 `.prepare(` 之间的换行属于 prettier 的
 * 正常排版（长 SQL 一律折行），按行匹配会让 `db\n.prepare(` 这种写法绕过检查——
 * P1-19 验收时 core 里真实有 22 处裸 SQL，按行检查只报了 6 处。
 *
 * 用法：`pnpm lint:lifecycle`；有违例退出码 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['src/core', 'src/app'];
const ALLOWED_DIR_PREFIX = 'src/infra';

/** 直接操作数据库句柄的写法（`\s*` 允许换行） */
const DB_HANDLE_RE = /\bdb\s*\.\s*(prepare|exec|pragma|transaction)\s*\(/g;

/** 裸 SQL 改生命周期字段（即使出现在 infra 之外的地方也不允许） */
const LIFECYCLE_SQL_RE =
  /\bUPDATE\s+fact\s+SET\b[^'"`]*\b(strength|pool|access_count|last_access_at|last_decay_at)\b/gi;

/** 裸 SQL 改不可变内容 */
const IMMUTABLE_SQL_RE = /\bUPDATE\s+fact\s+SET\b[^'"`]*\b(content|attrs)\s*=/gi;

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

/** 命中位置 → 行号与该行文本（报告里要能一眼看到是哪一行） */
function locate(content: string, index: number): { line: number; text: string } {
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const start = before.lastIndexOf('\n') + 1;
  const end = content.indexOf('\n', index);
  return { line, text: content.slice(start, end === -1 ? content.length : end).trim() };
}

function collect(
  re: RegExp,
  content: string,
  file: string,
  rule: string,
  out: Violation[],
): void {
  re.lastIndex = 0;
  for (const m of content.matchAll(re)) {
    if (m.index === undefined) continue;
    const at = locate(content, m.index);
    out.push({ file, line: at.line, rule, text: at.text });
  }
}

function main(): number {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);

  const violations: Violation[] = [];
  for (const file of files) {
    const relPath = rel(file);
    if (relPath.startsWith(ALLOWED_DIR_PREFIX)) continue;
    const content = readFileSync(file, 'utf8');
    collect(DB_HANDLE_RE, content, relPath, 'no-raw-db-handle', violations);
    collect(LIFECYCLE_SQL_RE, content, relPath, 'no-lifecycle-sql', violations);
    collect(IMMUTABLE_SQL_RE, content, relPath, 'no-immutable-sql', violations);
  }

  if (violations.length > 0) {
    process.stderr.write(`\n✖ ${violations.length} 处生命周期写路径违规\n\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.text}\n`);
    }
    process.stderr.write('\n  生命周期字段只能经 infra/sqlite 的专用方法写（概设 §1.6 第 3 条）\n\n');
    return 1;
  }

  process.stdout.write(`✔ 生命周期写路径检查通过（${files.length} 个文件）\n`);
  return 0;
}

process.exitCode = main();
