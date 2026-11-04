/**
 * 归档文件的"只删文件、不删目录"安全删除（详设 §9.7 / P2-19A-12）。
 *
 * 隐私 purge 只允许删除 `archive_dir` 下的两类路径：
 * - `topics/**\/*.md`
 * - `_history/**`（任意普通文件）
 *
 * 硬约束：
 * 1. 只 unlink 普通文件（`lstat` 判定），**绝不 rm -r、绝不删目录本身**；
 * 2. 拒绝符号链接（避免借链接删到归档目录之外）；
 * 3. 路径 resolve 后必须仍在 `archive_dir` 内，且命中上述两类白名单。
 *
 * 目录遍历只读；删除动作由 `removeArchiveFile` 单独完成，便于 dry_run 先枚举。
 */
import { existsSync, lstatSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { MoshiError } from '../../domain/errors.js';

const TOPICS_DIR = 'topics';
const HISTORY_DIR = '_history';
const MD_SUFFIX = '.md';

/** 路径是否命中归档删除白名单（只做字面判定，不碰文件系统）。 */
export function isArchiveWhitelistPath(file: string, archiveDir: string): boolean {
  const root = path.resolve(archiveDir);
  const resolved = path.resolve(file);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  const head = parts[0];
  if (head === TOPICS_DIR) {
    // topics 下只允许 .md（含 .proposed.md）；其它资源文件不删
    return resolved.endsWith(MD_SUFFIX) && parts.length >= 2;
  }
  if (head === HISTORY_DIR) {
    // _history 下允许任意普通文件（历史快照/提案备份），但至少一层
    return parts.length >= 2;
  }
  return false;
}

function walkFiles(dir: string, out: string[], accept: (file: string) => boolean): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在 / 不可读：视为没有文件
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out, accept);
    } else if (entry.isFile() && accept(full)) {
      out.push(full);
    }
    // 符号链接等一律跳过：不跟随、不删除
  }
}

/** 枚举归档目录中允许被 purge 删除的文件（默认只看 topics/ 与 _history/）。 */
export function collectArchiveFiles(archiveDir: string): string[] {
  const out: string[] = [];
  const topicsDir = path.join(archiveDir, TOPICS_DIR);
  if (existsSync(topicsDir)) {
    walkFiles(topicsDir, out, (file) => file.endsWith(MD_SUFFIX));
  }
  const historyDir = path.join(archiveDir, HISTORY_DIR);
  if (existsSync(historyDir)) {
    walkFiles(historyDir, out, () => true);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 归档文件总字节数（用于隐私总览；目录缺失返回 0）。 */
export function archiveBytes(files: readonly string[]): number {
  let total = 0;
  for (const file of files) {
    try {
      const st = statSync(file);
      if (st.isFile()) total += st.size;
    } catch {
      // 并发删除/权限变化：跳过
    }
  }
  return total;
}

/**
 * 删除单个归档文件。返回是否真的删除了（文件已不存在 → false）。
 * 目录、符号链接、白名单外路径一律抛 `E_ACCESS`，调用方必须中止。
 */
export function removeArchiveFile(file: string, archiveDir: string): boolean {
  if (!isArchiveWhitelistPath(file, archiveDir)) {
    throw new MoshiError('E_ACCESS', `拒绝删除归档白名单之外的路径：${file}`, { file });
  }
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return false; // ENOENT：已经不存在，幂等
  }
  if (st.isSymbolicLink()) {
    throw new MoshiError('E_ACCESS', `拒绝删除符号链接：${file}`, { file });
  }
  if (!st.isFile()) {
    throw new MoshiError('E_ACCESS', `拒绝删除非普通文件（目录？）：${file}`, { file });
  }
  unlinkSync(file);
  return true;
}
