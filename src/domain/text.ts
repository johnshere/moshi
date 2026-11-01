/**
 * 文本度量（纯函数）。
 *
 * 放在 domain 而不是 app：`tools/lint-descriptions.ts` 也要用它，
 * 而构建期脚本不该为了估一个 token 数去 import 整个写入通路。
 */

/**
 * 粗估 token：中日韩字符按 1 字 1 token，其余按 4 字符 1 token。
 *
 * 故意**偏大**：概设 §1.5 的 200 token 上限是"不许超"的硬约束，
 * 估小了等于没约束；而 MCP 工具描述本身很短，多估一点没有代价。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
