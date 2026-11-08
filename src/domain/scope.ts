/**
 * 作用域（概设 §3.6.4，v1.1 启用；台账 V-01）。
 *
 * 三值设计里 `session:*` 本期不启用，只支持：
 *   - `global`：跨项目通用的事实（用户偏好、机器级观测）
 *   - `project:<规范化 cwd>`：工具回合发生在哪个目录就落哪个项目
 *
 * 为什么用可读路径而不是哈希：`fact.scope` 会直接进 UI 与筛选器；`canonical_key`
 * 本身已经是 `ck1:` 哈希，再哈希一层只会让人看不出这条事实属于哪个项目。
 * 规范化必须**幂等**：同一目录在 Windows 上大小写、斜杠写法不同，必须归成同一个
 * scope，否则同一份事实会被写成两个项目。
 */
import { MoshiError } from './errors.js';

export const GLOBAL_SCOPE = 'global';
export const PROJECT_SCOPE_PREFIX = 'project:';

/**
 * 规范化项目目录：分隔符统一 `/`、Windows 路径转小写、去尾斜杠。
 * 只做词法处理，不碰文件系统（cwd 可能已经不存在）。
 */
export function normalizeCwd(cwd: string): string {
  let s = cwd.trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s) || s.startsWith('//')) s = s.toLowerCase();
  // 根路径保留分隔符：`c:/` 去尾斜杠会变成 `c:`，`/` 会变成空串
  if (/^[a-z]:\/$/.test(s) || s === '/') return s;
  s = s.replace(/\/+$/, '');
  return s;
}

/** cwd → scope。没有 cwd 的回合（未知目录）一律落 global。 */
export function projectScopeOf(cwd: string | null | undefined): string {
  if (cwd === null || cwd === undefined) return GLOBAL_SCOPE;
  const normalized = normalizeCwd(cwd);
  return normalized === '' ? GLOBAL_SCOPE : `${PROJECT_SCOPE_PREFIX}${normalized}`;
}

/**
 * 把调用方给的 scope 归一。`project:` 后面的路径按同一规则规范化；
 * 非法值原样返回，交给 `assertScope` 报错（不要在这里静默改成 global）。
 */
export function normalizeScope(scope: string): string {
  if (!scope.startsWith(PROJECT_SCOPE_PREFIX)) return scope;
  const id = scope.slice(PROJECT_SCOPE_PREFIX.length);
  const normalized = normalizeCwd(id);
  return normalized === '' ? scope : `${PROJECT_SCOPE_PREFIX}${normalized}`;
}

export function isProjectScope(scope: string): boolean {
  return scope.startsWith(PROJECT_SCOPE_PREFIX) && scope.length > PROJECT_SCOPE_PREFIX.length;
}

/** 写入闸门：只允许 global 与 project:<非空>；`session:*` 等留给后续任务。 */
export function assertScope(scope: string): void {
  if (scope === GLOBAL_SCOPE) return;
  if (isProjectScope(scope) && !/[\u0000-\u001f]/.test(scope)) return;
  throw new MoshiError('E_INPUT', `非法 scope '${scope}'：只允许 global 或 project:<cwd>`, {
    scope,
  });
}

/**
 * 查询候选 scope（概设 §3.6.4「项目优先、全局兜底」）：
 * 查项目时同时看本项目与 global；查 global 时只看 global，不能反向泄漏项目事实。
 */
export function scopeCandidates(scope: string): string[] {
  return isProjectScope(scope) ? [scope, GLOBAL_SCOPE] : [scope];
}
