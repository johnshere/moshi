/**
 * 解析器注册表（详设 §5.3）。
 *
 * 三条纪律：
 *
 * 1. **未命中任何 parser 的 turn 只落 `episode.summary`，不入图**（概设 §3.2：
 *    宁可少一条，不要多一条垃圾）。所以 `parse()` 返回 `unparsed` 而不是抛错——
 *    "没解析出东西"是正常结果，不是失败。
 * 2. **工具名大小写不敏感**：不同适配器给的 `Bash` / `bash` / `shell` 指的是同一件事。
 * 3. **同一 turn 内去重**：多个 parser 可能对同一主体抽出同一取值（如 `lsof` 同时
 *    命中两条 LISTEN 行），重复的 `(subject, predicate, value)` 只留第一条，
 *    否则 `upsert` 会把它当成"重复观测"把置信度抬上去——那是假的独立观测。
 */
import { canonicalJson } from '../../domain/hash.js';
import { BUILD_PARSERS } from './parsers/build.js';
import { FS_PARSERS } from './parsers/fs.js';
import { GIT_PARSERS } from './parsers/git.js';
import { PKG_PARSERS } from './parsers/pkg.js';
import { PROC_PARSERS } from './parsers/proc.js';
import type { ExtractedFact, Parser, RawTurn } from './types.js';

export const BUILTIN_PARSERS: readonly Parser[] = [
  ...PKG_PARSERS,
  ...GIT_PARSERS,
  ...PROC_PARSERS,
  ...FS_PARSERS,
  ...BUILD_PARSERS,
];

export interface ParseResult {
  /** 抽出的事实（已去重） */
  facts: ExtractedFact[];
  /** `match()` 通过的 parser id，按注册顺序 */
  matched: string[];
  /** 真正产出事实的 parser id */
  produced: string[];
  /** 一条都没抽出来——调用方据此决定"只落 episode，不入图" */
  unparsed: boolean;
}

function toolAllowed(parser: Parser, tool: string): boolean {
  if (parser.tools.length === 0) return true;
  const t = tool.toLowerCase();
  return parser.tools.some((x) => x.toLowerCase() === t);
}

function dedupeKey(fact: ExtractedFact): string {
  let v: string;
  try {
    v = canonicalJson(fact.value);
  } catch {
    // 不可序列化的取值留给 quarantine 判，这里只需要一个稳定的分组键
    v = String(fact.value);
  }
  return `${fact.subject.type}\u001f${fact.subject.name}\u001f${fact.predicate}\u001f${v}`;
}

export class ParserRegistry {
  private readonly parsers: readonly Parser[];

  constructor(parsers: readonly Parser[] = BUILTIN_PARSERS) {
    this.parsers = parsers;
  }

  ids(): string[] {
    return this.parsers.map((p) => p.id);
  }

  parse(turn: RawTurn): ParseResult {
    const facts: ExtractedFact[] = [];
    const matched: string[] = [];
    const produced: string[] = [];
    const seen = new Set<string>();

    for (const parser of this.parsers) {
      if (!toolAllowed(parser, turn.tool)) continue;
      let hit: boolean;
      try {
        hit = parser.match(turn);
      } catch {
        // 单个 parser 的正则炸了不能拖垮整批 harvest
        continue;
      }
      if (!hit) continue;
      matched.push(parser.id);
      let extracted: ExtractedFact[];
      try {
        extracted = parser.extract(turn);
      } catch {
        continue;
      }
      if (extracted.length === 0) continue;
      produced.push(parser.id);
      for (const f of extracted) {
        const key = dedupeKey(f);
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ ...f, ext: { ...f.ext, parser: parser.id } });
      }
    }

    return { facts, matched, produced, unparsed: facts.length === 0 };
  }
}

/** 默认注册表（内置全部 parser） */
export const defaultRegistry = new ParserRegistry();

export function parseTurn(turn: RawTurn): ParseResult {
  return defaultRegistry.parse(turn);
}
