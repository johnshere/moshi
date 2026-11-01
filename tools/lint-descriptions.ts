/**
 * 工具自述文本的构建期检查（概设 §1.5 / 详设 §4.1）。
 *
 * 为什么值得做成构建期门禁而不是"写的时候注意点"：
 * 工具描述是**唯一**能影响宿主行为的文本面。一旦允许在描述里写"必须先调用本工具"，
 * 整个"外置系统不干扰宿主"的边界就从一个架构约束退化成一个自觉问题——
 * 而自觉问题在半年后一定失守。这里把三条硬规矩变成可执行检查：
 *
 * 1. **禁祈使句**：不写"何时必须调用"，只写"是什么、给什么、要什么"；
 * 2. **单条 ≤ 200 token**：描述越长，宿主越倾向于把它当提示词而不是接口文档；
 * 3. **禁夹带平台槽位**：出现 `CLAUDE.md` / `AGENTS.md` / `system prompt` 即失败——
 *    那是"改内核"的入口，绕过了 `safe_write` 白名单也照样能影响行为。
 *
 * 用法：`pnpm lint:desc`（`pnpm build` 会先跑它）；有违例退出码 1。
 */
import { DESCRIPTIONS, TOOL_NAMES } from '../src/app/mcp/descriptions.js';
import { estimateTokens } from '../src/domain/text.js';

export const MAX_TOKENS = 200;

/**
 * 禁词表：都是"指令性"写法。
 *
 * 注意 `never` / `always` 本身**不在**表里——"content is never rewritten" 是陈述事实，
 * 不是命令宿主。禁词必须精确到句式，否则只能逼着人把话说得含糊。
 */
export const BANNED_PHRASES: readonly string[] = [
  'you must',
  'you should',
  'you need to',
  'you have to',
  'must call',
  'must first',
  'always call',
  'never call',
  'do not call',
  "don't call",
  'make sure to',
  'be sure to',
  'important:',
  'note:',
  '必须先调用',
  '必须调用',
  '务必',
  '禁止',
  '一定要',
  '不要忘记',
  'claude.md',
  'agents.md',
  'system prompt',
];

export interface DescriptionEntry {
  name: string;
  text: string;
}

export interface Violation {
  name: string;
  rule: 'banned-phrase' | 'too-long' | 'empty' | 'missing';
  detail: string;
}

/**
 * 纯函数，便于单测：给定"名字 → 文本"，返回全部违例。
 * `required` 用来断言"四个工具一个都不能少"。
 */
export function lintDescriptions(
  entries: readonly DescriptionEntry[],
  required: readonly string[] = TOOL_NAMES,
): Violation[] {
  const out: Violation[] = [];
  const seen = new Set(entries.map((e) => e.name));

  for (const name of required) {
    if (!seen.has(name)) {
      out.push({ name, rule: 'missing', detail: `缺少工具 ${name} 的描述` });
    }
  }

  for (const entry of entries) {
    const text = entry.text.trim();
    if (text === '') {
      out.push({ name: entry.name, rule: 'empty', detail: '描述为空' });
      continue;
    }
    const lower = text.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      if (lower.includes(phrase)) {
        out.push({ name: entry.name, rule: 'banned-phrase', detail: `出现祈使/夹带句式：${phrase}` });
      }
    }
    const tokens = estimateTokens(text);
    if (tokens > MAX_TOKENS) {
      out.push({
        name: entry.name,
        rule: 'too-long',
        detail: `约 ${String(tokens)} token，超过上限 ${String(MAX_TOKENS)}`,
      });
    }
  }

  return out;
}

function main(): number {
  const entries = TOOL_NAMES.map((name) => ({ name, text: DESCRIPTIONS[name] }));
  const violations = lintDescriptions(entries);

  if (violations.length > 0) {
    process.stderr.write(`\n✖ 工具描述检查未通过（${String(violations.length)} 处）\n\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.name}  [${v.rule}]  ${v.detail}\n`);
    }
    process.stderr.write('\n  工具自述只写功能与入参，不写"何时必须调用"（概设 §1.5）\n\n');
    return 1;
  }

  const tokens = entries.map((e) => `${e.name}=${String(estimateTokens(e.text))}`);
  process.stdout.write(
    `✔ 工具描述检查通过（${String(entries.length)} 个工具，token：${tokens.join(' ')}）\n`,
  );
  return 0;
}

process.exitCode = main();
