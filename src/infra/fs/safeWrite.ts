/**
 * 写盘白名单（概设 §1.5 纪律 3 / 详设 §12.4）。
 *
 * 铁律：目录写操作统一走本模块，白名单（data_dir 与用户配置的 archive_dir）外直接抛
 * E_ACCESS。`core` 与 `app` 层**不得**直接 import 'node:fs' 的写类 API（`tools/check-writes.ts`
 * AST 扫描拦截），只能经由这里。
 *
 * 三种写面都要覆盖（台账 P0-20 坑）：writeFile / appendFile / createWriteStream，漏一种就白做。
 * 目录创建同样校验——mkdir 到白名单外（例如误建到工作区）也是外置系统污染宿主。
 */
import { appendFileSync, closeSync, createWriteStream, mkdirSync, openSync, unlinkSync, writeSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { MoshiError } from '../../domain/errors.js';
import { writeFileAtomic } from './atomic.js';

export type WriteRoots = readonly string[];

/** 路径必须落在某一白名单根下（或就是根本身），否则抛 E_ACCESS */
export function assertWritablePath(file: string, roots: WriteRoots): void {
  const abs = path.resolve(file);
  for (const root of roots) {
    const r = path.resolve(root);
    if (abs === r || abs.startsWith(r + path.sep)) return;
  }
  throw new MoshiError('E_ACCESS', `写盘白名单外：${file}`, { file, roots: [...roots] });
}

/** mkdirSync 带白名单校验；不建父目录（root 本身由调用方保证存在或递归创建到 root 内） */
export function safeEnsureDir(dir: string, roots: WriteRoots): void {
  assertWritablePath(dir, roots);
  mkdirSync(dir, { recursive: true });
}

/** writeFileSync 带白名单校验；自动建父目录 */
export function safeWriteFile(file: string, data: string, roots: WriteRoots): void {
  assertWritablePath(file, roots);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, data);
}

/** appendFileSync 带白名单校验；自动建父目录 */
export function safeAppendFile(file: string, data: string, roots: WriteRoots): void {
  assertWritablePath(file, roots);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, data, 'utf8');
}

/** createWriteStream 带白名单校验；自动建父目录。flags 默认 'a'（与日志用法一致） */
export function safeCreateWriteStream(
  file: string,
  roots: WriteRoots,
  flags: string = 'a',
): WriteStream {
  assertWritablePath(file, roots);
  mkdirSync(path.dirname(file), { recursive: true });
  return createWriteStream(file, { flags });
}

/**
 * 独占创建文件（`wx` 语义，单实例锁用）。已存在返回 false，不覆盖。
 * EEXIST 之外的错误照抛。内容用 writeSync 一次写入——锁文件内容极小，不会跨块。
 */
export function safeCreateExclusive(file: string, content: string, roots: WriteRoots): boolean {
  assertWritablePath(file, roots);
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** 删除文件带白名单校验；不存在即视为已达成（与 unlinkSync 忽略 ENOENT 一致） */
export function safeRemoveFile(file: string, roots: WriteRoots): void {
  assertWritablePath(file, roots);
  try {
    unlinkSync(file);
  } catch {
    // 不存在即已达成目的
  }
}
