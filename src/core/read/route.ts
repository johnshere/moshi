/**
 * 意图分流（详设 §6.2）。
 *
 * 规则优先，命中不了默认 `local`（预算 3ms，纯规则无超时）。
 *
 * 判定表：
 * | 条件 | 结果 |
 * | --- | --- |
 * | 全局词 且 未识别到实体 | global |
 * | 识别到 ≥1 实体 | local |
 * | 含具体标识符（端口/路径/包名/错误码） | local |
 * | 默认 | local |
 *
 * "且未识别到实体"是关键："8080 有哪些风险"含全局词但也含实体 → local——
 * 实体存在时局部路径召回质量更高，全局摘要反而丢细节。
 */
import type { Db } from '../../infra/sqlite/db.js';
import type { Route } from '../../domain/enums.js';
import { recognizeEntities } from './recognize.js';

const GLOBAL_WORDS = [
  '有哪些', '哪些', '整体', '概况', '总结', '概览', '风险', '全貌',
  'overview', 'summarize', 'summary', 'all', 'risks', 'landscape',
] as const;

const LOCAL_HINTS = /(:\d{2,5}\b|\/[\w.-]+\/|\b[A-Z]{2,}_[A-Z_]+\b|\bE[A-Z]{3,}\b)/;

/**
 * 全局词命中判定（P1-27）。
 *
 * 旧实现是 `query.includes(word)`：`all` 会被 install / small / recall 命中，
 * 于是"install pnpm"这种纯局部问题被判成 global，而全局路径的 evidence 恒为空
 * ——用户拿到的是"库里没有"，不是"你问的是全局"。
 *
 * ASCII 词用词边界（前后不能是字母数字）；CJK 词没有单词边界，仍按子串匹配
 * （`\b` 对中文无效，这是 P1-27 的坑）。
 */
function matchesGlobalWord(query: string, word: string): boolean {
  if (!/^[a-z0-9]+$/i.test(word)) return query.includes(word);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(query);
}

export function routeIntent(db: Db, query: string): { route: Route; globalWord: boolean; hasEntity: boolean } {
  const hasGlobalWord = GLOBAL_WORDS.some((w) => matchesGlobalWord(query, w));
  const ents = recognizeEntities(db, query, { limit: 8 });
  const hasHint = LOCAL_HINTS.test(query);

  // 全局 = 全局词 且 未识别实体 且 无具体标识符；具体标识符本身也是局部证据，
  // 否则"哪些"一出现就会把 /src/infra/ 这类带路径的查询误判成 global。
  if (hasGlobalWord && ents.length === 0 && !hasHint) return { route: 'global', globalWord: true, hasEntity: false };
  if (ents.length >= 1 || hasHint) return { route: 'local', globalWord: hasGlobalWord, hasEntity: ents.length > 0 };
  return { route: 'local', globalWord: hasGlobalWord, hasEntity: false };
}
