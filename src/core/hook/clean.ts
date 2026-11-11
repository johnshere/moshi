/**
 * 钩子文本清洗（P0，用户 m03879「query 确实要清洗，这种元数据不应该进入」）。
 *
 * Magpie 钩子拿到的「最后一条 user 消息」并不总是用户写的话，宿主与代理会在同一
 * 条消息里塞进脚手架：
 *
 * - `<acp tokens="…">m00001</acp>`：ACP 代理给每条消息加的引用标记；
 * - `[Compressed conversation section] …`：上下文压缩摘要（整段都是模型写的过去式）；
 * - `Time sampled while preparing turn …` / `Browser time zone …`：运行时时间采样；
 * - `<system-reminder> … </system-reminder>`：宿主注入的提醒块；
 * - `[folded images: …]`：折叠媒体的占位串；
 * - `以下是这条会话的对话记录（JSON）：…请为它写一行标题。`：后台任务（起标题）的整段提示；
 * - `This is an efficiency nudge to compress early …` / `Compression Philosophy:`：压缩提醒。
 *
 * 这些内容进了检索就会污染 BM25（「Compressed」「conversation」「m03908」这类词没有
 * 语义价值），进了 episode 也会成为将来抽取的噪声。所以清洗要**同时**用在检索侧
 * （`service.recallForHook` 的 query）与写入侧（`capture.captureSignal` 的 episode 正文）。
 *
 * 清洗原则：只剥「确定是脚手架」的块，不做摘要、不改写用户措辞；剥完为空就返回空串，
 * 由调用方按「没有可检索/可落库的正文」处理（检索侧回 `empty_query`，写入侧不落库）。
 */

/** ACP 引用标记：标签 + 里面的 mNNNNN 引用号一起去掉 */
const ACP_TAG = /<acp\b[^>]*>[\s\S]*?<\/acp>/gi;
/** 宿主提醒块（技能目录、附加指令等） */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
/** 折叠图片占位（`[folded images: …]` / `[folded image: …]`，同一行内取到最后一个 `]`） */
const FOLDED_MEDIA = /\[folded images?:[^\n]*\]/gi;
/** 压缩段标题（可能不在行首：前面还有半句正文时要保留半句） */
const COMPRESSED_HEAD = '[Compressed conversation section]';
/** 运行时时间采样三连行 */
const HARNESS_LINE = /^(?:Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding step context)\b/;
/** 整条不是用户意图的宿主/代理提示（命中行首即整段判空） */
const INTERNAL_PROMPT = [
  /^以下是这条会话的对话记录[（(]JSON[)）]?\s*[：:]?/,
  /^This is an efficiency nudge to compress early/,
  /^Compression Philosophy:/,
  /^background job \S+ .*finished\b/,
];
/** 夹在正文里的整段噪声（只丢这一段，段落以空行分隔） */
const NOISE_PARAGRAPH = /^(?:Open objectives（仍有效）|【Open objectives】|TASK AS OF THIS BLOCK:)/;
/** 压缩段正文里可能出现的续行形态（列表 / 引用 / 表格 / 代码 / 小标题 / 箭头结论） */
const SECTION_CONTINUATION = /^(?:[-*+>|#`]|\d+\.\s|[【〔—→⇒·•◦]|\*\*|__)/;
/** 「至少还有一个可读字符」：纯标点/空白视为清洗后为空 */
const MEANINGFUL = /[\p{L}\p{N}]/u;

/** 压缩段正文/续行的判定（缩进不算，按 trim 后的形态看） */
function isSectionContinuation(line: string): boolean {
  const t = line.trim();
  return t !== '' && SECTION_CONTINUATION.test(t);
}

/** 从 start 起找第一条非空行（用于判断空行后面还是不是压缩段） */
function nextMeaningful(lines: readonly string[], start: number): string | null {
  for (let i = start; i < lines.length; i += 1) {
    const t = (lines[i] ?? '').trim();
    if (t !== '') return t;
  }
  return null;
}

/**
 * 剥掉宿主/代理脚手架，返回可检索、可落库的正文。
 * 只做减法：不改写、不摘要、不补全；全被剥光时返回空串。
 */
export function cleanHookText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  // 后台任务 / 压缩提醒：整段是宿主提示，不是用户意图，直接判空
  if (INTERNAL_PROMPT.some((re) => re.test(trimmed))) return '';

  const stripped = trimmed
    .replace(ACP_TAG, '')
    .replace(SYSTEM_REMINDER, '')
    .replace(FOLDED_MEDIA, '');

  const lines = stripped.split(/\r?\n/);
  const kept: string[] = [];
  let inSection = false;
  let inNoiseParagraph = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const t = line.trim();
    if (inNoiseParagraph) {
      if (t === '') inNoiseParagraph = false;
      continue;
    }
    if (NOISE_PARAGRAPH.test(t)) {
      inNoiseParagraph = true;
      continue;
    }
    const head = t.indexOf(COMPRESSED_HEAD);
    if (head >= 0) {
      // 压缩段标题可能跟在半句正文后面：半句保留，剩下的整段丢掉
      const prefix = t.slice(0, head).trim();
      if (prefix !== '') kept.push(prefix);
      inSection = true;
      continue;
    }
    if (inSection) {
      if (t === '') {
        const next = nextMeaningful(lines, i + 1);
        // 空行后还是压缩段的续行 → 说明这段摘要还没完，继续丢
        if (next !== null && isSectionContinuation(next)) continue;
        inSection = false;
        continue;
      }
      if (isSectionContinuation(line)) continue;
      inSection = false;
    }
    if (HARNESS_LINE.test(t)) continue;
    kept.push(line);
  }

  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return MEANINGFUL.test(text) ? text : '';
}
