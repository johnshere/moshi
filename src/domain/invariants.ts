/**
 * 不变量与白名单（详设 §3.3 / 概设 §5.2 红线）。
 *
 * `assertFeatureSafe` 是 K2 正交化在代码里的唯一防线：
 * **生命周期字段（强度、池、访问、归档、布局）永远不许进推理特征**。
 * 实现必须是白名单穷举——黑名单永远会漏，而漏一次就是"模型偷偷学了衰减"。
 */
import { MoshiError } from './errors.js';

/** 允许进特征的字段（白名单）。不在名单里的，一律不许进 */
export const FEATURE_FIELDS = [
  'embedding',
  'ftype',
  'confidence',
  'importance',
  'epistemic_status',
  'degree',
] as const;

/** 生命周期字段：出现在特征构造入参里即抛错 */
export const LIFECYCLE_FIELDS = [
  'strength',
  'pool',
  'access_count',
  'last_access_at',
  'archive_meta',
  'layout',
  'community_summary.derived_at',
] as const;

/** 叶子名匹配（任意深度命中即算） */
const FORBIDDEN_LEAVES = new Set<string>([
  'strength',
  'pool',
  'access_count',
  'last_access_at',
  'archive_meta',
  'layout',
]);

/** 需要按完整路径匹配的（同名叶子在别处可能是合法字段） */
const FORBIDDEN_PATHS = ['community_summary.derived_at'];

function leafOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * 先判路径再下钻：值为空对象/空数组时也必须命中，
 * 否则 `{archive_meta: {}}` 会从空对象里"走丢"。
 */
function checkPath(path: string, hits: string[]): void {
  if (path === '') return;
  const leaf = leafOf(path);
  if (FORBIDDEN_LEAVES.has(leaf)) {
    hits.push(path);
    return;
  }
  if (FORBIDDEN_PATHS.some((p) => path === p || path.endsWith(`.${p}`))) hits.push(path);
}

function walk(value: unknown, path: string, hits: string[]): void {
  checkPath(path, hits);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, hits));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    walk(v, path === '' ? k : `${path}.${k}`, hits);
  }
}

/**
 * 特征入参里出现生命周期字段即抛 `E_INPUT`。
 * 注意：**键名命中就报错，不看值**——值为 undefined 也算，否则传个空对象就绕过了。
 */
export function assertFeatureSafe(obj: unknown): void {
  const hits: string[] = [];
  walk(obj, '', hits);
  if (hits.length > 0) {
    throw new MoshiError(
      'E_INPUT',
      `生命周期字段不得进入推理特征：${hits.join(', ')}（概设 §5.2 红线）`,
      { fields: hits },
    );
  }
}

/** 白名单断言：特征对象里的键必须全部在 FEATURE_FIELDS 内 */
export function assertFeatureWhitelist(obj: Record<string, unknown>): void {
  const allowed = new Set<string>(FEATURE_FIELDS);
  const extra = Object.keys(obj).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    throw new MoshiError('E_INPUT', `特征字段不在白名单内：${extra.join(', ')}`, { fields: extra });
  }
}

export function assertProbability(name: string, v: number): number {
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new MoshiError('E_INPUT', `${name} 必须是 [0,1] 内的数，实际 ${String(v)}`, { name, value: v });
  }
  return v;
}

export function assertNonEmpty(name: string, v: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new MoshiError('E_INPUT', `${name} 不能为空`, { name });
  }
  return v;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
