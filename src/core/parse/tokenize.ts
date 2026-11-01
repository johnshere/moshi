/**
 * FTS5 预分词（详设 §6.4.2，D11）。
 *
 * 写入与查询必须用**同一个函数**——`fact_fts.tokens` 列存的就是本函数的输出，
 * 查询串也走本函数，保证两侧 token 口径一致。
 *
 * 不做词形还原：FTS5 的 `unicode61` 自带大小写折叠，这里只负责"把文本拆成
 * 查询/索引都认可的 token"。
 */

/** 停用词（详设 §6.4.2 清单）：CJK 单字 + 常见英文冠词/连词 */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及',
  'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or',
]);

/** CJK 统一表意文字区（含扩展）与假名；二元组只对连续 CJK 串做 */
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff]+/g;

/** 标识符分隔符：点、斜杠、下划线、连字符、空白 */
const SEGMENT_SPLIT = /[./_\- \t]+/;

/** 驼峰切分：`eaddrInuse` → `eaddr inuse`；`NodeVersion22` → `node version22` */
function splitCamel(s: string): string[] {
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter((p) => p.length > 0);
  return parts;
}

/**
 * 把文本转成 FTS token 串（空格分隔）。
 *
 * 顺序（与详设一致，不可调换）：
 * 1. 小写；
 * 2. 标识符切分：保留整串与各段（`pnpm-lock.yaml` → `pnpm-lock.yaml pnpm lock yaml`）；
 * 3. 驼峰切分：`EADDRINUSE` 之类整串兜底，驼峰段补充；
 * 4. CJK 连续串生成二元组（`本机开发环境` → `本机 机开 开发 发环 环境`），单字原样保留；
 * 5. 去停用词；
 * 6. 空格连接。
 */
export function tokenizeForFts(text: string): string {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return '';

  const out = new Set<string>();
  const hasCjk = /[\u3400-\u9fff\u3040-\u30ff]/.test(lower);
  const hasBlank = /\s/.test(lower);

  // 1) 整串保留：仅标识符形态（无空白、无 CJK）——CJK 句子的整串会污染 token 集
  if (!hasBlank && !hasCjk) out.add(lower);

  // 2) 标识符分段：纯 CJK 段跳过（交给第 4 步的二元组，避免整串重复）
  const segments = lower.split(SEGMENT_SPLIT).filter((s) => s.length > 0 && !/^[\u3400-\u9fff\u3040-\u30ff]+$/.test(s));
  for (const seg of segments) out.add(seg);

  // 3) 驼峰切分：必须在**原始大小写**上切（小写会吞掉驼峰边界），输出小写段
  const rawSegments = text
    .trim()
    .split(SEGMENT_SPLIT)
    .filter((s) => s.length > 0 && !/^[\u3400-\u9fff\u3040-\u30ff]+$/.test(s));
  for (const seg of rawSegments) {
    for (const part of splitCamel(seg)) out.add(part.toLowerCase());
  }

  // 4) CJK 二元组（连续 CJK 串，长度 ≥2）
  const runs = lower.match(CJK_RE) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      out.add(run.slice(i, i + 2));
    }
  }

  // 5) 去停用词
  for (const w of [...out]) {
    if (STOP_WORDS.has(w)) out.delete(w);
  }

  // 6) 空格连接（顺序稳定：Set 按插入序）
  return [...out].join(' ');
}

/** 把 token 串转成 BM25 的 OR 查询串（详设 §6.4.2：多 token 用 OR，避免长查询零命中） */
export function orQuery(tokens: string): string {
  return tokens.split(' ').filter((t) => t.length > 0).join(' OR ');
}
