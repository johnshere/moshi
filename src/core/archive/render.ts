/**
 * 归档主题渲染（详设 §9.3 / 附录 A；台账 P1-15）。
 *
 * 分节 → 数据来源（上限）：
 *   一句话结论 1 / 关键事实 15（finalScore 排序，带置信与起始日期）/
 *   依赖链 10（depends_on A→B→C 文本化）/ 冲突与裁决 10（mutually_exclusive 边
 *   + 对应 adjudication）/ 时间线 20（valid_at 排序变更）/ 已失效 20 /
 *   未解决·待验证 10（disputed、低置信 <0.55、subject 实体 unknown、
 *   depends_on 前置 invalidated → 后置）/ 本次更新（diff vs 上次导出窗口）/
 *   溯源索引 20（episode_id + span，不含原文）。
 *
 * content_hash 只对正文算（不含 frontmatter 的 derived_at/revision/content_hash），
 * 否则每次导出 hash 都变，"内容未变则不写盘"失效（§9.3 坑）。
 */
import type { Db } from '../../infra/sqlite/db.js';
import type { Fact } from '../../domain/types.js';
import { sha256Hex } from '../../domain/hash.js';
import { getEntity } from '../../infra/sqlite/entityRepo.js';
import { findMutexWin } from '../../infra/sqlite/adjudicationRepo.js';
import { listDependencyPairs, listFactsByCommunity, listMutexPairs } from '../../infra/sqlite/communityRepo.js';

export interface ArchiveDoc {
  topicId: number;
  /** 归档文件名（slug）；由 archiveTopic 依 archive_meta 现有 slug 或 slugFor 赋，渲染阶段不决定 */
  slug: string;
  title: string;
  revision: number;
  derivedAt: string;
  factCount: number;
  edgeCount: number;
  confidenceAvg: number;
  strengthAvg: number;
  validRange: [string, string] | null;
  /** 渲染正文（不含 frontmatter） */
  body: string;
  contentHash: string;
}

export interface RenderOptions {
  now?: string;
  revision?: number;
  /** 上次导出时间（本次更新 diff 窗口起点）；缺省 = 首次导出（新增=全量） */
  lastExportedAt?: string | null;
  /** 主题标题（缺省用「主题 N」） */
  title?: string;
}

/** 渲染产物（尚未定 slug） */
export type RenderedTopic = Omit<ArchiveDoc, 'slug'>;

export function renderTopic(db: Db, topicId: number, opts: RenderOptions = {}): RenderedTopic {
  const now = opts.now ?? new Date().toISOString();
  const revision = opts.revision ?? 1;

  const list = listFactsByCommunity(db, topicId);

  let summary: Fact | null = null;
  let bestScore = -1;
  for (const f of list) {
    const s = f.confidence * f.importance;
    if (s > bestScore) {
      bestScore = s;
      summary = f;
    }
  }

  // 关键事实：归档不跑融合，base=0 → finalScore = 0.30×conf + 0.15×strength（§6.7）
  const keyFacts = [...list]
    .filter((f) => f.epistemicStatus !== 'invalidated' && f.epistemicStatus !== 'pruned')
    .sort((a, b) => (0.3 * b.confidence + 0.15 * b.strength) - (0.3 * a.confidence + 0.15 * a.strength))
    .slice(0, 15);

  const depEdges = listDependencyPairs(db, topicId, 10);
  const contentOf = new Map(list.map((f) => [f.id, f.content]));
  const depLines = depEdges.map((e) => {
    const chain = [e.src, e.dst].map((id) => contentOf.get(id) ?? id).join(' → ');
    return `- ${chain}`;
  });

  // 冲突与裁决：mutually_exclusive 活跃边 + adjudication（kind='mutex_win'）
  const mutexEdges = listMutexPairs(db, topicId, 10);
  const conflictLines: string[] = [];
  for (const e of mutexEdges) {
    const adj = findMutexWin(db, [e.src, e.dst]);
    conflictLines.push(
      adj === null
        ? `- ${contentOf.get(e.src) ?? e.src} 与 ${contentOf.get(e.dst) ?? e.dst} 互斥（未裁决）`
        : `- ${contentOf.get(e.src) ?? e.src} 与 ${contentOf.get(e.dst) ?? e.dst} 互斥，裁决为 ${contentOf.get(adj.decidedBy) ?? adj.decidedBy}（${adj.decidedAt.slice(0, 10)}）`,
    );
  }

  // 时间线：valid_at 排序的变更（新增/失效），20 条
  const timeline: string[] = [];
  for (const f of [...list].sort((a, b) => (a.validAt < b.validAt ? -1 : 1)).slice(0, 20)) {
    const verb = f.epistemicStatus === 'invalidated' || f.epistemicStatus === 'pruned' ? '标记失效' : '新增';
    timeline.push(`| ${f.validAt.slice(0, 10)} | ${verb} ${f.content} |`);
  }

  const expired = list.filter((f) => f.validTo !== null).slice(0, 20);
  const expiredLines = expired.map((f) => `- ${f.content}（${f.validTo!.slice(0, 10)} 失效）`);

  // 未解决/待验证：disputed、低置信、subject unknown、depends_on 前置失效 → 后置
  const unresolvedLines: string[] = [];
  for (const f of list) {
    if (f.epistemicStatus === 'disputed') {
      unresolvedLines.push(`- ${f.content}（互斥败者，存疑，置信 ${f.confidence}）`);
      continue;
    }
    if (f.confidence < 0.55) {
      unresolvedLines.push(`- ${f.content}（未观测到直接证据，置信 ${f.confidence}）`);
    }
  }
  const unknownSubject = list.filter((f) => getEntity(db, f.attrs.frozen.subject.entity_id)?.etype === 'unknown');
  for (const f of unknownSubject) unresolvedLines.push(`- ${f.content}（主体身份未解析）`);
  const staleDependents = new Set<string>();
  for (const e of depEdges) {
    const src = list.find((f) => f.id === e.src);
    if (src !== undefined && (src.epistemicStatus === 'invalidated' || src.epistemicStatus === 'pruned')) {
      staleDependents.add(e.dst);
    }
  }
  for (const id of staleDependents) {
    unresolvedLines.push(`- ${contentOf.get(id) ?? id}（依赖已失效，待验证）`);
  }
  const unresolved = [...new Set(unresolvedLines)].slice(0, 10);

  // 本次更新：自 lastExportedAt 新增/失效
  const win = opts.lastExportedAt ?? null;
  const newly = win === null ? list.length : list.filter((f) => f.createdAt > win).length;
  const newlyInvalid = win === null ? 0 : list.filter((f) => (f.validTo !== null || f.epistemicStatus === 'invalidated') && f.updatedAt > win).length;
  const updateLine = `- 新增 ${newly} 条、失效 ${newlyInvalid} 条、置信变化 0 条（diff 窗口：${win ?? '首次导出'})`;

  // 溯源索引：episode_id + span，不含原文
  const traces = [...list]
    .filter((f) => f.sourceEpisode !== null && f.span !== null)
    .slice(0, 20)
    .map((f) => `- episode ${f.sourceEpisode}, span [${f.span![0]},${f.span![1]}]`);
  const traceLines = traces.length === 0 ? ['-（无溯源记录）'] : traces;

  const confAvg = list.length === 0 ? 0 : list.reduce((a, f) => a + f.confidence, 0) / list.length;
  const strAvg = list.length === 0 ? 0 : list.reduce((a, f) => a + f.strength, 0) / list.length;
  const dates = list.filter((f) => f.validAt !== '').map((f) => f.validAt.slice(0, 10));
  const validRange: [string, string] | null = dates.length === 0 ? null : [dates[0]!, dates[dates.length - 1]!];

  const body = [
    `# ${opts.title ?? `主题 ${topicId}`}`,
    '',
    '## 一句话结论',
    '',
    summary === null ? '（暂无）' : summary.content,
    '',
    '## 关键事实',
    '',
    ...keyFacts.map((f) => `- ${f.content}。（置信 ${f.confidence}，${f.validAt.slice(0, 10)} 起）`),
    '',
    '## 依赖链',
    '',
    ...(depLines.length === 0 ? ['-（无）'] : depLines),
    '',
    '## 冲突与裁决',
    '',
    ...(conflictLines.length === 0 ? ['-（无）'] : conflictLines),
    '',
    '## 时间线',
    '',
    '| 时间 | 变化 |',
    '| --- | --- |',
    ...timeline,
    '',
    '## 已失效',
    '',
    ...(expiredLines.length === 0 ? ['-（无）'] : expiredLines),
    '',
    '## 未解决 / 待验证',
    '',
    ...(unresolved.length === 0 ? ['-（无）'] : unresolved),
    '',
    '## 溯源索引',
    '',
    ...traceLines,
  ].join('\n');

  // 「本次更新」是 diff 派生段：它随 lastExportedAt 变，进 hash 会让"内容没变 hash 却变"
  // 失效（§9.3 坑）。故 content_hash 只对稳定正文算，diff 段单独附在末尾。
  const bodyWithUpdate = `${body}\n\n## 本次更新\n\n${updateLine}`;

  return {
    topicId,
    title: opts.title ?? `主题 ${topicId}`,
    revision,
    derivedAt: now,
    factCount: list.length,
    edgeCount: depEdges.length + mutexEdges.length,
    confidenceAvg: confAvg,
    strengthAvg: strAvg,
    validRange,
    body: bodyWithUpdate,
    contentHash: sha256Hex(body),
  };
}
