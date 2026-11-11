/**
 * 注入文本渲染（Z-01C / 设计 §3.5、§4）。
 *
 * 纯函数，不碰 IO：给定证据和预算，产出给模型看的 Markdown。三条硬约束：
 *
 * 1. **不含 `fact_id`**——与 MCP `numbered_list` 同口径（详设 §4.4 字段纪律）。
 *    宿主能看到的只有 `[M#]`，反馈走 `m_id` 回填。
 * 2. **每条 ≤ `MAX_ITEM_CODEPOINTS` 码点（含省略号）**：按**码点**切，不按 UTF-16 单元切——
 *    后者会把 emoji / 代理对劈成半个字符，模型读到乱码比读不到更糟。
 * 3. **超预算就整条放弃**，不注半截（设计 §4.1 失败姿态）。宁可这一轮一条都不注，
 *    也不要让模型拿到一个"看起来完整其实被截断"的记忆块。
 *
 * 没有证据时 `inject=false`、`text=''`，**一个字都不注**：空标题会让模型以为
 * "记忆系统在工作，只是没有相关内容"，这是谎报。
 */
import type { EvidenceEntry } from '../read/evidence.js';
import { HOOK_MAIL_END, HOOK_MAIL_START, type HookEvidence, type HookInjectMode } from './protocol.js';

/** 每条证据的码点上限 */
export const MAX_ITEM_CODEPOINTS = 200;
/** 默认注入上限（字节）；对应 `hook.max_inject_bytes` */
export const DEFAULT_MAX_INJECT_BYTES = 4000;
/** 少于这么多条时补一句反馈提示（多了会把上下文挤满） */
export const MAX_ITEMS = 20;

/** UTF-8 字节数（不信任 `Buffer` 的类型声明，Bun/浏览器侧同样可用） */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) n += 1;
    else if (cp < 0x800) n += 2;
    else if (cp < 0x10000) n += 3;
    else n += 4;
  }
  return n;
}

/** 按码点截断并加省略号；**结果总长（含省略号）不超过 max** */
export function truncateCodepoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 证据条目 → `[M#] 内容` 一行 */
export function renderEvidenceLine(entry: { m_id: number; content: string }): string {
  return `[M${entry.m_id}] ${truncateCodepoints(oneLine(entry.content), MAX_ITEM_CODEPOINTS)}`;
}

export interface RenderOptions {
  /** 工程 id 前 8 位；null = 没有工程身份（unknown 档，不显示工程标签） */
  projectId?: string | null;
  maxBytes?: number;
  maxItems?: number;
  /** 追加【记忆反馈】提示（有证据时默认 true） */
  feedbackHint?: boolean;
}

export interface RenderedMail {
  text: string;
  evidence: HookEvidence[];
  /** 因字节预算被丢掉的条数（进 trace，不进注入文本） */
  dropped: number;
  bytes: number;
}

/**
 * 渲染整块注入文本。返回的 `text` 已含起止标记，入口可以据此判断"这条 system 里
 * 是不是已经有我们的块"，避免同一请求被追加两次。
 */
export function renderHookMail(
  entries: readonly Pick<EvidenceEntry, 'm_id' | 'content' | 'confidence'>[],
  options: RenderOptions = {},
): RenderedMail {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INJECT_BYTES;
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const projectId = options.projectId ?? null;
  const header =
    projectId === null
      ? '## 记忆台账（moshi）'
      : `## 记忆台账（moshi · 工程 ${projectId.slice(0, 8)}）`;

  const kept: HookEvidence[] = [];
  const lines: string[] = [];
  let dropped = 0;
  let bytes = utf8Bytes(HOOK_MAIL_START) + utf8Bytes(HOOK_MAIL_END);
  for (const entry of entries.slice(0, maxItems)) {
    const line = renderEvidenceLine(entry);
    const cost = utf8Bytes(line) + 1;
    // 整条进不去就停：继续塞短的可能打乱[证据优先级]，且预算已经说明装不下
    if (bytes + cost > maxBytes) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    kept.push({ m_id: entry.m_id, content: truncateCodepoints(oneLine(entry.content), MAX_ITEM_CODEPOINTS), confidence: entry.confidence });
    bytes += cost;
  }

  if (kept.length === 0) {
    return { text: '', evidence: [], dropped: entries.length, bytes: 0 };
  }

  const feedback =
    options.feedbackHint === false
      ? ''
      : '\n需要更新时在同一条回复末尾追加【记忆反馈】段（格式见 moshi MCP 工具说明）。';
  const body = [
    HOOK_MAIL_START,
    header,
    '',
    ...lines,
    feedback,
    HOOK_MAIL_END,
  ]
    .filter((l) => l !== '')
    .join('\n');

  // 提示句本身也可能把总长顶过预算：顶过就退一步只要正文（提示可以不要，记忆不能超）
  if (utf8Bytes(body) > maxBytes) {
    const slim = [HOOK_MAIL_START, header, '', ...lines, HOOK_MAIL_END].join('\n');
    return { text: slim, evidence: kept, dropped, bytes: utf8Bytes(slim) };
  }
  return { text: body, evidence: kept, dropped, bytes: utf8Bytes(body) };
}

/**
 * 从入口自报的 `injectModes` 里挑一种（**顺序即优先级**）。
 * 挑不出来就按 `system-append` 兜底——入口已经说了它支持注入。
 */
export function chooseInjectMode(injectModes: readonly string[]): HookInjectMode {
  return injectModes.find((mode) => mode === 'user-append') === 'user-append'
    ? 'user-append'
    : 'system-append';
}

/**
 * 追加模式下的 sys 内容计算：已有块就**不重复追加**。
 * 返回 null = 已经注过（这一轮什么都不做）。
 */
export function appendHookMail(existing: string, mail: string): string | null {
  if (existing.includes(HOOK_MAIL_START)) return null;
  if (existing.trim() === '') return mail;
  return `${existing}\n\n${mail}`;
}
