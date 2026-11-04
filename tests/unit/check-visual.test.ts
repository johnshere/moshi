/**
 * `tools/check-visual.ts` 契约测试（P2-19-B 视觉验收工具）。
 *
 * 用临时目录写样本文件，不依赖真实 `src/ui` 现状（迁移期真实 ui 必然有违规）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkVisual,
  formatViolation,
  parseCliArgs,
  runTool,
  VISUAL_SCHEMA,
} from '../../tools/check-visual.js';

const dirs: string[] = [];

function tmpUi(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'moshi-check-visual-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('checkVisual：颜色字面量识别', () => {
  it('命中 #rgb / #rrggbb / #rrggbbaa 三种写法', () => {
    const root = tmpUi({
      'a.ts': ["const a = '#fff';", "const b = '#AABBCC';", "const c = '#11223344';"].join('\n'),
    });
    const result = checkVisual({ root });
    expect(result.schema).toBe(VISUAL_SCHEMA);
    expect(result.files_scanned).toBe(1);
    expect(result.count).toBe(3);
    expect(result.violations.map((v) => v.match)).toEqual(['#fff', '#AABBCC', '#11223344']);
    expect(result.violations.map((v) => v.line)).toEqual([1, 2, 3]);
  });

  it('命中 rgba( 与 hsla( 函数字面量', () => {
    const root = tmpUi({
      'a.tsx': ["const a = 'rgba(1,2,3,.5)';", "const b = 'hsla(220, 80%, 60%, .9)';"].join('\n'),
    });
    const result = checkVisual({ root });
    expect(result.count).toBe(2);
    expect(result.violations.map((v) => v.match)).toEqual(['rgba(', 'hsla(']);
  });
});

describe('checkVisual：豁免规则', () => {
  it('行尾 // check-visual-ignore 整行豁免', () => {
    const root = tmpUi({
      'a.ts': ["const a = '#fff'; // check-visual-ignore", "const b = '#000';"].join('\n'),
    });
    const result = checkVisual({ root });
    expect(result.count).toBe(1);
    expect(result.violations[0]?.line).toBe(2);
  });

  it('var() 回退色与 href="#..." 锚点、transparent/currentColor 不报', () => {
    const root = tmpUi({
      'a.tsx': [
        "const css = 'color: var(--bg, #fff)';",
        'const link = <a href="#fff">x</a>;',
        "const ok = ['transparent', 'currentColor', 'inherit'];",
      ].join('\n'),
    });
    expect(checkVisual({ root }).count).toBe(0);
  });

  it('src/ui/styles/** 是 token 定义处，免检且不计入 files_scanned', () => {
    const root = tmpUi({
      'styles/tokens.css': ':root { --bg: #0b1020; color: rgba(1,2,3,.4); }',
      'main.tsx': "const c = 'rgba(0,0,0,.5)';",
    });
    const result = checkVisual({ root });
    expect(result.files_scanned).toBe(1);
    expect(result.count).toBe(1);
    expect(result.violations[0]?.file).toBe('main.tsx');
  });

  it('非 ts/tsx/css 扩展名不扫描', () => {
    const root = tmpUi({ 'a.js': "const c = '#fff';", 'a.txt': '#fff' });
    const result = checkVisual({ root });
    expect(result.files_scanned).toBe(0);
    expect(result.count).toBe(0);
  });
});

describe('runTool：退出码与输出', () => {
  it('干净目录 exit 0，且输出包含 0 violations', () => {
    const root = tmpUi({ 'a.ts': 'export const x = 1;' });
    const lines: string[] = [];
    expect(runTool(['--root', root], (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toContain('0 violations');
  });

  it('有违规 exit 1；--max 容忍（含边界）', () => {
    const root = tmpUi({ 'a.ts': "const a = '#fff';\nconst b = '#000';\n" });
    expect(runTool(['--root', root], () => {})).toBe(1);
    expect(runTool(['--root', root, '--max', '1'], () => {})).toBe(1);
    expect(runTool(['--root', root, '--max', '2'], () => {})).toBe(0);
  });

  it('--json 输出 moshi-check-visual/1 报告形状', () => {
    const root = tmpUi({ 'a.ts': "const a = '#fff';" });
    const lines: string[] = [];
    const code = runTool(['--root', root, '--json'], (line) => lines.push(line));
    expect(code).toBe(1);
    const report = JSON.parse(lines.at(-1) as string) as {
      schema: string;
      files_scanned: number;
      violations: { file: string; line: number; match: string }[];
      count: number;
    };
    expect(report.schema).toBe('moshi-check-visual/1');
    expect(report.files_scanned).toBe(1);
    expect(report.count).toBe(1);
    expect(report.violations[0]).toEqual({ file: 'a.ts', line: 1, match: '#fff' });
  });

  it('非法参数 exit 2（未知参数 / --max 非整数 / --root 缺值）', () => {
    const out: string[] = [];
    expect(runTool(['--bogus'], (line) => out.push(line))).toBe(2);
    expect(runTool(['--max', 'x'], () => {})).toBe(2);
    expect(runTool(['--root'], () => {})).toBe(2);
    expect(() => parseCliArgs(['--max', '-1'])).toThrowError();
  });

  it('扫描根不存在 exit 2', () => {
    expect(runTool(['--root', path.join(tmpdir(), 'moshi-missing-root-xyz')], () => {})).toBe(2);
  });

  it('formatViolation 输出 文件:行: 匹配串', () => {
    expect(formatViolation({ file: 'src/ui/a.ts', line: 7, match: '#fff' })).toBe(
      'src/ui/a.ts:7: #fff',
    );
  });
});
