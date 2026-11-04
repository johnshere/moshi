/**
 * 社区摘要的确定性拼接（P2-12；详设 §8.3.3、概设 §4.5）。
 *
 * 纯函数层：不持 db 句柄、不拼 SQL（lint:lifecycle 对 core/app 的硬约束；
 * 数据装载与写库在 `infra/sqlite/communityRepo.ts`）。
 *
 * 摘要的定位是**入口不是答案**（概设 §4.5）：它只供全局路径的 topic 清单展示，
 * 不进子图、不进 GAT 特征、不参与局部路径的证据排序。摘要内容全部来自事实文本的
 * 确定性拼接——同样的库内容跑多少次都得到同一字符串，没有模型、没有随机性。
 *
 * 确定性三条：
 *   1. 分组按 (community_id, scope) 升序输出，与输入数组顺序无关；
 *   2. 组内事实按 `importance × confidence` 降序、平局按 fact id 升序（§8.3.3 第 2 步）；
 *   3. label 取社区内最高频实体，平局按名称、再按实体键升序。
 *
 * `source_rev` 不在本层计算：002_schema_rev.sql 对 `community_summary` 的每次
 * INSERT/UPDATE 都推高一次 `meta.schema_rev`，最终 rev 只有写库方知道
 * （见 `communityRepo.writeCommunitySummaries` 的注释）。
 */

/** 参与摘要拼接的事实（`communityRepo.loadSummaryFacts` 的返回形状） */
export interface SummaryFact {
  id: string;
  /** 当前社区归属；null = 尚未归属（dryRun 时调用方用本轮划分结果覆盖） */
  communityId: number | null;
  scope: string;
  content: string;
  importance: number;
  confidence: number;
  /** `attrs.frozen.subject.entity_id`（json_extract）；无主体为 null */
  entityId: string | null;
  /** `entity.canonical_name`，缺失时回退 `attrs.frozen.subject.name`；都没有为 null */
  entityName: string | null;
}

/** 一条待写入 `community_summary` 的摘要（source_rev 由写库方填） */
export interface CommunitySummaryDraft {
  communityId: number;
  scope: string;
  label: string;
  summary: string;
  factCount: number;
}

export interface BuildSummaryOptions {
  /** 生成哪些 scope 的摘要；默认只生成 `global`（详设 §8.3.3 的默认口径） */
  scopes?: readonly string[];
  /** 每组取多少条事实参与「要点」挑选（默认 10，§8.3.3 第 2 步） */
  topFacts?: number;
  /** 要点条数（默认 3，§8.3.3 的 ①②③） */
  bullets?: number;
  /** 单条要点的最大字符数（content 可能很长，截断后加 …，默认 80） */
  maxContentChars?: number;
}

/** 默认 scope：社区摘要目前只服务全局路径 */
export const SUMMARY_DEFAULT_SCOPE = 'global';
/** top-10 事实（§8.3.3 第 2 步） */
export const SUMMARY_TOP_FACTS = 10;
/** 要点 3 条（§8.3.3 的 ①②③） */
export const SUMMARY_BULLETS = 3;
/** 单条要点截断阈值（content 是自然语言，太长会挤爆入口；80 字覆盖常见一句话） */
export const SUMMARY_CONTENT_MAX = 80;

const CIRCLED = ['①', '②', '③', '④', '⑤'];

/** 无实体可标注时的回退 label（§8.3.3 第 3 步） */
export function fallbackSummaryLabel(communityId: number): string {
  return `主题 #${String(communityId)}`;
}

function utilityOf(fact: SummaryFact): number {
  return fact.importance * fact.confidence;
}

/**
 * 组内事实排序：utility 降序、平局 fact id 升序（§8.3.3「按 importance × confidence」）。
 * 返回新数组，不改入参。
 */
export function rankSummaryFacts(facts: readonly SummaryFact[]): SummaryFact[] {
  return [...facts].sort((a, b) => {
    const ua = utilityOf(a);
    const ub = utilityOf(b);
    if (ua !== ub) return ub - ua;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 实体身份键：优先 entity_id；没有 id 时用主体名（同名视为同一实体） */
function entityKeyOf(fact: SummaryFact): string | null {
  const entityId = fact.entityId?.trim() ?? '';
  if (entityId !== '') return `id:${entityId}`;
  const name = fact.entityName?.trim() ?? '';
  if (name !== '') return `name:${name}`;
  return null;
}

/** 覆盖的实体数 m（无主体的事实不计入） */
function countEntities(facts: readonly SummaryFact[]): number {
  const keys = new Set<string>();
  for (const fact of facts) {
    const key = entityKeyOf(fact);
    if (key !== null) keys.add(key);
  }
  return keys.size;
}

/**
 * label 候选：社区内最高频实体。
 * 只统计**有 canonical_name 可展示**的事实；频率相同按名称、实体键升序，保证确定性。
 */
function pickLabel(facts: readonly SummaryFact[], communityId: number): string {
  const freq = new Map<string, { name: string; count: number }>();
  for (const fact of facts) {
    const key = entityKeyOf(fact);
    if (key === null) continue;
    const name = fact.entityName?.trim() ?? '';
    if (name === '') continue;
    const cur = freq.get(key);
    if (cur === undefined) freq.set(key, { name, count: 1 });
    else cur.count += 1;
  }
  const ranked = [...freq.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  return ranked[0]?.name ?? fallbackSummaryLabel(communityId);
}

/** content 规整：折叠空白 + 按 code point 截断（避免把代理对切坏） */
function normalizeContent(raw: string, maxChars: number): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const codePoints = [...text];
  if (codePoints.length <= maxChars) return text;
  return `${codePoints.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

function groupKeyOf(fact: SummaryFact): string {
  return `${String(fact.communityId)}\u0000${fact.scope}`;
}

/**
 * 生成社区摘要草稿（§8.3.3 第 2-3 步）。
 *
 * `n` = 该社区该 scope 下的**全部** active/disputed 事实数（与 `fact_count` 列一致），
 * `m` = 覆盖的去重实体数；「要点」只取 top-10 里的前 3 条 content。
 */
export function buildCommunitySummaries(
  facts: readonly SummaryFact[],
  options: BuildSummaryOptions = {},
): CommunitySummaryDraft[] {
  const wantedScopes = new Set(options.scopes ?? [SUMMARY_DEFAULT_SCOPE]);
  const topFacts = Math.max(1, options.topFacts ?? SUMMARY_TOP_FACTS);
  const bullets = Math.max(1, options.bullets ?? SUMMARY_BULLETS);
  const maxContentChars = Math.max(1, options.maxContentChars ?? SUMMARY_CONTENT_MAX);

  const groups = new Map<string, { communityId: number; scope: string; facts: SummaryFact[] }>();
  for (const fact of facts) {
    if (fact.communityId === null) continue;
    if (!wantedScopes.has(fact.scope)) continue;
    const key = groupKeyOf(fact);
    let group = groups.get(key);
    if (group === undefined) {
      group = { communityId: fact.communityId, scope: fact.scope, facts: [] };
      groups.set(key, group);
    }
    group.facts.push(fact);
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      a.communityId - b.communityId ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0),
  );

  return ordered.map((group) => {
    const ranked = rankSummaryFacts(group.facts);
    const label = pickLabel(group.facts, group.communityId);
    const n = group.facts.length;
    const m = countEntities(group.facts);
    const points = ranked
      .slice(0, Math.min(topFacts, bullets))
      .map((fact, i) => `${CIRCLED[i] ?? `(${String(i + 1)})`}${normalizeContent(fact.content, maxContentChars)}`)
      .join(' ');
    return {
      communityId: group.communityId,
      scope: group.scope,
      label,
      summary: `${label}：${String(n)} 条事实，覆盖 ${String(m)} 个实体。要点：${points}`,
      factCount: n,
    };
  });
}
