/**
 * P2-19-B 验收工具：界面无裸颜色字面量。
 *
 * 扫描 `src/ui/**\/*.{ts,tsx,css}`，找硬编码颜色：`#rgb` / `#rrggbb` / `#rrggbbaa`、
 * `rgba(`、`hsla(`。`src/ui/styles/**` 是 token 定义处，免检；文件内某行行尾写
 * `// check-visual-ignore` 即整行豁免。
 *
 * 用法：
 *   npx tsx tools/check-visual.ts            # 违规 exit 1，干净 exit 0
 *   npx tsx tools/check-visual.ts --json     # {schema:'moshi-check-visual/1',...}
 *   npx tsx tools/check-visual.ts --max 12   # 容忍上限（迁移期用）
 *   npx tsx tools/check-visual.ts --root <dir>  # 指定扫描根（测试/临时目录）
 *
 * 不做完整 CSS 解析：行级正则 + 少量排除（`var(...)`、`href="#..."` 锚点）。
 * **不要**把本工具加进 `pnpm verify`——P2-19-B 迁移完成前 src/ui 必然有违规。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VISUAL_SCHEMA = 'moshi-check-visual/1';

const SCAN_EXTS = new Set(['.ts', '.tsx', '.css']);
const IGNORE_MARK = 'check-visual-ignore';
/** 颜色字面量：hex（3/6/8 位）或 rgba(/hsla( 函数开头 */
const COLOR_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgba|hsla)\s*\(/g;

export interface VisualViolation {
  file: string;
  line: number;
  match: string;
}

export interface CheckVisualResult {
  schema: typeof VISUAL_SCHEMA;
  files_scanned: number;
  violations: VisualViolation[];
  count: number;
}

export interface CheckVisualOptions {
  /** 扫描根；默认 `<cwd>/src/ui` */
  root?: string;
  /** 容忍上限；默认 0（任何违规都算失败） */
  max?: number;
}

export class CheckVisualArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckVisualArgError';
  }
}

const USAGE = [
  '用法: tsx tools/check-visual.ts [--json] [--max N] [--root <dir>]',
  '  --json       输出 {schema, files_scanned, violations, count}',
  '  --max N      容忍 N 条违规（默认 0）',
  '  --root <dir> 指定扫描根（默认 src/ui）',
].join('\n');

function toSlashes(p: string): string {
  return p.split(path.sep).join('/');
}

/** `src/ui/styles/**` 与（将来的）`src/ui/graph/pure/palette.ts` 是 token 定义处，免检 */
function isTokenModule(relToRoot: string): boolean {
  const rel = toSlashes(relToRoot);
  if (rel === 'styles' || rel.startsWith('styles/')) return true;
  if (rel === 'graph/pure/palette.ts') return true;
  return false;
}

function walkFiles(dir: string, onFile: (abs: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, onFile);
    else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) onFile(abs);
  }
}

/** 该行里的颜色字面量（已应用豁免：注释、var()、href 锚点） */
function matchesInLine(line: string): string[] {
  if (line.includes(IGNORE_MARK)) return [];
  // `var(--x)` / `var(--x, #fff)` 属 token 引用；`href="#..."` 是锚点不是颜色。
  const stripped = line
    .replace(/var\([^)]*\)/g, 'var()')
    .replace(/\b(?:href|xlinkHref)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g, 'href=""');
  return stripped.match(COLOR_RE) ?? [];
}

function displayPath(abs: string, root: string): string {
  const relCwd = path.relative(process.cwd(), abs);
  if (!relCwd.startsWith('..') && !path.isAbsolute(relCwd)) return toSlashes(relCwd);
  return toSlashes(path.relative(root, abs));
}

export function checkVisual(options: CheckVisualOptions = {}): CheckVisualResult {
  const scanRoot = path.resolve(options.root ?? path.join(process.cwd(), 'src/ui'));
  const violations: VisualViolation[] = [];
  let filesScanned = 0;

  walkFiles(scanRoot, (abs) => {
    const relToRoot = path.relative(scanRoot, abs);
    if (isTokenModule(relToRoot)) return;
    filesScanned += 1;
    const text = readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const matches = matchesInLine(lines[i] ?? '');
      for (const match of matches) {
        violations.push({ file: displayPath(abs, scanRoot), line: i + 1, match });
      }
    }
  });

  return {
    schema: VISUAL_SCHEMA,
    files_scanned: filesScanned,
    violations,
    count: violations.length,
  };
}

export function formatViolation(v: VisualViolation): string {
  return `${v.file}:${String(v.line)}: ${v.match}`;
}

export interface CliOptions {
  root: string;
  max: number;
  json: boolean;
}

export function parseCliArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): CliOptions {
  let root = path.join(cwd, 'src', 'ui');
  let max = 0;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--max') {
      const raw = argv[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new CheckVisualArgError('--max 需要非负整数');
      }
      max = Number(raw);
      i += 1;
      continue;
    }
    if (arg === '--root') {
      const raw = argv[i + 1];
      if (raw === undefined || raw === '') throw new CheckVisualArgError('--root 需要目录');
      root = raw;
      i += 1;
      continue;
    }
    throw new CheckVisualArgError(`未知参数：${String(arg)}`);
  }
  return { root: path.resolve(cwd, root), max, json };
}

export function runTool(
  argv: readonly string[] = process.argv.slice(2),
  write: (line: string) => void = (line) => {
    console.log(line);
  },
): number {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CheckVisualArgError) {
      write(`[check-visual] ${err.message}`);
      write(USAGE);
      return 2;
    }
    throw err;
  }

  let result: CheckVisualResult;
  try {
    result = checkVisual({ root: options.root });
  } catch (err) {
    write(`[check-visual] 扫描失败：${(err as Error).message}`);
    return 2;
  }

  if (options.json) {
    write(JSON.stringify(result, null, 2));
  } else {
    for (const v of result.violations) write(formatViolation(v));
    write(
      `[check-visual] ${String(result.count)} violations / ${String(result.files_scanned)} files（--max ${String(options.max)}）`,
    );
  }
  return result.count > options.max ? 1 : 0;
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  process.exitCode = runTool();
}
