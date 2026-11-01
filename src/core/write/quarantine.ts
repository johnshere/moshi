/**
 * 隔离区（详设 §5.9）。
 *
 * 隔离区不是"垃圾桶"，是**写入通路的第四种出口**：
 *
 * ```
 * 解析 → 脱敏 → 筛（本文件） ─┬─ accept ─→ 消解 → 身份 → 冲突 → 落库
 *                            └─ reject ─→ quarantine（保留原 payload，UI 可见可批）
 * ```
 *
 * 为什么必须先筛再消解：`unserializable` 的取值连 `canonicalJson` 都过不去，
 * `value_hash` 算不出来，身份键就无从谈起——放到 `upsert` 里再判断，错误会以
 * "E_INPUT 不可序列化"的形式冒到最外层，调用方还以为是自己的 bug。
 *
 * 五个判据里只有 `mutex_storm` 需要查库（要 `canonical_key`），所以它单独一个函数：
 * 那时实体已经消解完，身份键才算得出来。
 */
import type { QuarantineReason } from '../../domain/enums.js';
import { canonicalJson } from '../../domain/hash.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as quarantineRepo from '../../infra/sqlite/quarantineRepo.js';

export interface QuarantineOptions {
  /** `confidence < minConfidence` → `low_confidence` */
  minConfidence: number;
  /** `content` 字节上限；超了按"前两句 + …"截断 */
  maxContentBytes: number;
  /** 控制字符占比上限（0–1） */
  controlCharRatio: number;
  /** 窗口内同一身份键的不同取值数上限 */
  stormThreshold: number;
  /** storm 统计窗口 */
  stormWindowMs: number;
}

/** 与 `config.toml [ingest]` 的默认值一致；app 层从配置构造，core 只认这个形状 */
export const DEFAULT_QUARANTINE: QuarantineOptions = {
  minConfidence: 0.25,
  maxContentBytes: 2048,
  controlCharRatio: 0.05,
  stormThreshold: 50,
  stormWindowMs: 24 * 60 * 60 * 1000,
};

export interface ScreenInput {
  content: string;
  value: unknown;
  confidence: number;
}

export interface ScreenOutput {
  accepted: boolean;
  reason: QuarantineReason | null;
  /** 已截断的 content（accepted 时即最终要落库的文本） */
  content: string;
  truncated: boolean;
}

// ---------------------------------------------------------------- 截断

/** 句末：中英文句号/问号/叹号/分号/换行；英文句号只在后面是空白或结尾时才算 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    let cut = ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n';
    if (!cut && ch === '.') {
      const next = text[i + 1];
      cut = next === undefined || /\s/.test(next);
    }
    if (cut) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.length > 0);
}

/**
 * `content` 截断（详设 §5.3）：超 2 KB 只保留前两句 + `…`。
 *
 * 截断策略故意不是"硬切 2048 字节"：硬切会把一句话从中间劈开，
 * 而 `content` 是给人看的一句话要点，半句话比没有更糟。
 *
 * `overflow` 是"截断后仍超"——只有一种情况：整段文字没有句末标点，
 * 第一句就是全文。这时保留内容已无意义，交回调用方进隔离区。
 */
export function clipContent(
  content: string,
  maxBytes: number = DEFAULT_QUARANTINE.maxContentBytes,
): { text: string; truncated: boolean; overflow: boolean } {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { text: content, truncated: false, overflow: false };
  }
  const sentences = splitSentences(content);
  const kept = sentences.slice(0, 2).join('').trimEnd();
  const text = `${kept}…`;
  return { text, truncated: true, overflow: Buffer.byteLength(text, 'utf8') > maxBytes };
}

// ---------------------------------------------------------------- 判据

/**
 * 控制字符占比。`\t` `\n` `\r` 不算——正常文本里它们合法。
 * 按**码点**计数而不是 UTF-16 长度，否则 emoji 会把分母撑大、把比例压低。
 */
export function controlCharRatio(text: string): number {
  const chars = [...text];
  if (chars.length === 0) return 0;
  let bad = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) bad += 1;
  }
  return bad / chars.length;
}

export function isSerializable(value: unknown): boolean {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入前筛一遍。判据顺序有讲究：**结构性错误优先报**。
 * 一条内容既是乱码又低置信，报 `binary_like` 才有诊断价值——
 * 报 `low_confidence` 会让人去调先验表，而真正的问题在解析器。
 */
export function screen(
  input: ScreenInput,
  opts: QuarantineOptions = DEFAULT_QUARANTINE,
): ScreenOutput {
  if (!isSerializable(input.value)) {
    return { accepted: false, reason: 'unserializable', content: input.content, truncated: false };
  }
  if (controlCharRatio(input.content) > opts.controlCharRatio) {
    return { accepted: false, reason: 'binary_like', content: input.content, truncated: false };
  }
  const clip = clipContent(input.content, opts.maxContentBytes);
  if (clip.overflow) {
    return { accepted: false, reason: 'too_long', content: clip.text, truncated: true };
  }
  if (input.confidence < opts.minConfidence) {
    return { accepted: false, reason: 'low_confidence', content: clip.text, truncated: clip.truncated };
  }
  return { accepted: true, reason: null, content: clip.text, truncated: clip.truncated };
}

/**
 * `mutex_storm`：同一身份键 24h 内出现 > N 个不同取值。
 * 这几乎总是"消解把两个不同实体并成了一个"或"谓词基数性登记错了"，必须人工看。
 */
export function detectStorm(
  db: Db,
  identity: { canonicalKey: string; scope: string },
  opts: QuarantineOptions = DEFAULT_QUARANTINE,
  now: number = Date.now(),
): boolean {
  const since = new Date(now - opts.stormWindowMs).toISOString();
  const n = quarantineRepo.countDistinctValuesSince(db, identity.canonicalKey, identity.scope, since);
  return n > opts.stormThreshold;
}

// ---------------------------------------------------------------- 落库

export interface QuarantinePayload {
  content: string;
  value: unknown;
  confidence: number;
  subject?: string;
  predicate?: string;
  scope?: string;
  sourceEpisode?: string | null;
  /** 触发时的补充信息：命中哪条规则、原文字节数、storm 计数等 */
  detail?: Record<string, unknown>;
}

/**
 * 隔离 payload 的序列化。
 *
 * 注意 `unserializable` 这一支：payload 里就放着那个序列化不了的值。
 * 所以这里必须有一个**不会抛**的兜底序列化，否则"因为不可序列化而隔离"
 * 会在写隔离区时再炸一次。
 */
export function safeJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    const seen = new WeakSet<object>();
    const out = JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'bigint') return `${String(val)}n`;
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'symbol') return String(val);
      if (typeof val === 'number' && !Number.isFinite(val)) return String(val);
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
    return out ?? 'null';
  }
}

export function enqueue(
  db: Db,
  reason: QuarantineReason,
  payload: QuarantinePayload,
  ts?: string,
): string {
  return quarantineRepo.insert(db, {
    payloadJson: safeJson({ reason, ...payload }),
    reason,
    ...(ts === undefined ? {} : { ts }),
  });
}

export function listOpen(db: Db, limit = 100): quarantineRepo.QuarantineRow[] {
  return quarantineRepo.listOpen(db, limit);
}

/** 人工批处理：`accepted` 的条目按原 payload 重新入图（由调用方重放），`dropped` 直接丢 */
export function resolve(
  db: Db,
  id: string,
  resolved: 'accepted' | 'dropped',
  ts?: string,
): void {
  quarantineRepo.markResolved(db, id, resolved, ts);
}

export function stats(db: Db): { open: number; byReason: Record<string, number> } {
  return { open: quarantineRepo.countOpen(db), byReason: quarantineRepo.countByReason(db) };
}
