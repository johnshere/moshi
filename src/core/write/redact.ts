/**
 * 脱敏（详设 §1.6）。
 *
 * 三条硬要求，缺一条就白做：
 *
 * 1. **顺序**：私钥块 → 具体 token → 通用赋值。反了会把私钥头部 `-----BEGIN ...` 先吃掉，
 *    块级正则再也匹配不上，剩下的 base64 就原样入库了。
 * 2. **幂等**：`harvest` 每批都会重跑脱敏（§5.10 第 2a 步），第二遍不能把
 *    `<REDACTED>` 再加工成别的东西。
 * 3. **哈希在脱敏之后算**：同一个秘密两次观测必须得到同一个 `value_hash`，
 *    否则"重复观测加成"永远不触发，同一个秘密会变成两条事实。
 *
 * 与文档的一处**有意偏差**：通用赋值的替换写的是 `$1=<REDACTED>`，这里保留原分隔符
 * 与引号（`{"password":"x"}` → `{"password":"<REDACTED>"}`）。文档写法会把
 * `"password":"x"` 变成 `"password=<REDACTED>`——值确实抹掉了，但 JSON 结构被打碎，
 * 下游 `raw_excerpt` 之类的字段就没法再解析。语义不变，只是不破坏语法。
 */
import type { RedactRuleId } from '../../domain/enums.js';

export interface RedactOptions {
  /** 总开关；默认开（§1.6「默认开启」） */
  enabled?: boolean;
  /** 内网 IP；默认关（§1.6 最后一行「可选，默认关」） */
  privateIp?: boolean;
  /** 自定义规则，跑在内置规则之后 */
  extraRules?: readonly RedactRule[];
}

export interface RedactRule {
  id: RedactRuleId | string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactionHit {
  rule: string;
  count: number;
}

export interface RedactResult {
  text: string;
  hits: RedactionHit[];
  changed: boolean;
}

export const REDACTED = {
  privateKey: '<REDACTED:PRIVATE_KEY>',
  apiKey: '<REDACTED:API_KEY>',
  githubToken: '<REDACTED:GITHUB_TOKEN>',
  awsKey: '<REDACTED:AWS_KEY>',
  generic: '<REDACTED>',
  bearer: 'Bearer <REDACTED>',
  user: '<USER>',
  privateIp: '<REDACTED:PRIVATE_IP>',
} as const;

/** 判断"这里已经抹过了"，供幂等守卫用 */
export function isRedacted(s: string): boolean {
  return s.startsWith('<REDACTED') || s === '<USER>' || s.startsWith('<USER>');
}

// ---- 1. 私钥块（跨行，必须最先跑） ----
// `[A-Z ]*` 兼容 RSA / EC / OPENSSH / ENCRYPTED / PGP ... BLOCK 等所有头部变体。
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY[A-Z ]*-----/g;
// 配对的没匹配上，说明块被截断（content 只留前两句时很常见）——从 BEGIN 抹到结尾。
// 宁可多抹一段正文，也不能漏一段私钥。
const PRIVATE_KEY_UNTERMINATED = /-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----[\s\S]*$/g;

// ---- 2. 具体 token ----
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
// 文档只写了 AKIA（长期凭证）；ASIA 是 STS 临时凭证，同一个坑，一起抹。
const AWS_KEY = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._-]{16,}/g;

// ---- 3. 带用户名的绝对路径 ----
const USER_PATH = /(\/Users\/|\/home\/|[A-Z]:\\Users\\)([^/\\\s"']+)/g;

// ---- 4. 通用赋值（放最后） ----
// `["']?` 是为了吃掉 JSON 风格的 `"password": "x"`——否则 attrs / raw_excerpt 里的
// 键值对整片漏掉，这是最容易忽略的一条。
const GENERIC_ASSIGN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key)\b(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

// ---- 5. 内网 IP（默认关） ----
const PRIVATE_IP =
  /\b(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/g;

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const head = value[0];
    if ((head === '"' || head === "'") && value[value.length - 1] === head) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function applyGenericAssign(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(
    GENERIC_ASSIGN,
    (match: string, key: string, sep: string, value: string): string => {
      // 幂等守卫：已经抹过的不再动（否则第二遍会算出 hits>0，日志失真）
      if (isRedacted(unquote(value))) return match;
      count += 1;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${key}${sep}${quote}${REDACTED.generic}${quote}`;
    },
  );
  return { text: out, count };
}

interface Step {
  id: string;
  run: (text: string) => { text: string; count: number };
}

function plainStep(id: string, pattern: RegExp, replacement: string): Step {
  return {
    id,
    run: (text) => ({ text: text.replace(pattern, replacement), count: countMatches(text, pattern) }),
  };
}

function buildSteps(opts: RedactOptions): Step[] {
  const steps: Step[] = [
    plainStep('private_key', PRIVATE_KEY_BLOCK, REDACTED.privateKey),
    plainStep('private_key_truncated', PRIVATE_KEY_UNTERMINATED, REDACTED.privateKey),
    plainStep('openai_key', OPENAI_KEY, REDACTED.apiKey),
    plainStep('github_token', GITHUB_TOKEN, REDACTED.githubToken),
    plainStep('aws_key', AWS_KEY, REDACTED.awsKey),
    plainStep('bearer', BEARER, REDACTED.bearer),
    plainStep('user_path', USER_PATH, `$1${REDACTED.user}`),
    { id: 'generic_assign', run: applyGenericAssign },
  ];
  if (opts.privateIp === true) {
    steps.push(plainStep('private_ip', PRIVATE_IP, REDACTED.privateIp));
  }
  for (const rule of opts.extraRules ?? []) {
    steps.push(plainStep(rule.id, rule.pattern, rule.replacement));
  }
  return steps;
}

/** 对一段文本执行全部规则。返回命中统计，供 harvest 日志用。 */
export function redactText(input: string, opts: RedactOptions = {}): RedactResult {
  if (opts.enabled === false || input === '') {
    return { text: input, hits: [], changed: false };
  }
  let text = input;
  const hits: RedactionHit[] = [];
  for (const step of buildSteps(opts)) {
    const r = step.run(text);
    text = r.text;
    if (r.count > 0) hits.push({ rule: step.id, count: r.count });
  }
  return { text, hits, changed: text !== input };
}

/**
 * 递归脱敏（`attrs` / `ext` 用）。
 *
 * 只处理字符串**值**，不动键名——键名是结构，改了就破坏了 `frozen` 三键约束。
 * 输入必须是 JSON 派生数据（无环）；`canonicalJson` 本来也不接受非纯对象。
 */
export function redactValue<T>(value: T, opts: RedactOptions = {}): T {
  if (opts.enabled === false) return value;
  return walk(value, opts) as T;
}

function walk(value: unknown, opts: RedactOptions): unknown {
  if (typeof value === 'string') return redactText(value, opts).text;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, opts));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, opts);
  }
  return out;
}

/** 多条 hits 合并（分批 harvest 汇总日志时用） */
export function mergeHits(a: readonly RedactionHit[], b: readonly RedactionHit[]): RedactionHit[] {
  const acc = new Map<string, number>();
  for (const h of [...a, ...b]) acc.set(h.rule, (acc.get(h.rule) ?? 0) + h.count);
  return [...acc.entries()].map(([rule, count]) => ({ rule, count }));
}
