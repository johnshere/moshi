import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { zh } from '../../src/ui/i18n/dict.js';
import { en } from '../../src/ui/i18n/dict.en.js';

/**
 * 门禁：`src/ui` 除 `src/ui/i18n/` 外不得再出现中文字面量（D-184 / V-11）。
 *
 * 用 TypeScript 编译器 API 遍历 AST，只看「字符串字面量 / 模板字面量 / JSX 文本节点」，
 * 注释不是语法节点，天然被排除 —— 中文注释与文件头说明仍然允许。
 *
 * 白名单只放**数据契约**（服务端下发的码值 / 标签前缀），必须写清理由；
 * 白名单文件不存在时同样失败，避免改名后白名单静默失效。
 */

const UI_ROOT = resolve(process.cwd(), 'src/ui');
const CJK_CHAR = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

interface AllowedLiteral {
  /** 相对仓库根的路径，统一用 `/` 分隔。 */
  readonly file: string;
  readonly values: readonly string[];
  readonly why: string;
}

const ALLOWED_LITERALS: readonly AllowedLiteral[] = [
  {
    file: 'src/ui/access/AccessPage.tsx',
    values: ['新增', '修改', '删除'],
    why: 'InstallStep.action 是服务端下发的码值，UI 层不翻译（待后端改码，I-70）',
  },
  {
    file: 'src/ui/graph/pure/encoding.ts',
    values: ['[失效]'],
    why: '节点 label 的服务端标签前缀，属数据契约，只做匹配不做展示替换',
  },
];

interface CjkLiteral {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** 从源码里找出所有含中文的「字符串 / 模板 / JSX 文本」节点。 */
export function findCjkLiterals(file: string, source: string): CjkLiteral[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const hits: CjkLiteral[] = [];

  const record = (node: ts.Node, text: string): void => {
    if (!CJK_CHAR.test(text)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    hits.push({ file, line: line + 1, column: character + 1, text: text.trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
    } else if (ts.isJsxText(node)) {
      record(node, node.text);
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      record(node, (node as ts.TemplateLiteralLikeNode).text);
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return hits;
}

function listUiSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // i18n 目录就是中文的家：dict.ts 是 key 的定义处，必须允许中文。
      if (name === 'i18n') continue;
      listUiSources(path, acc);
      continue;
    }
    if (/\.tsx?$/.test(name)) acc.push(path);
  }
  return acc;
}

const relativeToRepo = (path: string): string => relative(process.cwd(), path).replace(/\\/g, '/');

const allowedValues = (file: string): readonly string[] =>
  ALLOWED_LITERALS.filter((entry) => entry.file === file).flatMap((entry) => entry.values);

describe('UI 国际化门禁', () => {
  it('src/ui 除 i18n/ 外不再含中文字面量', () => {
    const violations = listUiSources(UI_ROOT)
      .flatMap((path) => findCjkLiterals(path, readFileSync(path, 'utf8')))
      .filter((hit) => !allowedValues(relativeToRepo(hit.file)).includes(hit.text))
      .map((hit) => `${relativeToRepo(hit.file)}:${hit.line}:${hit.column} ${hit.text}`);

    expect(violations).toEqual([]);
  });

  it('白名单里登记的文件必须仍然存在', () => {
    const missing = ALLOWED_LITERALS.map((entry) => entry.file).filter(
      (file) => !existsSync(resolve(process.cwd(), file)),
    );
    expect(missing).toEqual([]);
  });

  it('扫描器能识别字符串 / 模板 / JSX 文本，且忽略注释与标识符', () => {
    const source = [
      "// 这是注释，允许",
      '/* 块注释，也允许 */',
      "const a = '中文标签';",
      'const b = `前缀${a}后缀`;',
      'export const View = () => <div title="提示">裸中文</div>;',
    ].join('\n');

    const texts = findCjkLiterals('sample.tsx', source).map((hit) => hit.text);
    expect(texts).toContain('中文标签');
    expect(texts).toContain('提示');
    expect(texts).toContain('裸中文');
    expect(texts).toContain('前缀');
    expect(texts).toContain('后缀');
    expect(texts.some((text) => text.includes('注释'))).toBe(false);
  });

  it('中英词典的占位变量必须一一对应', () => {
    const vars = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
    const mismatched = (Object.keys(zh) as (keyof typeof zh)[])
      .filter((key) => vars(zh[key]).join(',') !== vars(en[key]).join(','))
      .map((key) => `${key}: zh=${JSON.stringify(zh[key])} en=${JSON.stringify(en[key])}`);

    expect(mismatched).toEqual([]);
  });
});
