/**
 * 归档页纯函数（P2-19A-05b）：slug 深链、徽标判定、空态、预览行切分、重建按钮态。
 *
 * 全部无 DOM / 无 fetch，方便单测钉死行为；组件只负责取数与渲染。
 */

export type ArchiveStatus = 'active' | 'merged' | 'split';
export type HumanEdited = 0 | 1 | 2;

export interface ArchiveTopicSummary {
  topic_id: number | string;
  slug: string;
  title: string | null;
  path: string;
  revision: number;
  content_hash: string | null;
  last_exported_at: string | null;
  human_edited: HumanEdited;
  status: ArchiveStatus;
  proposed_path: string | null;
}

export interface ArchiveTopicDetail {
  slug: string;
  topic_id: number | string;
  title: string | null;
  revision: number;
  status: ArchiveStatus;
  content_hash: string | null;
  path: string;
  derived_at: string | null;
  markdown: string | null;
  missing?: boolean;
}

export type DetailState = 'idle' | 'loading' | 'ok' | 'file_missing' | 'not_found' | 'error';

export interface ProposedBadge {
  visible: boolean;
  label: string;
  /** 是否有可处理的 `.proposed.md`（human_edited=1 才有；2 = 永久人工，无提案） */
  canHandle: boolean;
}

const BADGE_NONE: ProposedBadge = { visible: false, label: '', canHandle: false };

/** URL 唯一真相源：`?slug=` 为空/空白一律视为没有深链。 */
export function slugFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('slug');
  if (raw === null) return null;
  const slug = raw.trim();
  return slug === '' ? null : slug;
}

/**
 * 写回 `?slug=`：保留 token 等其它参数，`null` 时删参数（回列表态）。
 * 用 replaceState 调用（不新增历史条目）。
 */
export function archiveHref(pathname: string, search: string, slug: string | null): string {
  const params = new URLSearchParams(search);
  if (slug === null || slug === '') params.delete('slug');
  else params.set('slug', slug);
  const qs = params.toString();
  return qs === '' ? pathname : `${pathname}?${qs}`;
}

/**
 * 初始选中：URL 里的 slug 优先（即使不在列表里，也让详情请求暴露 404）；
 * 否则选第一项；空列表 → null。
 */
export function initialSelectedSlug(
  topics: readonly Pick<ArchiveTopicSummary, 'slug'>[],
  search: string,
): string | null {
  const fromUrl = slugFromSearch(search);
  if (fromUrl !== null) return fromUrl;
  return topics[0]?.slug ?? null;
}

/** 三态徽标：0 自动（无徽标）、1 待合并（可处理）、2 永久人工（无提案，不弹对话框）。 */
export function proposedBadge(topic: Pick<ArchiveTopicSummary, 'human_edited'>): ProposedBadge {
  if (topic.human_edited === 1) return { visible: true, label: '待合并', canHandle: true };
  if (topic.human_edited === 2) return { visible: true, label: '永久人工', canHandle: false };
  return BADGE_NONE;
}

export type EmptyState = 'loading' | 'error' | 'empty' | 'list';

export function emptyStateFor(input: { loading: boolean; error: string | null; topicCount: number }): EmptyState {
  if (input.loading) return 'loading';
  if (input.error !== null) return 'error';
  if (input.topicCount === 0) return 'empty';
  return 'list';
}

export const EMPTY_TOPICS_HINT = '暂无主题（社区事实数 ≥8 且依赖完整度达标后才会归档）';
export const EMPTY_ARCHIVE_DIR_HINT = '尚未配置归档目录';

/** 列表里最大的 last_exported_at（ISO 字符串可直接比较）；无则 null = 从未导出。 */
export function lastExportedAt(
  topics: readonly Pick<ArchiveTopicSummary, 'last_exported_at'>[],
): string | null {
  let max: string | null = null;
  for (const t of topics) {
    if (t.last_exported_at === null) continue;
    if (max === null || t.last_exported_at > max) max = t.last_exported_at;
  }
  return max;
}

export function shortHash(hash: string | null, length = 8): string {
  if (hash === null || hash === '') return '—';
  return hash.slice(0, length);
}

export type PreviewLineKind = 'h1' | 'h2' | 'h3' | 'bullet' | 'text' | 'blank';

export interface PreviewLine {
  kind: PreviewLineKind;
  text: string;
}

/** 去掉文件开头的 `---` frontmatter（归档正文带 frontmatter，预览不重复展示）。 */
export function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return normalized;
  return normalized.slice(end + 5);
}

/**
 * 不引入 markdown 库的按行渲染模型：`#` 标题、`- ` 列表、空行；其余纯文本。
 * 只剥一层行首标记，避免把正文里的 `#`（如 C#）误当标题。
 */
export function previewLines(markdown: string): PreviewLine[] {
  const body = stripFrontmatter(markdown);
  return body.split('\n').map((raw): PreviewLine => {
    const line = raw.replace(/\s+$/, '');
    if (line === '') return { kind: 'blank', text: '' };
    if (line.startsWith('### ')) return { kind: 'h3', text: line.slice(4) };
    if (line.startsWith('## ')) return { kind: 'h2', text: line.slice(3) };
    if (line.startsWith('# ')) return { kind: 'h1', text: line.slice(2) };
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) return { kind: 'bullet', text: bullet[1] ?? '' };
    return { kind: 'text', text: line };
  });
}

/** 详情响应 → 预览态；200 但 markdown 为 null / missing=true 视为文件缺失。 */
export function detailStateFor(
  detail: Pick<ArchiveTopicDetail, 'markdown' | 'missing'> | null,
): DetailState {
  if (detail === null) return 'idle';
  if (detail.markdown === null || detail.missing === true) return 'file_missing';
  return 'ok';
}

export function rebuildLabel(busy: boolean): string {
  return busy ? '重建中…' : '重建归档';
}

export function rebuildDisabled(busy: boolean, loading: boolean): boolean {
  return busy || loading;
}

export interface ArchiveExportResult {
  exported: number;
  written: number;
  unchanged: number;
  proposed: number;
  dir: string;
  elapsed_ms: number;
}

export function exportToast(result: ArchiveExportResult): string {
  return `重建完成：写入 ${String(result.written)}、未变 ${String(result.unchanged)}、待合并 ${String(
    result.proposed,
  )}（${String(result.elapsed_ms)}ms）`;
}

export type ArchiveProposalAction = 'accept_auto' | 'keep_human' | 'promote_human';

export interface ProposalActionMeta {
  action: ArchiveProposalAction;
  label: string;
  consequence: string;
}

export const PROPOSAL_ACTIONS: readonly ProposalActionMeta[] = [
  {
    action: 'accept_auto',
    label: '用自动版覆盖人工修改',
    consequence: '以 .proposed.md 的自动正文覆盖当前归档，revision +1，此后恢复自动导出。',
  },
  {
    action: 'keep_human',
    label: '保留人工版，此后不再自动导出（永久人工）',
    consequence: '人工版成为基线并标记 human_edited=2；后续导出跳过该主题，也不再生成提案。',
  },
  {
    action: 'promote_human',
    label: '人工版转正为基线，后续自动增量叠加',
    consequence: '把当前人工版记为新基线、清掉待决状态，之后按正常导出流程继续。',
  },
];

export function formatProposalError(input: { error: string; reason?: string | null }): string {
  return input.reason === undefined || input.reason === null || input.reason === ''
    ? input.error
    : `${input.error}（${input.reason}）`;
}

export function formatTimestamp(iso: string | null): string {
  return iso === null || iso === '' ? '从未导出' : iso;
}
