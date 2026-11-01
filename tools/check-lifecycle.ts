/**
 * 生命周期字段写路径检查（概设 §1.6 第 3 条 / 详设 §3.3）。
 *
 * 规则：业务代码（core / app）**不得**直接碰数据库句柄，也不得自己拼 SQL 改生命周期字段。
 * 违例不会在运行时报错，只会让 K2 正交化在半年后悄悄失守——所以必须静态拦住。
 *
 * 用法：`pnpm lint:lifecycle`；有违例退出码 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['src/core', 'src/app'];
const ALLOWED_DIR_PREFIX = 'src/infra';

/** 直接操作数据库句柄的写法 */
const DB_HANDLE_RE = /\bdb\s*\.\s*(prepare|exec|pragma|transaction)\s*\(/;

/** 裸 SQL 改生命周期字段（即使出现在 infra 之外的地方也不允许） */
const LIFECYCLE_SQL_RE =
  /\bUPDATE\s+fact\s+SET\b[^'"`]*\b(strength|pool|access_count|last_access_at|last_decay_at)\b/i;

/** 裸 SQL 改不可变内容 */
const IMMUTABLE_SQL_RE = /\bUPDATE\s+fact\s+SET\b[^'"`]*\b(content|attrs)\s*=/i;

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

function main(): number {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);

  const violations: Violation[] = [];
  for (const file of files) {
    const relPath = rel(file);
    if (relPath.startsWith(ALLOWED_DIR_PREFIX)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (DB_HANDLE_RE.test(text)) {
        violations.push({ file: relPath, line: i + 1, rule: 'no-raw-db-handle', text: text.trim() });
      }
      if (LIFECYCLE_SQL_RE.test(text)) {
        violations.push({ file: relPath, line: i + 1, rule: 'no-lifecycle-sql', text: text.trim() });
      }
      if (IMMUTABLE_SQL_RE.test(text)) {
        violations.push({ file: relPath, line: i + 1, rule: 'no-immutable-sql', text: text.trim() });
      }
    });
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
